import type { FastifyInstance } from 'fastify';
import type { TaskBroker } from '../broker.js';

export function registerTaskRoutes(fastify: FastifyInstance, broker: TaskBroker) {
  fastify.post<{
    Body: { type: string; nodeName: string; payload: Record<string, unknown> };
  }>('/tasks', async (request) => {
    const { type, nodeName, payload } = request.body;
    return broker.createTask(type, nodeName, payload);
  });

  fastify.get<{ Params: { id: string } }>('/tasks/:id', async (request, reply) => {
    const task = broker.getTask(request.params.id);
    if (!task) {
      return reply.code(404).send({ error: 'Task not found' });
    }
    return task;
  });

  fastify.get('/tasks', async () => broker.listTasks());
}
