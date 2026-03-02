import { z } from "zod";
import { wakeDevice as wakeDeviceImpl } from "../../wake/index.js";
import { getConfig } from "../../config/index.js";
import { peers } from "../../db/index.js";
import { resolveDeviceIp } from "../../tailscale/index.js";

export const wakeDeviceSchema = z.object({
  device: z.string().describe("Device alias or Tailscale IP"),
  method: z
    .enum(["ssh", "wol", "auto"])
    .optional()
    .default("auto")
    .describe("Wake method: ssh, wol, or auto"),
  start_agent: z
    .boolean()
    .optional()
    .default(true)
    .describe("Start AI agent after waking"),
  agent: z
    .enum(["claude", "gemini", "custom"])
    .optional()
    .default("claude")
    .describe("Which AI agent to start"),
});

export async function wakeDevice(args: z.infer<typeof wakeDeviceSchema>): Promise<string> {
  const config = getConfig();
  const { device, method, start_agent, agent } = args;

  const ip = await resolveDeviceIp(device, config.peers);

  const peer =
    peers.findByAlias(device) ??
    peers.findByIp(ip) ??
    config.peers[device];

  const macAddress = peer?.mac_address || "";
  const sshUser = peer?.ssh_user || config.device.ssh_user || "";
  const agentType = (agent ?? peer?.preferred_agent ?? "claude") as "claude" | "gemini" | "custom";

  if (!sshUser && (method === "ssh" || method === "auto")) {
    return JSON.stringify({
      woken: false,
      error:
        `No SSH user configured for device "${device}". ` +
        `Set device.ssh_user in config.json or peer.ssh_user for this device.`,
    });
  }

  const result = await wakeDeviceImpl({
    ip,
    alias: device,
    macAddress: macAddress || undefined,
    method: method ?? "auto",
    startAgent: start_agent ?? true,
    agentType,
    sshUser,
  });

  return JSON.stringify(result);
}
