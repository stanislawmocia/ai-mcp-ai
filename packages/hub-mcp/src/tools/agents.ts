import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HubClient } from '../index.js';

export function registerAgentTools(server: McpServer, hub: HubClient) {
  server.tool(
    'spawn_agent',
    'Start a long-lived process (Claude Code, aider, python, bash, etc.) on a remote node. Returns a sessionId. Use mode "oneshot" for single prompt→response, "interactive" for persistent stdin/stdout session.',
    {
      nodeName: z.string().describe('Target node name'),
      tool: z.string().describe('Tool/command to start (e.g., "claude-code", "aider", "python", "bash")'),
      workdir: z.string().describe('Working directory for the agent'),
      mode: z.enum(['oneshot', 'interactive']).default('oneshot').describe('"oneshot" = single prompt→response, "interactive" = persistent session'),
      prompt: z.string().optional().describe('Prompt to send (oneshot mode — passed as argument to claude --print)'),
      systemPrompt: z.string().optional().describe('System prompt for Claude Code'),
      args: z.array(z.string()).optional().describe('Extra CLI args for the tool'),
      timeoutMs: z.number().optional().describe('Oneshot timeout in ms (default: 300000 = 5min). Ignored for interactive mode.'),
    },
    async ({ nodeName, tool, workdir, mode, prompt, systemPrompt, args, timeoutMs }) => {
      try {
        const res = await hub.fetch('/agents/spawn', {
          method: 'POST',
          body: JSON.stringify({ nodeName, tool, workdir, mode, prompt, systemPrompt, args, timeoutMs }),
        });

        const result = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          return {
            content: [
              { type: 'text' as const, text: `Failed to spawn agent: ${JSON.stringify(result)}` },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                sessionId: result.sessionId,
                pid: result.pid,
                status: result.status,
                mode: result.mode,
                tool: result.tool,
                node: nodeName,
                hint: mode === 'interactive'
                  ? 'Use agent_send to write to stdin, agent_read to check output.'
                  : 'Use agent_read to check output when done.',
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

  server.tool(
    'agent_send',
    'Send a message to a running interactive agent session (writes to stdin)',
    {
      sessionId: z.string().describe('Agent session ID from spawn_agent'),
      message: z.string().describe('Message to write to agent stdin'),
    },
    async ({ sessionId, message }) => {
      try {
        const res = await hub.fetch(`/agents/${encodeURIComponent(sessionId)}/send`, {
          method: 'POST',
          body: JSON.stringify({ message }),
        });

        const result = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          return {
            content: [
              { type: 'text' as const, text: `Failed to send: ${JSON.stringify(result)}` },
            ],
            isError: true,
          };
        }

        return {
          content: [
            { type: 'text' as const, text: `Message sent to ${sessionId}. Use agent_read to check output.` },
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

  server.tool(
    'agent_read',
    'Read output from an agent session. Returns last lines from ring buffer (100 lines max), running status, and exit code.',
    {
      sessionId: z.string().describe('Agent session ID from spawn_agent'),
      offset: z.number().optional().describe('Start reading from this line offset in ring buffer'),
      limit: z.number().optional().describe('Max lines to return (default: all in buffer)'),
    },
    async ({ sessionId, offset, limit }) => {
      try {
        const qs = new URLSearchParams();
        if (offset !== undefined) qs.set('offset', String(offset));
        if (limit !== undefined) qs.set('limit', String(limit));
        const qsStr = qs.toString() ? `?${qs.toString()}` : '';

        const res = await hub.fetch(`/agents/${encodeURIComponent(sessionId)}/read${qsStr}`);
        const result = await res.json() as {
          lines?: string[];
          total?: number;
          isRunning?: boolean;
          status?: string;
          exitCode?: number | null;
          nodeName?: string;
          error?: string;
        };

        if (!res.ok) {
          return {
            content: [
              { type: 'text' as const, text: `Failed to read: ${JSON.stringify(result)}` },
            ],
            isError: true,
          };
        }

        const parts: string[] = [];
        parts.push(`[${sessionId}] Status: ${result.status} | Running: ${result.isRunning} | Node: ${result.nodeName}`);
        if (result.exitCode !== null && result.exitCode !== undefined) {
          parts.push(`Exit code: ${result.exitCode}`);
        }
        parts.push(`Lines in buffer: ${result.total}`);
        if (result.lines && result.lines.length > 0) {
          parts.push('--- output ---');
          parts.push(result.lines.join('\n'));
        } else {
          parts.push('(no output yet)');
        }

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

  server.tool(
    'agent_kill',
    'Kill a running agent session (sends SIGTERM, then SIGKILL after 5s)',
    {
      sessionId: z.string().describe('Agent session ID to kill'),
    },
    async ({ sessionId }) => {
      try {
        const res = await hub.fetch(`/agents/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
        });

        const result = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          return {
            content: [
              { type: 'text' as const, text: `Failed to kill: ${JSON.stringify(result)}` },
            ],
            isError: true,
          };
        }

        return {
          content: [
            { type: 'text' as const, text: `Agent ${sessionId} kill signal sent.` },
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

  // Bonus: list all agents across all nodes
  server.tool(
    'list_agents',
    'List all running and completed agent sessions across all mesh nodes',
    {},
    async () => {
      try {
        const res = await hub.fetch('/agents');
        const agents = await res.json();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(agents, null, 2) }],
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
