import type { FastifyInstance } from 'fastify';
import type { ContextStore } from '../context.js';

export function registerContextRoutes(fastify: FastifyInstance, contextStore: ContextStore) {
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
      return reply.code(404).send({ error: `Context key "${request.params.key}" not found or expired` });
    }
    return entry;
  });

  fastify.delete<{ Params: { key: string } }>('/context/:key', async (request) => {
    contextStore.remove(request.params.key);
    return { ok: true };
  });
}
