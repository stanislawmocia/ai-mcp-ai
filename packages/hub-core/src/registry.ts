export interface NodeInfo {
  name: string;
  tailscaleIp: string;
  port: number;
  lastSeen: Date;
  health: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  status: 'online' | 'offline' | 'unreachable';
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

const OFFLINE_THRESHOLD = 90_000; // 90s (3 missed heartbeats)

export function createRegistry(): NodeRegistry {
  const nodes = new Map<string, NodeInfo>();

  // Periodic status check
  setInterval(() => {
    const now = Date.now();
    for (const node of nodes.values()) {
      const age = now - node.lastSeen.getTime();
      if (age > OFFLINE_THRESHOLD) {
        node.status = 'offline';
      }
    }
  }, 15_000).unref();

  return {
    registerOrUpdate(name, ip, port, health, capabilities) {
      nodes.set(name, {
        name,
        tailscaleIp: ip,
        port,
        lastSeen: new Date(),
        health,
        capabilities,
        status: 'online',
      });
    },

    getNode(name) {
      const node = nodes.get(name);
      if (!node) return undefined;
      // Refresh status on access
      const age = Date.now() - node.lastSeen.getTime();
      if (age > OFFLINE_THRESHOLD) {
        node.status = 'offline';
      }
      return node;
    },

    listNodes() {
      return Array.from(nodes.values());
    },
  };
}
