import type { FastifyInstance } from 'fastify';
import type { NodeRegistry } from '../registry.js';

export function registerNodeRoutes(
  fastify: FastifyInstance,
  registry: NodeRegistry,
  extractIp: (ip: string) => string,
) {
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

  fastify.get('/nodes', async () => registry.listNodes());

  fastify.get<{ Params: { name: string } }>('/nodes/:name', async (request, reply) => {
    const node = registry.getNode(request.params.name);
    if (!node) {
      return reply.code(404).send({ error: `Node "${request.params.name}" not found` });
    }
    return node;
  });
}
