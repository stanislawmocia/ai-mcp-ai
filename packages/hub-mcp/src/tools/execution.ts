import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HubClient } from '../index.js';

export function registerExecutionTools(server: McpServer, hub: HubClient) {
  server.tool(
    'exec_on',
    'Execute a command on a remote node. Returns stdout, stderr, exit code, and duration. Shell operators (;|&) are blocked — use separate calls instead of chaining.',
    {
      nodeName: z.string().describe('Target node name'),
      command: z.string().describe('Command to execute (no shell operators like ;|&)'),
      workdir: z.string().optional().describe('Working directory on the remote node'),
      timeout: z.number().optional().describe('Timeout in milliseconds (max 300000)'),
    },
    async ({ nodeName, command, workdir, timeout }) => {
      try {
        const res = await hub.fetch('/exec', {
          method: 'POST',
          body: JSON.stringify({
            nodeName,
            cmd: command,
            workdir,
            timeout,
          }),
        });

        const result = await res.json() as {
          stdout?: string;
          stderr?: string;
          exitCode?: number;
          duration?: number;
          error?: string;
        };

        if (!res.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error executing on "${nodeName}": ${JSON.stringify(result)}`,
              },
            ],
            isError: true,
          };
        }

        // Format output nicely
        const parts: string[] = [];
        parts.push(`[${nodeName}] Exit code: ${result.exitCode} (${result.duration}ms)`);
        if (result.stdout) parts.push(`--- stdout ---\n${result.stdout}`);
        if (result.stderr) parts.push(`--- stderr ---\n${result.stderr}`);

        return {
          content: [{ type: 'text' as const, text: parts.join('\n') }],
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
