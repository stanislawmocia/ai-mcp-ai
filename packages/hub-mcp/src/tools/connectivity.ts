import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HubClient } from '../index.js';

export function registerConnectivityTools(server: McpServer, hub: HubClient) {
  server.tool(
    'check_connection',
    'Check if one node can reach another node on a specific port. Tests TCP connectivity and measures latency.',
    {
      fromNode: z.string().describe('Source node name'),
      toNode: z.string().describe('Target node name'),
      port: z.number().describe('Port to check'),
    },
    async ({ fromNode, toNode, port }) => {
      try {
        // Get target node IP
        const targetRes = await hub.fetch(`/nodes/${encodeURIComponent(toNode)}`);
        if (!targetRes.ok) {
          return {
            content: [
              { type: 'text' as const, text: `Target node "${toNode}" not found or offline` },
            ],
            isError: true,
          };
        }
        const targetNode = await targetRes.json() as { tailscaleIp: string };

        // Execute connectivity check on source node
        const cmd = `timeout 5 bash -c 'start=$(date +%s%N); echo > /dev/tcp/${targetNode.tailscaleIp}/${port} 2>/dev/null && echo "REACHABLE $(( ($(date +%s%N) - start) / 1000000 ))ms" || echo "UNREACHABLE"'`;

        const execRes = await hub.fetch('/exec', {
          method: 'POST',
          body: JSON.stringify({
            nodeName: fromNode,
            cmd,
            timeout: 10000,
          }),
        });

        const result = await execRes.json() as { stdout: string; stderr: string; exitCode: number };

        if (result.stdout?.includes('REACHABLE')) {
          const latency = result.stdout.match(/(\d+)ms/)?.[1] ?? 'unknown';
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  reachable: true,
                  from: fromNode,
                  to: toNode,
                  port,
                  latency: `${latency}ms`,
                }, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                reachable: false,
                from: fromNode,
                to: toNode,
                port,
                error: result.stderr || 'Connection refused or timed out',
              }, null, 2),
            },
          ],
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
