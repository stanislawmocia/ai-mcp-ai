import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface TailscaleDevice {
  name: string;
  hostname: string;
  tailscale_ip: string;
  online: boolean;
  last_seen: string | null;
  is_self: boolean;
}

interface TailscaleStatusPeer {
  HostName: string;
  DNSName: string;
  TailscaleIPs: string[];
  Online: boolean;
  LastSeen: string;
  Active: boolean;
}

interface TailscaleStatus {
  Self: {
    HostName: string;
    DNSName: string;
    TailscaleIPs: string[];
    Online: boolean;
  };
  Peer: Record<string, TailscaleStatusPeer>;
}

/**
 * Try to get Tailscale socket path for the current OS.
 * Returns extra env/args for tailscale CLI commands.
 */
function getTailscaleSocketArg(): string {
  // If explicitly set via env, use that
  if (process.env.TAILSCALE_SOCKET) {
    return `--socket=${process.env.TAILSCALE_SOCKET}`;
  }
  return "";
}

function tailscaleCmd(subcommand: string): string {
  const socketArg = getTailscaleSocketArg();
  return `tailscale ${socketArg} ${subcommand}`.replace(/\s+/g, " ").trim();
}

export async function getTailscaleStatus(): Promise<TailscaleDevice[]> {
  try {
    const { stdout } = await execAsync(tailscaleCmd("status --json"));
    const status = JSON.parse(stdout) as TailscaleStatus;

    const devices: TailscaleDevice[] = [];

    // Add self
    const selfIp = status.Self.TailscaleIPs?.[0] ?? "";
    devices.push({
      name: status.Self.HostName,
      hostname: status.Self.DNSName?.replace(/\.$/, "") ?? status.Self.HostName,
      tailscale_ip: selfIp,
      online: true,
      last_seen: null,
      is_self: true,
    });

    // Add peers
    for (const peer of Object.values(status.Peer ?? {})) {
      const ip = peer.TailscaleIPs?.[0] ?? "";
      devices.push({
        name: peer.HostName,
        hostname: peer.DNSName?.replace(/\.$/, "") ?? peer.HostName,
        tailscale_ip: ip,
        online: peer.Online || peer.Active,
        last_seen: peer.LastSeen ?? null,
        is_self: false,
      });
    }

    return devices;
  } catch (err) {
    throw new Error(`Failed to get Tailscale status: ${err}`);
  }
}

export async function getMyTailscaleIp(): Promise<string> {
  // 1. Environment variable override (for Docker on macOS/Windows where
  //    the tailscale CLI inside the container can't reach the host daemon)
  if (process.env.TAILSCALE_IP) {
    const ip = process.env.TAILSCALE_IP.trim();
    if (ip) {
      console.error(`[tailscale] Using TAILSCALE_IP from env: ${ip}`);
      return ip;
    }
  }

  // 2. Try tailscale CLI
  try {
    const { stdout } = await execAsync(tailscaleCmd("ip --4"));
    const ip = stdout.trim();
    if (ip.startsWith("100.")) {
      return ip;
    }
    // Non-standard IP — warn but accept
    console.error(`[tailscale] Unexpected IP format: ${ip}, using anyway`);
    return ip;
  } catch {
    // Fallback: parse from status
    try {
      const devices = await getTailscaleStatus();
      const self = devices.find((d) => d.is_self);
      if (self?.tailscale_ip) {
        return self.tailscale_ip;
      }
    } catch {
      // ignore
    }
    throw new Error(
      "Could not determine Tailscale IP. Options:\n" +
      "  1. Set TAILSCALE_IP=100.x.x.x environment variable\n" +
      "  2. Mount Tailscale socket: -v /var/run/tailscale:/var/run/tailscale\n" +
      "  3. Ensure tailscale is running: tailscale up"
    );
  }
}

export function isTailscaleIp(ip: string): boolean {
  return ip.startsWith("100.");
}

export async function resolveDeviceIp(
  aliasOrIp: string,
  peers: Record<string, { tailscale_ip: string }>
): Promise<string> {
  // If it's already an IP
  if (/^\d+\.\d+\.\d+\.\d+$/.test(aliasOrIp)) {
    return aliasOrIp;
  }

  // Look up by alias in config peers
  if (peers[aliasOrIp]) {
    return peers[aliasOrIp].tailscale_ip;
  }

  // Try Tailscale status
  try {
    const devices = await getTailscaleStatus();
    const device = devices.find(
      (d) =>
        d.name === aliasOrIp ||
        d.hostname === aliasOrIp ||
        d.name.toLowerCase() === aliasOrIp.toLowerCase()
    );
    if (device) {
      return device.tailscale_ip;
    }
  } catch {
    // ignore
  }

  throw new Error(
    `Cannot resolve device "${aliasOrIp}" to a Tailscale IP. ` +
    `Add it to config.json peers or check tailscale status.`
  );
}
