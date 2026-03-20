import Fastify from 'fastify';
import fs from 'node:fs';
import type { Database } from 'bun:sqlite';
import { initDb } from './db.js';
import { createRegistry } from './registry.js';
import { createBroker } from './broker.js';
import { createContextStore } from './context.js';
import { registerRateLimit } from './rate-limit.js';

export interface HubConfig {
  port: number;
  token: string;
  dbPath: string;
  bindHost?: string;
  tlsCert?: string;
  tlsKey?: string;
}

// ──── Session-to-Node SQLite store ────

function createSessionStore(db: Database) {
  const stmts = {
    upsert: db.prepare(`
      INSERT INTO agent_sessions (session_id, node_name, tool, mode, status)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        status = excluded.status,
        updated_at = datetime('now')
    `),
    getNode: db.prepare('SELECT node_name FROM agent_sessions WHERE session_id = ?'),
    updateStatus: db.prepare(`UPDATE agent_sessions SET status = ?, updated_at = datetime('now') WHERE session_id = ?`),
    list: db.prepare('SELECT * FROM agent_sessions ORDER BY created_at DESC LIMIT 200'),
  };

  return {
    set(sessionId: string, nodeName: string, tool: string, mode: string, status = 'running') {
      stmts.upsert.run(sessionId, nodeName, tool, mode, status);
    },
    getNode(sessionId: string): string | null {
      const row = stmts.getNode.get(sessionId) as { node_name: string } | undefined;
      return row?.node_name ?? null;
    },
    updateStatus(sessionId: string, status: string) {
      stmts.updateStatus.run(status, sessionId);
    },
    list() {
      return stmts.list.all();
    },
  };
}

export async function startHubCore(config: HubConfig) {
  // TLS configuration
  const httpsOpts = config.tlsCert && config.tlsKey ? {
    https: {
      cert: fs.readFileSync(config.tlsCert),
      key: fs.readFileSync(config.tlsKey),
    },
  } : {};

  const fastify = Fastify({ logger: true, ...httpsOpts });
  const db = initDb(config.dbPath);
  const registry = createRegistry();
  const broker = createBroker(db);
  const contextStore = createContextStore(db);
  const sessionStore = createSessionStore(db);

  // Rate limiting (before auth so brute-force is blocked)
  registerRateLimit(fastify);

  // Security headers
  fastify.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '1; mode=block');
    reply.header('Cache-Control', 'no-store');
  });

  // Auth middleware — constant-time comparison to prevent timing attacks
  fastify.addHook('onRequest', async (request, reply) => {
    const url = request.url;
    if (url === '/health') return;

    const auth = request.headers.authorization;
    const expected = `Bearer ${config.token}`;
    if (!auth || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      return reply.code(401).send({ error: 'Unauthorized' });
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
      return reply.code(502).send({
        error: `Failed to reach node "${nodeName}" at ${nodeUrl}`,
        details: (error as Error).message,
      });
    }
  });

  // ──── Agent Proxy ────

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
      const hasBody = body !== undefined;
      const res = await fetch(nodeUrl, {
        method,
        headers: {
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          'Authorization': `Bearer ${config.token}`,
        },
        body: hasBody ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      return { ok: res.ok, status: res.status, data };
    } catch (error) {
      return { ok: false, status: 502, data: { error: `Failed to reach node at ${nodeUrl}`, details: (error as Error).message } };
    }
  }

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
      timeoutMs?: number;
    };
  }>('/agents/spawn', async (request, reply) => {
    const { nodeName, ...agentOpts } = request.body;
    const result = await proxyToNode(nodeName, '/start-agent', 'POST', agentOpts);
    if (!result.ok) {
      reply.code(result.status).send(result.data);
      return;
    }
    const data = result.data as { sessionId: string; tool: string; mode: string };
    // Persist session→node in SQLite
    sessionStore.set(data.sessionId, nodeName, data.tool, data.mode);
    return result.data;
  });

  // Get agent status
  fastify.get<{ Params: { sessionId: string } }>('/agents/:sessionId', async (request, reply) => {
    const { sessionId } = request.params;
    const nodeName = sessionStore.getNode(sessionId);
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
    const nodeName = sessionStore.getNode(sessionId);
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
    const nodeName = sessionStore.getNode(sessionId);
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
    const nodeName = sessionStore.getNode(sessionId);
    if (!nodeName) {
      reply.code(404).send({ error: `Session "${sessionId}" not found in hub registry` });
      return;
    }
    const result = await proxyToNode(nodeName, `/agent/${sessionId}`, 'DELETE');
    if (!result.ok) {
      reply.code(result.status).send(result.data);
      return;
    }
    sessionStore.updateStatus(sessionId, 'killed');
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
  const host = config.bindHost ?? '0.0.0.0';
  const proto = config.tlsCert ? 'https' : 'http';
  await fastify.listen({ port: config.port, host });
  console.log(`[meshmind-hub] Core listening on ${proto}://${host}:${config.port}`);

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
  if (ip.startsWith('::ffff:')) {
    return ip.slice(7);
  }
  return ip;
}

/** Constant-time string comparison to prevent timing attacks on token validation */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Direct run
const port = parseInt(process.env.HUB_PORT ?? '7433', 10);
const token = process.env.HUB_TOKEN ?? '';
const dbPath = process.env.DB_PATH ?? './data/hub.db';
const bindHost = process.env.BIND_HOST ?? '0.0.0.0';
const tlsCert = process.env.TLS_CERT || undefined;
const tlsKey = process.env.TLS_KEY || undefined;

if (!token) {
  console.error('Error: HUB_TOKEN environment variable is required');
  process.exit(1);
}

if (token.length < 32) {
  console.error('Error: HUB_TOKEN must be at least 32 characters (use: openssl rand -hex 32)');
  process.exit(1);
}

startHubCore({ port, token, dbPath, bindHost, tlsCert, tlsKey });
