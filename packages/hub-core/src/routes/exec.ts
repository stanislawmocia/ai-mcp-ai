import type { FastifyInstance } from 'fastify';
import type { NodeRegistry } from '../registry.js';

export function registerExecRoutes(
  fastify: FastifyInstance,
  registry: NodeRegistry,
  token: string,
) {
  fastify.post<{
    Body: { nodeName: string; cmd: string; workdir?: string; timeout?: number };
  }>('/exec', async (request, reply) => {
    const { nodeName, cmd, workdir, timeout } = request.body;
    const node = registry.getNode(nodeName);
    if (!node) {
      return reply.code(404).send({ error: `Node "${nodeName}" not found or offline` });
    }

    const nodeUrl = `http://${node.tailscaleIp}:${node.port}`;
    try {
      const res = await fetch(`${nodeUrl}/exec`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
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
}
