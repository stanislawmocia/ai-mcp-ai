const OFFLINE_THRESHOLD_MS = 90_000; // 90s (3 missed heartbeats)
const STATUS_CHECK_INTERVAL_MS = 15_000;

export interface NodeInfo {
  name: string;
  tailscaleIp: string;
  port: number;
  lastSeen: Date;
  health: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  status: 'online' | 'offline';
}

export interface NodeRegistry {
  registerOrUpdate(
    name: string,
    ip: string,
    port: number,
    health: Record<string, unknown>,
    capabilities: Record<string, unknown>,
  ): void;
  getNode(name: string): NodeInfo | undefined;
  listNodes(): NodeInfo[];
}

export function createRegistry(): NodeRegistry {
  const nodes = new Map<string, NodeInfo>();

  // Mark stale nodes as offline
  setInterval(() => {
    try {
      const now = Date.now();
      for (const node of nodes.values()) {
        if (now - node.lastSeen.getTime() > OFFLINE_THRESHOLD_MS) {
          node.status = 'offline';
        }
      }
    } catch (err) {
      console.error('[registry] Status check error:', err);
    }
  }, STATUS_CHECK_INTERVAL_MS).unref();

  return {
    registerOrUpdate(name, ip, port, health, capabilities) {
      nodes.set(name, {
        name, tailscaleIp: ip, port, lastSeen: new Date(),
        health, capabilities, status: 'online',
      });
    },

    getNode(name) {
      const node = nodes.get(name);
      if (!node) return undefined;
      if (Date.now() - node.lastSeen.getTime() > OFFLINE_THRESHOLD_MS) {
        node.status = 'offline';
      }
      return node;
    },

    listNodes: () => Array.from(nodes.values()),
  };
}
