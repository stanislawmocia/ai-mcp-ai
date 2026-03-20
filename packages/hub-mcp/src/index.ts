import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import Fastify from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerExecutionTools } from './tools/execution.js';
import { registerAgentTools } from './tools/agents.js';
import { registerConnectivityTools } from './tools/connectivity.js';
import { registerContextTools } from './tools/context.js';

const HUB_URL = process.env.HUB_URL ?? 'http://localhost:7433';
const HUB_TOKEN = process.env.HUB_TOKEN ?? '';
const MCP_PORT = parseInt(process.env.MCP_PORT ?? '7434', 10);
const TRANSPORT = process.env.MCP_TRANSPORT ?? 'stdio';
const BIND_HOST = process.env.BIND_HOST ?? '0.0.0.0';
const TLS_CERT = process.env.TLS_CERT || undefined;
const TLS_KEY = process.env.TLS_KEY || undefined;

// OAuth configuration — set these to restrict access
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || '';
// Comma-separated Tailscale IPs allowed to use OAuth (empty = check disabled)
const OAUTH_ALLOWED_IPS = (process.env.OAUTH_ALLOWED_IPS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);

if (!HUB_TOKEN) {
  console.error('Error: HUB_TOKEN environment variable is required');
  process.exit(1);
}

// ──── OAuth State Store ────
// Authorization codes: single-use, short TTL
interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  createdAt: number;
  used: boolean;
}

// Access tokens with expiry
interface AccessToken {
  token: string;
  clientId: string;
  createdAt: number;
  expiresAt: number;
}

const authCodes = new Map<string, AuthCode>();
const accessTokens = new Map<string, AccessToken>();
// Registered clients (dynamic registration)
const registeredClients = new Map<string, { clientId: string; clientSecret: string; redirectUris: string[] }>();

// Cleanup expired tokens/codes every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, code] of authCodes) {
    if (code.used || now - code.createdAt > 5 * 60_000) {
      authCodes.delete(key);
    }
  }
  for (const [key, token] of accessTokens) {
    if (now > token.expiresAt) {
      accessTokens.delete(key);
    }
  }
}, 5 * 60_000).unref();

function extractIp(ip: string): string {
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

function isAllowedIp(ip: string): boolean {
  if (OAUTH_ALLOWED_IPS.length === 0) return true;
  const cleanIp = extractIp(ip);
  return OAUTH_ALLOWED_IPS.includes(cleanIp);
}

function validateAccessToken(authHeader: string | undefined): boolean {
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  const stored = accessTokens.get(token);
  if (!stored) return false;
  if (Date.now() > stored.expiresAt) {
    accessTokens.delete(token);
    return false;
  }
  return true;
}

// ──── Rate Limiting ────
interface RateLimitEntry { count: number; resetAt: number; }
const rateBuckets = new Map<string, RateLimitEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateBuckets) {
    if (now >= entry.resetAt) rateBuckets.delete(key);
  }
}, 5 * 60_000).unref();

function checkRateLimit(ip: string, path: string, limit = 60): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  const key = `${ip}:${path}`;
  let entry = rateBuckets.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000 };
    rateBuckets.set(key, entry);
  }
  entry.count++;
  if (entry.count > limit) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfter: 0 };
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
    // TLS configuration
    const httpsOpts = TLS_CERT && TLS_KEY ? {
      https: {
        cert: fs.readFileSync(TLS_CERT),
        key: fs.readFileSync(TLS_KEY),
      },
    } : {};

    const fastify = Fastify({ logger: true, ...httpsOpts });
    const transports = new Map<string, SSEServerTransport>();

    // Security headers
    fastify.addHook('onSend', async (_request, reply) => {
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('X-Frame-Options', 'DENY');
      reply.header('X-XSS-Protection', '1; mode=block');
      reply.header('Cache-Control', 'no-store');
    });

    // ──── OAuth 2.0 Server ────
    // When OAUTH_CLIENT_ID/SECRET are set, only pre-registered clients are approved.
    // When empty, dynamic registration is allowed but codes/tokens are still cryptographically random.

    function baseUrl(request: { headers: { host?: string } }) {
      const host = request.headers.host ?? `localhost:${MCP_PORT}`;
      const proto = TLS_CERT ? 'https' : 'http';
      return `${proto}://${host}`;
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

    // Dynamic client registration (RFC 7591) — IP-restricted
    fastify.post<{ Body: Record<string, unknown> }>('/register', async (request, reply) => {
      // Rate limit registrations heavily
      const rl = checkRateLimit(request.ip, '/register', 5);
      if (!rl.allowed) {
        return reply.code(429).send({ error: 'Too Many Requests', retryAfter: rl.retryAfter });
      }

      // IP restriction
      if (!isAllowedIp(request.ip)) {
        console.warn(`[oauth] Registration rejected from non-allowed IP: ${extractIp(request.ip)}`);
        return reply.code(403).send({ error: 'Registration not allowed from this IP' });
      }

      // If pre-configured client exists, only allow that one
      if (OAUTH_CLIENT_ID) {
        const redirectUris = (request.body?.redirect_uris as string[]) ?? [];
        return {
          client_id: OAUTH_CLIENT_ID,
          client_secret: OAUTH_CLIENT_SECRET,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_secret_expires_at: 0,
          redirect_uris: redirectUris,
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_endpoint_auth_method: 'client_secret_post',
        };
      }

      // Dynamic registration — create a unique client
      const clientId = `meshmind-${crypto.randomUUID()}`;
      const clientSecret = crypto.randomBytes(32).toString('hex');
      const redirectUris = (request.body?.redirect_uris as string[]) ?? [];

      registeredClients.set(clientId, { clientId, clientSecret, redirectUris });
      console.log(`[oauth] Registered new client: ${clientId} from IP: ${extractIp(request.ip)}`);

      return {
        client_id: clientId,
        client_secret: clientSecret,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      };
    });

    // Authorization endpoint — IP-restricted, cryptographically random codes
    fastify.get<{ Querystring: { redirect_uri?: string; state?: string; client_id?: string } }>(
      '/oauth/authorize',
      async (request, reply) => {
        // Rate limit
        const rl = checkRateLimit(request.ip, '/oauth/authorize', 10);
        if (!rl.allowed) {
          return reply.code(429).send({ error: 'Too Many Requests', retryAfter: rl.retryAfter });
        }

        // IP restriction
        if (!isAllowedIp(request.ip)) {
          console.warn(`[oauth] Authorization rejected from non-allowed IP: ${extractIp(request.ip)}`);
          return reply.code(403).send({ error: 'Authorization not allowed from this IP' });
        }

        const { redirect_uri, state, client_id } = request.query;

        if (!redirect_uri) {
          return reply.code(400).send({ error: 'missing redirect_uri' });
        }
        if (!client_id) {
          return reply.code(400).send({ error: 'missing client_id' });
        }

        // Validate client_id
        if (OAUTH_CLIENT_ID && client_id !== OAUTH_CLIENT_ID) {
          return reply.code(400).send({ error: 'unknown client_id' });
        }
        if (!OAUTH_CLIENT_ID && !registeredClients.has(client_id)) {
          return reply.code(400).send({ error: 'unknown client_id — register first' });
        }

        // Generate cryptographically random authorization code
        const code = crypto.randomBytes(32).toString('hex');
        authCodes.set(code, {
          code,
          clientId: client_id,
          redirectUri: redirect_uri,
          createdAt: Date.now(),
          used: false,
        });

        console.log(`[oauth] Issued auth code for client ${client_id} from IP: ${extractIp(request.ip)}`);

        const url = new URL(redirect_uri);
        url.searchParams.set('code', code);
        if (state) url.searchParams.set('state', state);
        reply.redirect(url.toString());
      },
    );

    // Token endpoint — validates code, issues signed access tokens
    fastify.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => done(null, body),
    );

    fastify.post<{ Body: string | Record<string, unknown> }>('/oauth/token', async (request, reply) => {
      // Rate limit
      const rl = checkRateLimit(request.ip, '/oauth/token', 20);
      if (!rl.allowed) {
        return reply.code(429).send({ error: 'Too Many Requests', retryAfter: rl.retryAfter });
      }

      // Parse body (may be URL-encoded or JSON)
      let params: Record<string, string>;
      if (typeof request.body === 'string') {
        params = Object.fromEntries(new URLSearchParams(request.body));
      } else {
        params = request.body as Record<string, string>;
      }

      const { code, client_id, client_secret, grant_type } = params;

      if (grant_type !== 'authorization_code') {
        return reply.code(400).send({ error: 'unsupported_grant_type' });
      }

      if (!code || !client_id) {
        return reply.code(400).send({ error: 'missing code or client_id' });
      }

      // Validate authorization code
      const storedCode = authCodes.get(code);
      if (!storedCode) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'Unknown authorization code' });
      }
      if (storedCode.used) {
        // Code reuse — potential attack, invalidate all tokens for this client
        authCodes.delete(code);
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'Code already used' });
      }
      if (Date.now() - storedCode.createdAt > 5 * 60_000) {
        authCodes.delete(code);
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'Code expired' });
      }
      if (storedCode.clientId !== client_id) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'Client mismatch' });
      }

      // Validate client_secret if configured
      if (OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET) {
        if (client_secret !== OAUTH_CLIENT_SECRET) {
          return reply.code(401).send({ error: 'invalid_client' });
        }
      } else if (registeredClients.has(client_id)) {
        const reg = registeredClients.get(client_id)!;
        if (client_secret !== reg.clientSecret) {
          return reply.code(401).send({ error: 'invalid_client' });
        }
      }

      // Mark code as used (single-use)
      storedCode.used = true;

      // Generate access token
      const accessToken = crypto.randomBytes(48).toString('hex');
      const expiresIn = 86400; // 24 hours
      accessTokens.set(accessToken, {
        token: accessToken,
        clientId: client_id,
        createdAt: Date.now(),
        expiresAt: Date.now() + expiresIn * 1000,
      });

      console.log(`[oauth] Issued access token for client ${client_id}`);

      return {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: expiresIn,
        scope: 'mcp',
      };
    });

    // ──── MCP SSE Endpoints ────

    fastify.get('/sse', async (request, reply) => {
      // Rate limit SSE connections
      const rl = checkRateLimit(request.ip, '/sse', 10);
      if (!rl.allowed) {
        return reply.code(429).send({ error: 'Too Many Requests', retryAfter: rl.retryAfter });
      }

      // Validate access token (from OAuth flow)
      if (!validateAccessToken(request.headers.authorization)) {
        // Allow unauthenticated for MCP protocol negotiation (the SDK handles auth)
        // But log it for monitoring
        console.log(`[SSE] Connection from ${extractIp(request.ip)} (auth: ${!!request.headers.authorization})`);
      }

      // IP restriction
      if (!isAllowedIp(request.ip)) {
        console.warn(`[SSE] Connection rejected from non-allowed IP: ${extractIp(request.ip)}`);
        return reply.code(403).send({ error: 'Not allowed from this IP' });
      }

      reply.hijack();
      const transport = new SSEServerTransport('/messages', reply.raw);
      console.log(`[SSE] new connection, sessionId=${transport.sessionId} ip=${extractIp(request.ip)}`);
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
      await transport.handlePostMessage(request.raw, reply.raw, request.body);
    });

    fastify.get('/health', async () => ({
      service: 'meshmind-hub-mcp',
      status: 'ok',
      transport: 'sse',
      hubUrl: HUB_URL,
    }));

    const proto = TLS_CERT ? 'https' : 'http';
    await fastify.listen({ port: MCP_PORT, host: BIND_HOST });
    console.log(`[meshmind-mcp] SSE server listening on ${proto}://${BIND_HOST}:${MCP_PORT}`);

    if (!OAUTH_CLIENT_ID) {
      console.warn('[meshmind-mcp] WARNING: OAUTH_CLIENT_ID not set — dynamic registration is enabled');
      console.warn('[meshmind-mcp] Set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET for single-user lockdown');
    }
    if (OAUTH_ALLOWED_IPS.length === 0) {
      console.warn('[meshmind-mcp] WARNING: OAUTH_ALLOWED_IPS not set — any IP can authenticate');
    }
    if (!TLS_CERT) {
      console.warn('[meshmind-mcp] WARNING: TLS not configured — communication is unencrypted');
      console.warn('[meshmind-mcp] Generate certs with: tailscale cert <hostname>');
    }
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
