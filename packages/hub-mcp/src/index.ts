import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import Fastify from 'fastify';
import fs from 'node:fs';
import { registerOAuth } from './oauth.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerExecutionTools } from './tools/execution.js';
import { registerAgentTools } from './tools/agents.js';
import { registerConnectivityTools } from './tools/connectivity.js';
import { registerContextTools } from './tools/context.js';

// ──── Configuration ────

const HUB_URL = process.env.HUB_URL ?? 'http://localhost:7433';
const HUB_TOKEN = process.env.HUB_TOKEN ?? '';
const MCP_PORT = parseInt(process.env.MCP_PORT ?? '7434', 10);
const TRANSPORT = process.env.MCP_TRANSPORT ?? 'stdio';
const BIND_HOST = process.env.BIND_HOST ?? '0.0.0.0';
const TLS_CERT = process.env.TLS_CERT || undefined;
const TLS_KEY = process.env.TLS_KEY || undefined;

const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || '';
const OAUTH_ALLOWED_IPS = (process.env.OAUTH_ALLOWED_IPS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);

const SSE_STALE_TIMEOUT_MS = 30 * 60_000; // 30 min — clean orphaned SSE transports

if (!HUB_TOKEN) {
  console.error('Error: HUB_TOKEN environment variable is required');
  process.exit(1);
}

// ──── Hub Client ────

export interface HubClient {
  url: string;
  token: string;
  fetch(path: string, opts?: RequestInit): Promise<Response>;
}

function createHubClient(): HubClient {
  return {
    url: HUB_URL,
    token: HUB_TOKEN,
    async fetch(path: string, opts: RequestInit = {}) {
      return globalThis.fetch(`${HUB_URL}${path}`, {
        ...opts,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${HUB_TOKEN}`,
          ...opts.headers,
        },
      });
    },
  };
}

function createMcpServer(hub: HubClient): McpServer {
  const server = new McpServer({ name: 'meshmind-hub', version: '1.0.0' });
  registerDiscoveryTools(server, hub);
  registerExecutionTools(server, hub);
  registerAgentTools(server, hub);
  registerConnectivityTools(server, hub);
  registerContextTools(server, hub);
  return server;
}

// ──── Main ────

async function main() {
  const hub = createHubClient();

  if (TRANSPORT === 'sse') {
    await startSseServer(hub);
  } else {
    const server = createMcpServer(hub);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[meshmind-mcp] Connected via stdio');
  }
}

async function startSseServer(hub: HubClient) {
  const httpsOpts = TLS_CERT && TLS_KEY ? {
    https: { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) },
  } : {};

  const fastify = Fastify({ logger: true, ...httpsOpts });
  const transports = new Map<string, { transport: SSEServerTransport; connectedAt: number }>();

  // Security headers
  fastify.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', 'no-store');
  });

  // OAuth
  const oauth = registerOAuth(fastify, {
    clientId: OAUTH_CLIENT_ID,
    clientSecret: OAUTH_CLIENT_SECRET,
    allowedIps: OAUTH_ALLOWED_IPS,
    mcpPort: MCP_PORT,
    useTls: !!TLS_CERT,
  });

  // Cleanup stale SSE connections (safety net if onclose doesn't fire)
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of transports) {
      if (now - entry.connectedAt > SSE_STALE_TIMEOUT_MS) {
        console.log(`[SSE] Cleaning stale transport: ${id}`);
        transports.delete(id);
      }
    }
  }, 5 * 60_000).unref();

  // SSE endpoint
  fastify.get('/sse', async (request, reply) => {
    if (!oauth.isAllowedIp(request.ip)) {
      console.warn(`[SSE] Rejected from non-allowed IP: ${request.ip}`);
      return reply.code(403).send({ error: 'Not allowed from this IP' });
    }

    reply.hijack();
    const transport = new SSEServerTransport('/messages', reply.raw);
    console.log(`[SSE] New connection: ${transport.sessionId} from ${request.ip}`);
    transports.set(transport.sessionId, { transport, connectedAt: Date.now() });

    transport.onclose = () => {
      console.log(`[SSE] Closed: ${transport.sessionId}`);
      transports.delete(transport.sessionId);
    };

    const mcpServer = createMcpServer(hub);
    try {
      await mcpServer.connect(transport);
    } catch (err) {
      console.error('[SSE] Connect error:', err);
      transports.delete(transport.sessionId);
    }
  });

  // Message endpoint
  fastify.post<{ Querystring: { sessionId?: string }; Body: unknown }>('/messages', async (request, reply) => {
    const sessionId = request.query.sessionId;
    const entry = sessionId ? transports.get(sessionId) : undefined;
    if (!entry) {
      return reply.code(400).send({ error: 'No active SSE connection for sessionId' });
    }
    await entry.transport.handlePostMessage(request.raw, reply.raw, request.body);
  });

  // Health
  fastify.get('/health', async () => ({
    service: 'meshmind-hub-mcp',
    status: 'ok',
    transport: 'sse',
    hubUrl: HUB_URL,
    activeSessions: transports.size,
  }));

  const proto = TLS_CERT ? 'https' : 'http';
  await fastify.listen({ port: MCP_PORT, host: BIND_HOST });
  console.log(`[meshmind-mcp] SSE server listening on ${proto}://${BIND_HOST}:${MCP_PORT}`);

  if (!OAUTH_CLIENT_ID) {
    console.warn('[meshmind-mcp] WARNING: OAUTH_CLIENT_ID not set — dynamic registration enabled');
  }
  if (OAUTH_ALLOWED_IPS.length === 0) {
    console.warn('[meshmind-mcp] WARNING: OAUTH_ALLOWED_IPS not set — any IP can authenticate');
  }
  if (!TLS_CERT) {
    console.warn('[meshmind-mcp] WARNING: TLS not configured — use: tailscale cert <hostname>');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
