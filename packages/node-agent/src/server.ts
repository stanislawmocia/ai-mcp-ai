import Fastify from 'fastify';
import { execHandler } from './executor.js';
import { getHealthInfo, getCapabilities, setAgentProvider } from './monitor.js';
import { startHeartbeat } from './heartbeat.js';
import { createAgentManager, type AgentMode } from './agents.js';

export interface NodeAgentConfig {
  name: string;
  port: number;
  hubUrl: string;
  token: string;
}

export async function startNodeAgent(config: NodeAgentConfig) {
  const fastify = Fastify({ logger: true });
  const agentManager = createAgentManager();

  // Wire runningAgents into capabilities/heartbeat
  setAgentProvider(() => agentManager.runningIds());

  // Auth middleware
  fastify.addHook('onRequest', async (request, reply) => {
    const url = request.url;
    if (url === '/health') return;

    const auth = request.headers.authorization;
    if (!auth || auth !== `Bearer ${config.token}`) {
      return reply.code(401).send({ error: 'Unauthorized' });
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

  // ──── Agent lifecycle ────

  // List all agents on this node
  fastify.get('/agents', async () => {
    return agentManager.list().map(s => ({
      id: s.id,
      tool: s.tool,
      mode: s.mode,
      status: s.status,
      pid: s.pid,
      exitCode: s.exitCode,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    }));
  });

  // Start agent
  fastify.post<{
    Body: {
      tool: string;
      workdir: string;
      mode?: AgentMode;
      args?: string[];
      prompt?: string;
      systemPrompt?: string;
      timeoutMs?: number;
    };
  }>('/start-agent', async (request, reply) => {
    const { tool, workdir, mode, args, prompt, systemPrompt, timeoutMs } = request.body;

    // Check if tool is available
    const caps = getCapabilities();
    const toolName = tool === 'claude-code' ? 'claude' : tool;
    const knownTools = ['claude', 'aider', 'python3', 'node'];
    if (knownTools.includes(toolName) && !caps.tools.includes(toolName)) {
      reply.code(400).send({
        error: `Tool "${tool}" is not available on this node`,
        availableTools: caps.tools,
      });
      return;
    }

    const session = agentManager.start({
      tool,
      mode: mode ?? 'oneshot',
      workdir,
      args,
      prompt,
      systemPrompt,
      timeoutMs,
    });

    return {
      sessionId: session.id,
      pid: session.pid,
      status: session.status,
      mode: session.mode,
      tool: session.tool,
      timeoutMs: session.timeoutMs,
    };
  });

  // Get agent status
  fastify.get<{ Params: { id: string } }>('/agent/:id', async (request, reply) => {
    const session = agentManager.get(request.params.id);
    if (!session) {
      reply.code(404).send({ error: 'Agent session not found' });
      return;
    }
    return {
      id: session.id,
      tool: session.tool,
      mode: session.mode,
      status: session.status,
      pid: session.pid,
      exitCode: session.exitCode,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      lastLines: session.ringBuffer.slice(-10),
    };
  });

  // Send message to agent stdin
  fastify.post<{
    Params: { id: string };
    Body: { message: string };
  }>('/agent/:id/send', async (request, reply) => {
    const result = agentManager.send(request.params.id, request.body.message);
    if (!result.ok) {
      reply.code(400).send(result);
      return;
    }
    return result;
  });

  // Read agent output (ring buffer)
  fastify.get<{
    Params: { id: string };
    Querystring: { offset?: string; limit?: string };
  }>('/agent/:id/read', async (request, reply) => {
    const offset = request.query.offset ? parseInt(request.query.offset, 10) : undefined;
    const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
    const result = agentManager.read(request.params.id, { offset, limit });
    if (!result) {
      reply.code(404).send({ error: 'Agent session not found' });
      return;
    }
    return result;
  });

  // Kill agent
  fastify.delete<{ Params: { id: string } }>('/agent/:id', async (request, reply) => {
    const result = agentManager.kill(request.params.id);
    if (!result.ok) {
      reply.code(400).send(result);
      return;
    }
    return result;
  });

  // Start server
  await fastify.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[meshmind-node] "${config.name}" listening on :${config.port}`);

  // Start heartbeat to hub
  startHeartbeat(config);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[meshmind-node] Shutting down...');
    for (const session of agentManager.list()) {
      if (session.status === 'running') {
        agentManager.kill(session.id);
      }
    }
    await fastify.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return fastify;
}
