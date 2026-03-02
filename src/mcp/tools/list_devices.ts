import { z } from "zod";
import { getTailscaleStatus } from "../../tailscale/index.js";
import { peers } from "../../db/index.js";
import { getConfig } from "../../config/index.js";

export const listDevicesSchema = z.object({});

export async function listDevices(_args: z.infer<typeof listDevicesSchema>): Promise<string> {
  const config = getConfig();
  const devices = await getTailscaleStatus();
  const configuredPeers = peers.all();
  const configuredAliases = new Set([
    ...Object.keys(config.peers),
    ...configuredPeers.map((p) => p.alias),
  ]);

  const result = devices.map((d) => ({
    name: d.name,
    hostname: d.hostname,
    tailscale_ip: d.tailscale_ip,
    online: d.online,
    last_seen: d.last_seen,
    is_self: d.is_self,
    configured: d.is_self || configuredAliases.has(d.name) || configuredAliases.has(d.hostname),
  }));

  const selfDevice = result.find((d) => d.is_self);
  const peers_list = result.filter((d) => !d.is_self);
  const onlineCount = peers_list.filter((d) => d.online).length;

  return JSON.stringify(
    {
      self: selfDevice,
      peers: peers_list,
      summary: `${peers_list.length} peers found, ${onlineCount} online`,
    },
    null,
    2
  );
}
