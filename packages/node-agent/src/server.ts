import Fastify from 'fastify';
import { execHandler } from './executor.js';
import { getHealthInfo, getCapabilities } from './monitor.js';
import { startHeartbeat } from './heartbeat.js';

export interface NodeAgentConfig {
  name: string;
  port: number;
  hubUrl: string;
  token: string;
}

export async function startNodeAgent(config: NodeAgentConfig) {
  const fastify = Fastify({ logger: true });

  // Auth middleware
  fastify.addHook('onRequest', async (request, reply) => {
    const url = request.url;
    if (url === '/health') return; // health is public

    const auth = request.headers.authorization;
    if (!auth || auth !== `Bearer ${config.token}`) {
      reply.code(401).send({ error: 'Unauthorized' });
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

  // Agent lifecycle endpoints (Phase 2)
  fastify.post<{
    Body: { tool: string; workdir: string; context?: string; systemPrompt?: string };
  }>('/start-agent', async (request) => {
    const { tool, workdir, context, systemPrompt } = request.body;
    // Phase 2 implementation
    return { error: 'Not implemented yet — Phase 2', tool, workdir };
  });

  fastify.get<{ Params: { id: string } }>('/agent/:id', async (request) => {
    return { error: 'Not implemented yet — Phase 2', id: request.params.id };
  });

  fastify.post<{
    Params: { id: string };
    Body: { message: string };
  }>('/agent/:id/send', async (request) => {
    return { error: 'Not implemented yet — Phase 2', id: request.params.id };
  });

  fastify.get<{ Params: { id: string } }>('/agent/:id/read', async (request) => {
    return { error: 'Not implemented yet — Phase 2', id: request.params.id };
  });

  fastify.delete<{ Params: { id: string } }>('/agent/:id', async (request) => {
    return { error: 'Not implemented yet — Phase 2', id: request.params.id };
  });

  // Start server
  await fastify.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[meshmind-node] "${config.name}" listening on :${config.port}`);

  // Start heartbeat to hub
  startHeartbeat(config);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[meshmind-node] Shutting down...');
    await fastify.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return fastify;
}
