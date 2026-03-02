import { NodeSSH } from "node-ssh";
import wol from "wake_on_lan";
import { getConfig } from "../config/index.js";

export interface WakeResult {
  woken: boolean;
  method_used: "ssh" | "wol" | "none";
  agent_started: boolean;
  device: string;
  error?: string;
}

function sendMagicPacket(macAddress: string, broadcast: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wol.wake(macAddress, { address: broadcast }, (err: Error | undefined) => {
      if (err) {
        reject(new Error(`WoL failed: ${err.message}`));
      } else {
        resolve();
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function wakeDevice(opts: {
  ip: string;
  alias: string;
  macAddress?: string;
  method: "ssh" | "wol" | "auto";
  startAgent?: boolean;
  agentType?: "claude" | "gemini" | "custom";
  sshUser?: string;
}): Promise<WakeResult> {
  const config = getConfig();
  const { ip, alias, macAddress, method, startAgent = true, agentType = "claude" } = opts;

  const sshUser = opts.sshUser || config.device.ssh_user;
  const sshKeyPath = config.device.ssh_key_path;
  const waitSeconds = config.wake.ssh_startup_wait_seconds;

  let woken = false;
  let methodUsed: "ssh" | "wol" | "none" = "none";
  let agentStarted = false;

  // Wake-on-LAN
  const useWol =
    method === "wol" ||
    (method === "auto" && config.wake.wol_enabled && !!macAddress);

  if (useWol && macAddress) {
    try {
      console.error(`[wake] Sending WoL magic packet to ${macAddress} (broadcast: ${config.wake.wol_broadcast})`);
      await sendMagicPacket(macAddress, config.wake.wol_broadcast);
      woken = true;
      methodUsed = "wol";
      // Wait for machine to boot
      console.error(`[wake] WoL sent, waiting ${waitSeconds}s for boot...`);
      await sleep(waitSeconds * 1000);
    } catch (err) {
      console.error(`[wake] WoL failed: ${err}`);
    }
  }

  // SSH wake + agent start
  const useSsh =
    method === "ssh" ||
    (method === "auto" && config.wake.ssh_enabled);

  if (useSsh && sshUser) {
    const ssh = new NodeSSH();

    try {
      console.error(`[wake] SSH connecting to ${sshUser}@${ip}...`);
      await ssh.connect({
        host: ip,
        username: sshUser,
        privateKeyPath: sshKeyPath,
        readyTimeout: 15000,
      });

      woken = true;
      methodUsed = "ssh";

      if (startAgent) {
        const agentConfig = config.agents[agentType];
        if (!agentConfig?.enabled || !agentConfig?.command) {
          console.error(`[wake] Agent "${agentType}" is not enabled or has no command configured`);
        } else {
          const cmd = [agentConfig.command, ...agentConfig.args]
            .map((s) => `'${s.replace(/'/g, "'\"'\"'")}'`)
            .join(" ");

          // Build env exports
          const envExports = Object.entries(agentConfig.env ?? {})
            .map(([k, v]) => `export ${k}='${v}'`)
            .join("; ");

          const passphraseExport = process.env.MCP_COMM_KEY_PASSPHRASE
            ? `export MCP_COMM_KEY_PASSPHRASE='${process.env.MCP_COMM_KEY_PASSPHRASE}'`
            : "";

          const fullCmd = [
            envExports,
            passphraseExport,
            `nohup ${cmd} > /tmp/mcp-ai-comm-agent.log 2>&1 &`,
            `echo $!`,
          ]
            .filter(Boolean)
            .join("; ");

          console.error(`[wake] Starting ${agentType} agent in background...`);
          const result = await ssh.execCommand(fullCmd);

          if (result.code === 0 || result.stdout) {
            agentStarted = true;
            console.error(`[wake] Agent started with PID: ${result.stdout.trim()}`);
          } else {
            console.error(`[wake] Agent start may have failed: ${result.stderr}`);
          }

          // Wait for agent to be ready
          if (waitSeconds > 0) {
            console.error(`[wake] Waiting ${waitSeconds}s for agent to initialize...`);
            await sleep(waitSeconds * 1000);
          }
        }
      }

      ssh.dispose();
    } catch (err) {
      ssh.dispose();
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!woken) {
        return {
          woken: false,
          method_used: "none",
          agent_started: false,
          device: alias,
          error: `SSH connection failed: ${errMsg}`,
        };
      }
      console.error(`[wake] SSH error: ${errMsg}`);
    }
  }

  return {
    woken,
    method_used: methodUsed,
    agent_started: agentStarted,
    device: alias,
  };
}
