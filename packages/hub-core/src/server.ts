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

  // ──── Agent Proxy ────

  // Helper: proxy request to node-agent
  async function proxyToNode(
    nodeName: string,
    path: string,
    method: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; data: unknown }> {
    const node = registry.getNode(nodeName);
    if (!node) {
      return { ok: false, status: 404, data: { error: `Node "${nodeName}" not found or offline` } };
    }

    const nodeUrl = `http://${node.tailscaleIp}:${node.port}${path}`;
    try {
      const res = await fetch(nodeUrl, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.token}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      return { ok: res.ok, status: res.status, data };
    } catch (error) {
      return { ok: false, status: 502, data: { error: `Failed to reach node at ${nodeUrl}`, details: (error as Error).message } };
    }
  }

  // Session-to-node mapping (tracks which node holds which agent session)
  const sessionNodeMap = new Map<string, string>();

  // Spawn agent on node
  fastify.post<{
    Body: {
      nodeName: string;
      tool: string;
      workdir: string;
      mode?: string;
      args?: string[];
      prompt?: string;
      systemPrompt?: string;
    };
  }>('/agents/spawn', async (request, reply) => {
    const { nodeName, ...agentOpts } = request.body;
    const result = await proxyToNode(nodeName, '/start-agent', 'POST', agentOpts);
    if (!result.ok) {
      reply.code(result.status).send(result.data);
      return;
    }
    // Track session → node mapping
    const data = result.data as { sessionId: string };
    sessionNodeMap.set(data.sessionId, nodeName);
    return result.data;
  });

  // Get agent status
  fastify.get<{ Params: { sessionId: string } }>('/agents/:sessionId', async (request, reply) => {
    const { sessionId } = request.params;
    const nodeName = sessionNodeMap.get(sessionId);
    if (!nodeName) {
      reply.code(404).send({ error: `Session "${sessionId}" not found in hub registry` });
      return;
    }
    const result = await proxyToNode(nodeName, `/agent/${sessionId}`, 'GET');
    if (!result.ok) {
      reply.code(result.status).send(result.data);
      return;
    }
    return { ...result.data as Record<string, unknown>, nodeName };
  });

  // Send message to agent
  fastify.post<{
    Params: { sessionId: string };
    Body: { message: string };
  }>('/agents/:sessionId/send', async (request, reply) => {
    const { sessionId } = request.params;
    const nodeName = sessionNodeMap.get(sessionId);
    if (!nodeName) {
      reply.code(404).send({ error: `Session "${sessionId}" not found in hub registry` });
      return;
    }
    const result = await proxyToNode(nodeName, `/agent/${sessionId}/send`, 'POST', request.body);
    if (!result.ok) {
      reply.code(result.status).send(result.data);
      return;
    }
    return result.data;
  });

  // Read agent output
  fastify.get<{
    Params: { sessionId: string };
    Querystring: { offset?: string; limit?: string };
  }>('/agents/:sessionId/read', async (request, reply) => {
    const { sessionId } = request.params;
    const nodeName = sessionNodeMap.get(sessionId);
    if (!nodeName) {
      reply.code(404).send({ error: `Session "${sessionId}" not found in hub registry` });
      return;
    }
    const qs = new URLSearchParams();
    if (request.query.offset) qs.set('offset', request.query.offset);
    if (request.query.limit) qs.set('limit', request.query.limit);
    const qsStr = qs.toString() ? `?${qs.toString()}` : '';
    const result = await proxyToNode(nodeName, `/agent/${sessionId}/read${qsStr}`, 'GET');
    if (!result.ok) {
      reply.code(result.status).send(result.data);
      return;
    }
    return { ...result.data as Record<string, unknown>, nodeName };
  });

  // Kill agent
  fastify.delete<{
    Params: { sessionId: string };
  }>('/agents/:sessionId', async (request, reply) => {
    const { sessionId } = request.params;
    const nodeName = sessionNodeMap.get(sessionId);
    if (!nodeName) {
      reply.code(404).send({ error: `Session "${sessionId}" not found in hub registry` });
      return;
    }
    const result = await proxyToNode(nodeName, `/agent/${sessionId}`, 'DELETE');
    if (!result.ok) {
      reply.code(result.status).send(result.data);
      return;
    }
    return result.data;
  });

  // List all agents across all nodes
  fastify.get('/agents', async () => {
    const allAgents: Array<Record<string, unknown>> = [];
    for (const node of registry.listNodes()) {
      try {
        const result = await proxyToNode(node.name, '/agents', 'GET');
        if (result.ok) {
          const agents = result.data as Array<Record<string, unknown>>;
          for (const agent of agents) {
            allAgents.push({ ...agent, nodeName: node.name });
          }
        }
      } catch {
        // Skip unreachable nodes
      }
    }
    return allAgents;
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
