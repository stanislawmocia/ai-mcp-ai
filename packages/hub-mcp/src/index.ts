import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import Fastify from 'fastify';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerExecutionTools } from './tools/execution.js';
import { registerAgentTools } from './tools/agents.js';
import { registerConnectivityTools } from './tools/connectivity.js';
import { registerContextTools } from './tools/context.js';

const HUB_URL = process.env.HUB_URL ?? 'http://localhost:7433';
const HUB_TOKEN = process.env.HUB_TOKEN ?? '';
const MCP_PORT = parseInt(process.env.MCP_PORT ?? '7434', 10);
const TRANSPORT = process.env.MCP_TRANSPORT ?? 'stdio';

if (!HUB_TOKEN) {
  console.error('Error: HUB_TOKEN environment variable is required');
  process.exit(1);
}


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
      const url = `${HUB_URL}${path}`;
      return globalThis.fetch(url, {
        ...opts,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${HUB_TOKEN}`,
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

async function main() {
  const hub = createHubClient();

  if (TRANSPORT === 'sse') {
    // SSE transport via Fastify — new McpServer per connection
    const fastify = Fastify({ logger: true });
    const transports = new Map<string, SSEServerTransport>();

    // Minimal no-op OAuth 2.0 server — satisfies MCP OAuth discovery (Tailscale handles real security)
    function baseUrl(request: { headers: { host?: string } }) {
      const host = request.headers.host ?? `localhost:${MCP_PORT}`;
      return `http://${host}`;
    }
    function oauthMeta(req: { headers: { host?: string } }) {
      const base = baseUrl(req);
      return {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
      };
    }
    fastify.get('/.well-known/oauth-authorization-server', async (req) => oauthMeta(req));
    fastify.get('/.well-known/oauth-authorization-server/sse', async (req) => oauthMeta(req));
    fastify.get('/.well-known/openid-configuration', async (req) => oauthMeta(req));
    fastify.get('/.well-known/openid-configuration/sse', async (req) => oauthMeta(req));
    fastify.get('/sse/.well-known/openid-configuration', async (req) => oauthMeta(req));
    fastify.get('/.well-known/oauth-protected-resource', async (req) => ({
      resource: baseUrl(req),
      authorization_servers: [baseUrl(req)],
    }));
    fastify.get('/.well-known/oauth-protected-resource/sse', async (req) => ({
      resource: baseUrl(req),
      authorization_servers: [baseUrl(req)],
    }));

    // Dynamic client registration (RFC 7591) — always succeeds
    fastify.post<{ Body: Record<string, unknown> }>('/register', async (request) => {
      const redirectUris = (request.body?.redirect_uris as string[]) ?? [];
      return {
        client_id: `meshmind-${Date.now()}`,
        client_secret: 'unused',
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    });

    // Authorization endpoint — redirect immediately with a fake code (Tailscale handles real security)
    fastify.get<{ Querystring: { redirect_uri?: string; state?: string; client_id?: string } }>(
      '/oauth/authorize',
      async (request, reply) => {
        const { redirect_uri, state } = request.query;
        if (!redirect_uri) {
          reply.code(400).send({ error: 'missing redirect_uri' });
          return;
        }
        const url = new URL(redirect_uri);
        url.searchParams.set('code', 'meshmind-access-granted');
        if (state) url.searchParams.set('state', state);
        reply.redirect(url.toString());
      },
    );

    // Token endpoint — always returns a valid-looking token
    // OAuth clients send application/x-www-form-urlencoded, so we need a parser for it
    fastify.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => done(null, body),
    );
    fastify.post('/oauth/token', async () => ({
      access_token: 'meshmind-token',
      token_type: 'bearer',
      expires_in: 86400,
      scope: 'mcp',
    }));

    fastify.get('/sse', async (request, reply) => {
      // Hijack the response so Fastify doesn't close it when the handler returns
      reply.hijack();
      const transport = new SSEServerTransport('/messages', reply.raw);
      console.log(`[SSE] new connection, sessionId=${transport.sessionId}`);
      transports.set(transport.sessionId, transport);
      transport.onclose = () => {
        console.log(`[SSE] closed sessionId=${transport.sessionId}`);
        transports.delete(transport.sessionId);
      };
      const mcpServer = createMcpServer(hub);
      try {
        await mcpServer.connect(transport);
      } catch (err) {
        console.error('[SSE] connect error:', err);
        transports.delete(transport.sessionId);
      }
    });

    fastify.post<{ Querystring: { sessionId?: string }; Body: unknown }>('/messages', async (request, reply) => {
      const sessionId = request.query.sessionId;
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        reply.code(400).send({ error: 'No active SSE connection for sessionId' });
        return;
      }
      // Pass parsed body directly — Fastify already consumed the stream
      await transport.handlePostMessage(request.raw, reply.raw, request.body);
    });

    fastify.get('/health', async () => ({
      service: 'meshmind-hub-mcp',
      status: 'ok',
      transport: 'sse',
      hubUrl: HUB_URL,
    }));

    await fastify.listen({ port: MCP_PORT, host: '0.0.0.0' });
    console.log(`[meshmind-mcp] SSE server listening on :${MCP_PORT}`);
  } else {
    // stdio transport (default)
    const server = createMcpServer(hub);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[meshmind-mcp] Connected via stdio');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
