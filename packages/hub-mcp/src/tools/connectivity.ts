import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HubClient } from '../index.js';

export function registerConnectivityTools(server: McpServer, hub: HubClient) {
  server.tool(
    'check_connection',
    'Check if one node can reach another node on a specific port via the mesh.',
    {
      fromNode: z.string().describe('Source node name'),
      toNode: z.string().describe('Target node name'),
      port: z.number().describe('Port to check'),
    },
    async ({ fromNode, toNode, port }) => {
      try {
        // Get target node IP from registry
        const targetRes = await hub.fetch(`/nodes/${encodeURIComponent(toNode)}`);
        if (!targetRes.ok) {
          return {
            content: [{ type: 'text' as const, text: `Target node "${toNode}" not found or offline` }],
            isError: true,
          };
        }
        const targetNode = await targetRes.json() as { tailscaleIp: string };

        // Use a safe command (no shell metacharacters) to test connectivity
        // `nc -z -w 5` tests TCP connection with 5s timeout
        const cmd = `nc -z -w 5 ${targetNode.tailscaleIp} ${port}`;

        const execRes = await hub.fetch('/exec', {
          method: 'POST',
          body: JSON.stringify({
            nodeName: fromNode,
            cmd,
            timeout: 10_000,
          }),
        });

        const result = await execRes.json() as { stdout: string; stderr: string; exitCode: number };

        const reachable = result.exitCode === 0;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ reachable, from: fromNode, to: toNode, port }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
