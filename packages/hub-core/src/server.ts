import Fastify from 'fastify';
import fs from 'node:fs';
import type { Database } from 'bun:sqlite';
import { initDb } from './db.js';
import { createRegistry } from './registry.js';
import { createBroker } from './broker.js';
import { createContextStore } from './context.js';
import { registerRateLimit } from './rate-limit.js';
import { registerNodeRoutes } from './routes/nodes.js';
import { registerExecRoutes } from './routes/exec.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerContextRoutes } from './routes/context.js';

// ──── Configuration ────

export interface HubConfig {
  port: number;
  token: string;
  dbPath: string;
  bindHost?: string;
  tlsCert?: string;
  tlsKey?: string;
}

// ──── Session Store ────

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
    updateStatus: db.prepare(
      `UPDATE agent_sessions SET status = ?, updated_at = datetime('now') WHERE session_id = ?`,
    ),
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

// ──── Helpers ────

function extractIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** Constant-time comparison to prevent timing attacks */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ──── Server ────

export async function startHubCore(config: HubConfig) {
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

  // Middleware: rate limiting → security headers → auth
  registerRateLimit(fastify);

  fastify.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', 'no-store');
  });

  fastify.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
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

  // Routes
  registerNodeRoutes(fastify, registry, extractIp);
  registerExecRoutes(fastify, registry, config.token);
  registerAgentRoutes(fastify, registry, sessionStore, config.token);
  registerTaskRoutes(fastify, broker);
  registerContextRoutes(fastify, contextStore);

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

// ──── Direct run ────

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
