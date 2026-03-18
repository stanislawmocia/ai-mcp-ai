import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import Fastify from 'fastify';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerExecutionTools } from './tools/execution.js';
import { registerAgentTools } from './tools/agents.js';
import { registerConnectivityTools } from './tools/connectivity.js';
import { registerContextTools } from './tools/context.js';

const HUB_URL = process.env.HUB_URL ?? 'http://localhost:7433';
const HUB_TOKEN = process.env.HUB_TOKEN ?? '';
const MCP_PORT = parseInt(process.env.MCP_PORT ?? '7434', 10);
const TRANSPORT = process.env.MCP_TRANSPORT ?? 'stdio';

if (!HUB_TOKEN) {
  console.error('Error: HUB_TOKEN environment variable is required');
  process.exit(1);
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

async function main() {
  const hub = createHubClient();

  const server = new McpServer({
    name: 'meshmind-hub',
    version: '1.0.0',
  });

  // Register all tool groups
  registerDiscoveryTools(server, hub);
  registerExecutionTools(server, hub);
  registerAgentTools(server, hub);
  registerConnectivityTools(server, hub);
  registerContextTools(server, hub);

  if (TRANSPORT === 'sse') {
    // SSE transport via Fastify
    const fastify = Fastify({ logger: true });
    let transport: SSEServerTransport | null = null;

    fastify.get('/sse', async (request, reply) => {
      // Auth check
      const auth = request.headers.authorization;
      if (!auth || auth !== `Bearer ${HUB_TOKEN}`) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }

      transport = new SSEServerTransport('/messages', reply.raw);
      await server.connect(transport);
    });

    fastify.post('/messages', async (request, reply) => {
      if (!transport) {
        reply.code(400).send({ error: 'No active SSE connection' });
        return;
      }
      await transport.handlePostMessage(request.raw, reply.raw);
    });

    fastify.get('/health', async () => ({
      service: 'meshmind-hub-mcp',
      status: 'ok',
      transport: 'sse',
      hubUrl: HUB_URL,
    }));

    await fastify.listen({ port: MCP_PORT, host: '0.0.0.0' });
    console.log(`[meshmind-mcp] SSE server listening on :${MCP_PORT}`);
  } else {
    // stdio transport (default)
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[meshmind-mcp] Connected via stdio');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
