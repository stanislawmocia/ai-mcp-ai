import { z } from "zod";
import { messages, peers, state } from "../../db/index.js";
import { getPublicKeyBase64 } from "../../crypto/index.js";
import { getConfig } from "../../config/index.js";
import { isListenerActive, getListenerStats } from "./start_listener.js";

export const getStatusSchema = z.object({});

export async function getStatus(_args: z.infer<typeof getStatusSchema>): Promise<string> {
  const config = getConfig();

  const connectedPeers = peers.all().map((p) => ({
    alias: p.alias,
    ip: p.tailscale_ip,
    has_key: !!p.public_key,
    last_seen: p.last_seen,
    auto_wake: !!p.auto_wake,
    preferred_agent: p.preferred_agent,
  }));

  const listenerStats = getListenerStats();
  const unreadCount = messages.countUnread();

  let publicKey = "";
  try {
    publicKey = getPublicKeyBase64();
  } catch {
    publicKey = "(not initialized)";
  }

  return JSON.stringify(
    {
      alias: config.device.alias,
      http_port: config.device.http_port,
      public_key: publicKey,
      unread_count: unreadCount,
      listener_active: isListenerActive(),
      listener_stats: listenerStats,
      connected_peers: connectedPeers,
      config: {
        db_path: config.device.db_path,
        poll_interval_ms: config.listener.poll_interval_ms,
        agents_enabled: {
          claude: config.agents.claude.enabled,
          gemini: config.agents.gemini.enabled,
          custom: config.agents.custom.enabled,
        },
      },
    },
    null,
    2
  );
}
