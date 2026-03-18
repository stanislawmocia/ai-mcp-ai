import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HubClient } from '../index.js';

export function registerAgentTools(server: McpServer, hub: HubClient) {
  server.tool(
    'spawn_agent',
    'Start a Claude Code or other AI agent on a remote node. Returns a sessionId for tracking.',
    {
      nodeName: z.string().describe('Target node name'),
      tool: z.string().describe('Agent tool to start (e.g., "claude-code", "gemini")'),
      workdir: z.string().describe('Working directory for the agent'),
      context: z.string().optional().describe('Initial context to pass to the agent'),
      systemPrompt: z.string().optional().describe('System prompt for the agent'),
    },
    async ({ nodeName, tool, workdir, context, systemPrompt }) => {
      try {
        // Phase 2 — proxy to node-agent /start-agent
        const node = await hub.fetch(`/nodes/${encodeURIComponent(nodeName)}`);
        if (!node.ok) {
          return {
            content: [
              { type: 'text' as const, text: `Node "${nodeName}" not found or offline` },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Agent orchestration is Phase 2. Tool "${tool}" on "${nodeName}" at "${workdir}" would be started here.`,
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
    'Send a message to a running agent session',
    {
      sessionId: z.string().describe('Agent session ID'),
      message: z.string().describe('Message to send'),
    },
    async ({ sessionId, message }) => {
      return {
        content: [
          { type: 'text' as const, text: `Agent orchestration is Phase 2. Would send "${message}" to session ${sessionId}.` },
        ],
      };
    },
  );

  server.tool(
    'agent_read',
    'Read output from a running agent session',
    {
      sessionId: z.string().describe('Agent session ID'),
    },
    async ({ sessionId }) => {
      return {
        content: [
          { type: 'text' as const, text: `Agent orchestration is Phase 2. Would read from session ${sessionId}.` },
        ],
      };
    },
  );

  server.tool(
    'agent_kill',
    'Kill a running agent session',
    {
      sessionId: z.string().describe('Agent session ID'),
    },
    async ({ sessionId }) => {
      return {
        content: [
          { type: 'text' as const, text: `Agent orchestration is Phase 2. Would kill session ${sessionId}.` },
        ],
      };
    },
  );
}
