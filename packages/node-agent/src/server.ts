import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { execHandler } from './executor.js';
import { getHealthInfo, getCapabilities, setAgentProvider } from './monitor.js';
import { startHeartbeat } from './heartbeat.js';
import { createAgentManager, type AgentMode } from './agents.js';

export interface NodeAgentConfig {
  name: string;
  port: number;
  hubUrl: string;
  token: string;
  bindHost?: string;
  tlsCert?: string;
  tlsKey?: string;
}

// ──── Rate Limiting ────
interface RateLimitEntry { count: number; resetAt: number; }

function createRateLimiter() {
  const buckets = new Map<string, RateLimitEntry>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (now >= entry.resetAt) buckets.delete(key);
    }
  }, 5 * 60_000).unref();

  return function check(ip: string, path: string, limit = 60): { allowed: boolean; retryAfter: number } {
    const now = Date.now();
    const key = `${ip}:${path}`;
    let entry = buckets.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + 60_000 };
      buckets.set(key, entry);
    }
    entry.count++;
    if (entry.count > limit) {
      return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { allowed: true, retryAfter: 0 };
  };
}

/** Constant-time string comparison */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Allowed tools for agent spawning
const ALLOWED_AGENT_TOOLS = new Set([
  'claude-code', 'claude', 'aider',
  'python', 'python3', 'node',
  'bash', 'sh',
]);

// Validate workdir for agent spawning
function validateAgentWorkdir(workdir: string): { ok: boolean; reason?: string } {
  if (!workdir || workdir.includes('..')) {
    return { ok: false, reason: `Invalid workdir: "${workdir}"` };
  }
  const resolved = path.resolve(workdir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { ok: false, reason: `Workdir does not exist: "${resolved}"` };
  }
  return { ok: true };
}

export async function startNodeAgent(config: NodeAgentConfig) {
  // TLS
  const httpsOpts = config.tlsCert && config.tlsKey ? {
    https: {
      cert: fs.readFileSync(config.tlsCert),
      key: fs.readFileSync(config.tlsKey),
    },
  } : {};

  const fastify = Fastify({ logger: true, ...httpsOpts });
  const agentManager = createAgentManager();
  const checkRate = createRateLimiter();

  setAgentProvider(() => agentManager.runningIds());

  // Security headers
  fastify.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', 'no-store');
  });

  // Rate limiting (before auth)
  fastify.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;

    const limit = request.url.startsWith('/exec') ? 20 :
                  request.url.startsWith('/start-agent') ? 10 : 60;
    const rl = checkRate(request.ip, request.url.split('?')[0], limit);
    if (!rl.allowed) {
      reply.header('Retry-After', rl.retryAfter);
      return reply.code(429).send({ error: 'Too Many Requests', retryAfter: rl.retryAfter });
    }
  });

  // Auth middleware — constant-time comparison
  fastify.addHook('onRequest', async (request, reply) => {
    const url = request.url;
    if (url === '/health') return;

    const auth = request.headers.authorization;
    const expected = `Bearer ${config.token}`;
    if (!auth || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // Health endpoint
  fastify.get('/health', async () => {
    return getHealthInfo(config.name);
  });

  // Capabilities endpoint
  fastify.get('/capabilities', async () => {
    return getCapabilities();
  });

  // Execute command
  fastify.post<{
    Body: { cmd: string; workdir?: string; timeout?: number };
  }>('/exec', async (request) => {
    const { cmd, workdir, timeout } = request.body;
    return execHandler(cmd, workdir, timeout);
  });

  // ──── Agent lifecycle ────

  // List all agents on this node
  fastify.get('/agents', async () => {
    return agentManager.list().map(s => ({
      id: s.id,
      tool: s.tool,
      mode: s.mode,
      status: s.status,
      pid: s.pid,
      exitCode: s.exitCode,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    }));
  });

  // Start agent — with tool validation and workdir checks
  fastify.post<{
    Body: {
      tool: string;
      workdir: string;
      mode?: AgentMode;
      args?: string[];
      prompt?: string;
      systemPrompt?: string;
      timeoutMs?: number;
    };
  }>('/start-agent', async (request, reply) => {
    const { tool, workdir, mode, args, prompt, systemPrompt, timeoutMs } = request.body;

    // Validate tool name
    if (!ALLOWED_AGENT_TOOLS.has(tool)) {
      reply.code(400).send({
        error: `Tool "${tool}" is not allowed. Allowed: ${[...ALLOWED_AGENT_TOOLS].join(', ')}`,
      });
      return;
    }

    // Validate workdir
    const wdCheck = validateAgentWorkdir(workdir);
    if (!wdCheck.ok) {
      reply.code(400).send({ error: wdCheck.reason });
      return;
    }

    // Check if tool is available on this node
    const caps = getCapabilities();
    const toolName = tool === 'claude-code' ? 'claude' : tool;
    const knownTools = ['claude', 'aider', 'python3', 'node'];
    if (knownTools.includes(toolName) && !caps.tools.includes(toolName)) {
      reply.code(400).send({
        error: `Tool "${tool}" is not available on this node`,
        availableTools: caps.tools,
      });
      return;
    }

    // Limit concurrent agents
    const runningCount = agentManager.runningIds().length;
    if (runningCount >= 5) {
      reply.code(429).send({
        error: `Too many running agents (${runningCount}/5). Kill some first.`,
      });
      return;
    }

    const session = agentManager.start({
      tool,
      mode: mode ?? 'oneshot',
      workdir,
      args,
      prompt,
      systemPrompt,
      timeoutMs,
    });

    return {
      sessionId: session.id,
      pid: session.pid,
      status: session.status,
      mode: session.mode,
      tool: session.tool,
      timeoutMs: session.timeoutMs,
    };
  });

  // Get agent status
  fastify.get<{ Params: { id: string } }>('/agent/:id', async (request, reply) => {
    const session = agentManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: 'Agent session not found' });
      return;
    }
    return {
      id: session.id,
      tool: session.tool,
      mode: session.mode,
      status: session.status,
      pid: session.pid,
      exitCode: session.exitCode,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      lastLines: session.ringBuffer.slice(-10),
    };
  });

  // Send message to agent stdin
  fastify.post<{
    Params: { id: string };
    Body: { message: string };
  }>('/agent/:id/send', async (request, reply) => {
    const result = agentManager.send(request.params.id, request.body.message);
    if (!result.ok) {
      reply.code(400).send(result);
      return;
    }
    return result;
  });

  // Read agent output (ring buffer)
  fastify.get<{
    Params: { id: string };
    Querystring: { offset?: string; limit?: string };
  }>('/agent/:id/read', async (request, reply) => {
    const offset = request.query.offset ? parseInt(request.query.offset, 10) : undefined;
    const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
    const result = agentManager.read(request.params.id, { offset, limit });
    if (!result) {
      reply.code(404).send({ error: 'Agent session not found' });
      return;
    }
    return result;
  });

  // Kill agent
  fastify.delete<{ Params: { id: string } }>('/agent/:id', async (request, reply) => {
    const result = agentManager.kill(request.params.id);
    if (!result.ok) {
      reply.code(400).send(result);
      return;
    }
    return result;
  });

  // Start server
  const host = config.bindHost ?? '0.0.0.0';
  const proto = config.tlsCert ? 'https' : 'http';
  await fastify.listen({ port: config.port, host });
  console.log(`[meshmind-node] "${config.name}" listening on ${proto}://${host}:${config.port}`);

  if (!config.tlsCert) {
    console.warn('[meshmind-node] WARNING: TLS not configured — use TLS_CERT/TLS_KEY for encrypted communication');
  }

  // Start heartbeat to hub
  startHeartbeat(config);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[meshmind-node] Shutting down...');
    for (const session of agentManager.list()) {
      if (session.status === 'running') {
        agentManager.kill(session.id);
      }
    }
    await fastify.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return fastify;
}
