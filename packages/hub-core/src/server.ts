import Fastify from 'fastify';
import { initDb } from './db.js';
import { createRegistry, type NodeRegistry } from './registry.js';
import { createBroker, type TaskBroker } from './broker.js';
import { createContextStore, type ContextStore } from './context.js';

export interface HubConfig {
  port: number;
  token: string;
  dbPath: string;
}

export async function startHubCore(config: HubConfig) {
  const fastify = Fastify({ logger: true });
  const db = initDb(config.dbPath);
  const registry = createRegistry();
  const broker = createBroker(db);
  const contextStore = createContextStore(db);

  // Auth middleware
  fastify.addHook('onRequest', async (request, reply) => {
    const url = request.url;
    if (url === '/health') return;

    const auth = request.headers.authorization;
    if (!auth || auth !== `Bearer ${config.token}`) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // Health
  fastify.get('/health', async () => ({
    service: 'meshmind-hub-core',
    status: 'ok',
    nodes: registry.listNodes().length,
    timestamp: new Date().toISOString(),
  }));

  // ──── Node Registry ────

  fastify.post<{
    Body: {
      name: string;
      port: number;
      health: Record<string, unknown>;
      capabilities: Record<string, unknown>;
    };
  }>('/nodes/heartbeat', async (request) => {
    const { name, port, health, capabilities } = request.body;
    const ip = extractIp(request.ip);
    registry.registerOrUpdate(name, ip, port, health, capabilities);
    return { ok: true };
  });

  fastify.get('/nodes', async () => {
    return registry.listNodes();
  });

  fastify.get<{ Params: { name: string } }>('/nodes/:name', async (request, reply) => {
    const node = registry.getNode(request.params.name);
    if (!node) {
      reply.code(404).send({ error: `Node "${request.params.name}" not found` });
      return;
    }
    return node;
  });

  // ──── Proxy exec to node-agent ────

  fastify.post<{
    Body: { nodeName: string; cmd: string; workdir?: string; timeout?: number };
  }>('/exec', async (request, reply) => {
    const { nodeName, cmd, workdir, timeout } = request.body;
    const node = registry.getNode(nodeName);
    if (!node) {
      reply.code(404).send({ error: `Node "${nodeName}" not found or offline` });
      return;
    }

    const nodeUrl = `http://${node.tailscaleIp}:${node.port}`;
    try {
      const res = await fetch(`${nodeUrl}/exec`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.token}`,
        },
        body: JSON.stringify({ cmd, workdir, timeout }),
      });
      return await res.json();
    } catch (error) {
      reply.code(502).send({
        error: `Failed to reach node "${nodeName}" at ${nodeUrl}`,
        details: (error as Error).message,
      });
    }
  });

  // ──── Task Broker ────

  fastify.post<{
    Body: { type: string; nodeName: string; payload: Record<string, unknown> };
  }>('/tasks', async (request) => {
    const { type, nodeName, payload } = request.body;
    return broker.createTask(type, nodeName, payload);
  });

  fastify.get<{ Params: { id: string } }>('/tasks/:id', async (request, reply) => {
    const task = broker.getTask(request.params.id);
    if (!task) {
      reply.code(404).send({ error: 'Task not found' });
      return;
    }
    return task;
  });

  fastify.get('/tasks', async () => {
    return broker.listTasks();
  });

  // ──── Context Store ────

  fastify.post<{
    Body: { key: string; data: unknown; sharedWith?: string[]; ttlHours?: number };
  }>('/context', async (request) => {
    const { key, data, sharedWith, ttlHours } = request.body;
    contextStore.set(key, data, sharedWith, ttlHours);
    return { ok: true, key };
  });

  fastify.get<{ Params: { key: string } }>('/context/:key', async (request, reply) => {
    const entry = contextStore.get(request.params.key);
    if (!entry) {
      reply.code(404).send({ error: `Context key "${request.params.key}" not found or expired` });
      return;
    }
    return entry;
  });

  fastify.delete<{ Params: { key: string } }>('/context/:key', async (request) => {
    contextStore.remove(request.params.key);
    return { ok: true };
  });

  // Start
  await fastify.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[meshmind-hub] Core listening on :${config.port}`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[meshmind-hub] Shutting down...');
    db.close();
    await fastify.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return { fastify, registry, broker, contextStore };
}

function extractIp(ip: string): string {
  // Handle IPv6-mapped IPv4 (::ffff:100.x.x.x)
  if (ip.startsWith('::ffff:')) {
    return ip.slice(7);
  }
  return ip;
}

// Direct run
const port = parseInt(process.env.HUB_PORT ?? '7433', 10);
const token = process.env.HUB_TOKEN ?? '';
const dbPath = process.env.DB_PATH ?? './data/hub.db';

if (!token) {
  console.error('Error: HUB_TOKEN environment variable is required');
  process.exit(1);
}

startHubCore({ port, token, dbPath });
