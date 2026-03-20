import type { FastifyInstance } from 'fastify';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitConfig {
  windowMs: number;    // Time window in milliseconds
  maxRequests: number; // Max requests per window
  // Endpoints with stricter limits (e.g., /exec)
  strictPaths?: { prefix: string; maxRequests: number }[];
}

const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: 60_000,    // 1 minute
  maxRequests: 100,    // 100 req/min general
  strictPaths: [
    { prefix: '/exec', maxRequests: 20 },        // 20 exec/min
    { prefix: '/agents/spawn', maxRequests: 10 }, // 10 spawns/min
  ],
};

export function registerRateLimit(fastify: FastifyInstance, config: RateLimitConfig = DEFAULT_CONFIG) {
  const buckets = new Map<string, RateLimitEntry>();

  // Cleanup expired entries every 5 minutes
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (now >= entry.resetAt) {
        buckets.delete(key);
      }
    }
  }, 5 * 60_000);
  cleanup.unref();

  fastify.addHook('onRequest', async (request, reply) => {
    // Skip health checks
    if (request.url === '/health') return;

    const ip = request.ip;
    const now = Date.now();

    // Determine limit for this path
    let maxReq = config.maxRequests;
    for (const strict of config.strictPaths ?? []) {
      if (request.url.startsWith(strict.prefix)) {
        maxReq = strict.maxRequests;
        break;
      }
    }

    const key = `${ip}:${request.url.split('?')[0]}`;
    let entry = buckets.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + config.windowMs };
      buckets.set(key, entry);
    }

    entry.count++;

    // Set rate limit headers
    reply.header('X-RateLimit-Limit', maxReq);
    reply.header('X-RateLimit-Remaining', Math.max(0, maxReq - entry.count));
    reply.header('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000));

    if (entry.count > maxReq) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      reply.header('Retry-After', retryAfter);
      return reply.code(429).send({
        error: 'Too Many Requests',
        retryAfter,
      });
    }
  });
}
