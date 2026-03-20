import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';

// ──── Constants ────

const AUTH_CODE_TTL_MS = 5 * 60_000;       // 5 minutes
const ACCESS_TOKEN_TTL_S = 86_400;          // 24 hours
const CLEANUP_INTERVAL_MS = 5 * 60_000;     // 5 minutes

// ──── Types ────

interface AuthCode {
  clientId: string;
  redirectUri: string;
  createdAt: number;
  used: boolean;
}

interface AccessToken {
  clientId: string;
  expiresAt: number;
}

interface RegisteredClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  allowedIps: string[];
  mcpPort: number;
  useTls: boolean;
}

// ──── Helpers ────

function extractIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

// ──── Rate Limiting (scoped to OAuth) ────

interface RateBucket { count: number; resetAt: number; }

function createRateLimiter() {
  const buckets = new Map<string, RateBucket>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (now >= entry.resetAt) buckets.delete(key);
    }
  }, CLEANUP_INTERVAL_MS).unref();

  return (ip: string, path: string, limit: number): { allowed: boolean; retryAfter: number } => {
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

// ──── OAuth Server ────

export function registerOAuth(fastify: FastifyInstance, config: OAuthConfig) {
  const authCodes = new Map<string, AuthCode>();
  const accessTokens = new Map<string, AccessToken>();
  const registeredClients = new Map<string, RegisteredClient>();
  const checkRate = createRateLimiter();

  // Cleanup expired entries
  setInterval(() => {
    const now = Date.now();
    for (const [key, code] of authCodes) {
      if (code.used || now - code.createdAt > AUTH_CODE_TTL_MS) {
        authCodes.delete(key);
      }
    }
    for (const [key, token] of accessTokens) {
      if (now > token.expiresAt) {
        accessTokens.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS).unref();

  function isAllowedIp(ip: string): boolean {
    if (config.allowedIps.length === 0) return true;
    return config.allowedIps.includes(extractIp(ip));
  }

  function isValidClient(clientId: string): boolean {
    if (config.clientId) return clientId === config.clientId;
    return registeredClients.has(clientId);
  }

  function validateClientSecret(clientId: string, secret: string): boolean {
    if (config.clientId && config.clientSecret) {
      return secret === config.clientSecret;
    }
    const reg = registeredClients.get(clientId);
    return reg ? secret === reg.clientSecret : false;
  }

  // ──── Discovery endpoints ────

  function baseUrl(request: { headers: { host?: string } }) {
    const host = request.headers.host ?? `localhost:${config.mcpPort}`;
    const proto = config.useTls ? 'https' : 'http';
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

  const discoveryPaths = [
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/sse',
    '/.well-known/openid-configuration',
    '/.well-known/openid-configuration/sse',
    '/sse/.well-known/openid-configuration',
  ];
  for (const p of discoveryPaths) {
    fastify.get(p, async (req) => oauthMeta(req));
  }

  const resourcePaths = [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/sse',
  ];
  for (const p of resourcePaths) {
    fastify.get(p, async (req) => ({
      resource: baseUrl(req),
      authorization_servers: [baseUrl(req)],
    }));
  }

  // ──── Client Registration (RFC 7591) ────

  fastify.post<{ Body: Record<string, unknown> }>('/register', async (request, reply) => {
    const rl = checkRate(request.ip, '/register', 5);
    if (!rl.allowed) {
      return reply.code(429).send({ error: 'Too Many Requests', retryAfter: rl.retryAfter });
    }
    if (!isAllowedIp(request.ip)) {
      console.warn(`[oauth] Registration rejected from IP: ${extractIp(request.ip)}`);
      return reply.code(403).send({ error: 'Registration not allowed from this IP' });
    }

    const redirectUris = (request.body?.redirect_uris as string[]) ?? [];

    // Pre-configured client — return its credentials
    if (config.clientId) {
      return {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      };
    }

    // Dynamic registration
    const clientId = `meshmind-${crypto.randomUUID()}`;
    const clientSecret = crypto.randomBytes(32).toString('hex');
    registeredClients.set(clientId, { clientId, clientSecret, redirectUris });
    console.log(`[oauth] Registered client: ${clientId} from ${extractIp(request.ip)}`);

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

  // ──── Authorization ────

  fastify.get<{ Querystring: { redirect_uri?: string; state?: string; client_id?: string } }>(
    '/oauth/authorize',
    async (request, reply) => {
      const rl = checkRate(request.ip, '/oauth/authorize', 10);
      if (!rl.allowed) {
        return reply.code(429).send({ error: 'Too Many Requests', retryAfter: rl.retryAfter });
      }
      if (!isAllowedIp(request.ip)) {
        console.warn(`[oauth] Authorization rejected from IP: ${extractIp(request.ip)}`);
        return reply.code(403).send({ error: 'Authorization not allowed from this IP' });
      }

      const { redirect_uri, state, client_id } = request.query;
      if (!redirect_uri) return reply.code(400).send({ error: 'missing redirect_uri' });
      if (!client_id) return reply.code(400).send({ error: 'missing client_id' });
      if (!isValidClient(client_id)) {
        return reply.code(400).send({ error: 'unknown client_id' });
      }

      const code = crypto.randomBytes(32).toString('hex');
      authCodes.set(code, {
        clientId: client_id,
        redirectUri: redirect_uri,
        createdAt: Date.now(),
        used: false,
      });

      console.log(`[oauth] Issued auth code for ${client_id} from ${extractIp(request.ip)}`);

      const url = new URL(redirect_uri);
      url.searchParams.set('code', code);
      if (state) url.searchParams.set('state', state);
      reply.redirect(url.toString());
    },
  );

  // ──── Token Exchange ────

  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );

  fastify.post<{ Body: string | Record<string, unknown> }>('/oauth/token', async (request, reply) => {
    const rl = checkRate(request.ip, '/oauth/token', 20);
    if (!rl.allowed) {
      return reply.code(429).send({ error: 'Too Many Requests', retryAfter: rl.retryAfter });
    }

    const params: Record<string, string> = typeof request.body === 'string'
      ? Object.fromEntries(new URLSearchParams(request.body))
      : request.body as Record<string, string>;

    const { code, client_id, client_secret, grant_type } = params;

    if (grant_type !== 'authorization_code') {
      return reply.code(400).send({ error: 'unsupported_grant_type' });
    }
    if (!code || !client_id) {
      return reply.code(400).send({ error: 'missing code or client_id' });
    }

    // Validate authorization code
    const stored = authCodes.get(code);
    if (!stored) {
      return reply.code(400).send({ error: 'invalid_grant', error_description: 'Unknown code' });
    }
    if (stored.used) {
      authCodes.delete(code);
      return reply.code(400).send({ error: 'invalid_grant', error_description: 'Code already used' });
    }
    if (Date.now() - stored.createdAt > AUTH_CODE_TTL_MS) {
      authCodes.delete(code);
      return reply.code(400).send({ error: 'invalid_grant', error_description: 'Code expired' });
    }
    if (stored.clientId !== client_id) {
      return reply.code(400).send({ error: 'invalid_grant', error_description: 'Client mismatch' });
    }

    // Validate client secret
    if (client_secret && !validateClientSecret(client_id, client_secret)) {
      return reply.code(401).send({ error: 'invalid_client' });
    }

    stored.used = true;

    // Issue access token
    const accessToken = crypto.randomBytes(48).toString('hex');
    accessTokens.set(accessToken, {
      clientId: client_id,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_S * 1000,
    });

    console.log(`[oauth] Issued access token for ${client_id}`);

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      scope: 'mcp',
    };
  });

  // Public API for SSE connection validation
  return {
    isAllowedIp,
    validateAccessToken(authHeader: string | undefined): boolean {
      if (!authHeader?.startsWith('Bearer ')) return false;
      const token = authHeader.slice(7);
      const stored = accessTokens.get(token);
      if (!stored) return false;
      if (Date.now() > stored.expiresAt) {
        accessTokens.delete(token);
        return false;
      }
      return true;
    },
  };
}
