import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HubClient } from '../index.js';

export function registerContextTools(server: McpServer, hub: HubClient) {
  server.tool(
    'set_context',
    'Store shared context data in the hub. Data persists across sessions and can be shared with specific nodes.',
    {
      key: z.string().describe('Context key'),
      data: z.any().describe('Data to store (any JSON-serializable value)'),
      sharedWith: z.array(z.string()).optional().describe('Node names that can access this context'),
      ttlHours: z.number().optional().describe('Time-to-live in hours (default: no expiry)'),
    },
    async ({ key, data, sharedWith, ttlHours }) => {
      try {
        const res = await hub.fetch('/context', {
          method: 'POST',
          body: JSON.stringify({ key, data, sharedWith, ttlHours }),
        });

        if (!res.ok) {
          const err = await res.json();
          return {
            content: [
              { type: 'text' as const, text: `Error storing context: ${JSON.stringify(err)}` },
            ],
            isError: true,
          };
        }

        return {
          content: [
            { type: 'text' as const, text: `Context "${key}" stored successfully.` },
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
    'get_context',
    'Retrieve shared context data from the hub by key',
    {
      key: z.string().describe('Context key to retrieve'),
    },
    async ({ key }) => {
      try {
        const res = await hub.fetch(`/context/${encodeURIComponent(key)}`);

        if (!res.ok) {
          return {
            content: [
              { type: 'text' as const, text: `Context "${key}" not found or expired.` },
            ],
            isError: true,
          };
        }

        const entry = await res.json();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(entry, null, 2) }],
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
