import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HubClient } from '../index.js';

export function registerDiscoveryTools(server: McpServer, hub: HubClient) {
  server.tool(
    'list_nodes',
    'List all nodes in the MeshMind mesh with their status, capabilities, and health info',
    {},
    async () => {
      try {
        const res = await hub.fetch('/nodes');
        const nodes = await res.json();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(nodes, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error listing nodes: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'node_info',
    'Get detailed info about a specific node (health, capabilities, status)',
    { nodeName: z.string().describe('Name of the node to query') },
    async ({ nodeName }) => {
      try {
        const res = await hub.fetch(`/nodes/${encodeURIComponent(nodeName)}`);
        if (!res.ok) {
          const err = await res.json();
          return {
            content: [
              { type: 'text' as const, text: `Node "${nodeName}" not found: ${JSON.stringify(err)}` },
            ],
            isError: true,
          };
        }
        const node = await res.json();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(node, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: `Error: ${(error as Error).message}` },
          ],
          isError: true,
        };
      }
    },
  );
}
