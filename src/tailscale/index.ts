import { execSync, exec } from "child_process";
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

export async function getTailscaleStatus(): Promise<TailscaleDevice[]> {
  try {
    const { stdout } = await execAsync("tailscale status --json");
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
  try {
    const { stdout } = await execAsync("tailscale ip --4");
    const ip = stdout.trim();
    if (!ip.startsWith("100.")) {
      throw new Error(`Unexpected Tailscale IP format: ${ip}`);
    }
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
      "Could not determine Tailscale IP. Is tailscale running? Try: tailscale up"
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
