import type { FastifyInstance } from 'fastify';
import type { NodeRegistry } from '../registry.js';

interface SessionStore {
  set(sessionId: string, nodeName: string, tool: string, mode: string, status?: string): void;
  getNode(sessionId: string): string | null;
  updateStatus(sessionId: string, status: string): void;
}

interface ProxyResult {
  ok: boolean;
  status: number;
  data: unknown;
}

function createNodeProxy(registry: NodeRegistry, token: string) {
  return async (nodeName: string, path: string, method: string, body?: unknown): Promise<ProxyResult> => {
    const node = registry.getNode(nodeName);
    if (!node) {
      return { ok: false, status: 404, data: { error: `Node "${nodeName}" not found or offline` } };
    }

    const nodeUrl = `http://${node.tailscaleIp}:${node.port}${path}`;
    try {
      const hasBody = body !== undefined;
      const res = await fetch(nodeUrl, {
        method,
        headers: {
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `Bearer ${token}`,
        },
        body: hasBody ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      return { ok: res.ok, status: res.status, data };
    } catch (error) {
      return {
        ok: false,
        status: 502,
        data: { error: `Failed to reach node at ${nodeUrl}`, details: (error as Error).message },
      };
    }
  };
}

export function registerAgentRoutes(
  fastify: FastifyInstance,
  registry: NodeRegistry,
  sessionStore: SessionStore,
  token: string,
) {
  const proxyToNode = createNodeProxy(registry, token);

  // Helper: resolve session to node, proxy the request
  async function withSession(
    sessionId: string,
    reply: { code: (n: number) => { send: (d: unknown) => void } },
    fn: (nodeName: string) => Promise<ProxyResult>,
  ) {
    const nodeName = sessionStore.getNode(sessionId);
    if (!nodeName) {
      reply.code(404).send({ error: `Session "${sessionId}" not found in hub registry` });
      return null;
    }
    const result = await fn(nodeName);
    if (!result.ok) {
      reply.code(result.status).send(result.data);
      return null;
    }
    return { data: result.data as Record<string, unknown>, nodeName };
  }

  fastify.post<{
    Body: {
      nodeName: string;
      tool: string;
      workdir: string;
      mode?: string;
      args?: string[];
      prompt?: string;
      systemPrompt?: string;
      timeoutMs?: number;
    };
  }>('/agents/spawn', async (request, reply) => {
    const { nodeName, ...agentOpts } = request.body;
    const result = await proxyToNode(nodeName, '/start-agent', 'POST', agentOpts);
    if (!result.ok) {
      return reply.code(result.status).send(result.data);
    }
    const data = result.data as { sessionId: string; tool: string; mode: string };
    sessionStore.set(data.sessionId, nodeName, data.tool, data.mode);
    return result.data;
  });

  fastify.get<{ Params: { sessionId: string } }>('/agents/:sessionId', async (request, reply) => {
    const res = await withSession(request.params.sessionId, reply, (nodeName) =>
      proxyToNode(nodeName, `/agent/${request.params.sessionId}`, 'GET'),
    );
    return res ? { ...res.data, nodeName: res.nodeName } : undefined;
  });

  fastify.post<{
    Params: { sessionId: string };
    Body: { message: string };
  }>('/agents/:sessionId/send', async (request, reply) => {
    const res = await withSession(request.params.sessionId, reply, (nodeName) =>
      proxyToNode(nodeName, `/agent/${request.params.sessionId}/send`, 'POST', request.body),
    );
    return res?.data;
  });

  fastify.get<{
    Params: { sessionId: string };
    Querystring: { offset?: string; limit?: string };
  }>('/agents/:sessionId/read', async (request, reply) => {
    const { sessionId } = request.params;
    const qs = new URLSearchParams();
    if (request.query.offset) qs.set('offset', request.query.offset);
    if (request.query.limit) qs.set('limit', request.query.limit);
    const qsStr = qs.toString() ? `?${qs.toString()}` : '';

    const res = await withSession(sessionId, reply, (nodeName) =>
      proxyToNode(nodeName, `/agent/${sessionId}/read${qsStr}`, 'GET'),
    );
    return res ? { ...res.data, nodeName: res.nodeName } : undefined;
  });

  fastify.delete<{ Params: { sessionId: string } }>('/agents/:sessionId', async (request, reply) => {
    const res = await withSession(request.params.sessionId, reply, (nodeName) =>
      proxyToNode(nodeName, `/agent/${request.params.sessionId}`, 'DELETE'),
    );
    if (res) {
      sessionStore.updateStatus(request.params.sessionId, 'killed');
    }
    return res?.data;
  });

  fastify.get('/agents', async () => {
    const allAgents: Array<Record<string, unknown>> = [];
    for (const node of registry.listNodes()) {
      try {
        const result = await proxyToNode(node.name, '/agents', 'GET');
        if (result.ok) {
          const agents = result.data as Array<Record<string, unknown>>;
          for (const agent of agents) {
            allAgents.push({ ...agent, nodeName: node.name });
          }
        }
      } catch {
        // Skip unreachable nodes
      }
    }
    return allAgents;
  });
}
