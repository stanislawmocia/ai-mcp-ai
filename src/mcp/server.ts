import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { listDevices, listDevicesSchema } from "./tools/list_devices.js";
import { sendMessage, sendMessageSchema } from "./tools/send_message.js";
import { readMessages, readMessagesSchema } from "./tools/read_messages.js";
import { waitForReply, waitForReplySchema } from "./tools/wait_for_reply.js";
import { pingWithMessage, pingWithMessageSchema } from "./tools/ping_with_message.js";
import { wakeDevice, wakeDeviceSchema } from "./tools/wake_device.js";
import { startListener, startListenerSchema } from "./tools/start_listener.js";
import { stopListener, stopListenerSchema } from "./tools/stop_listener.js";
import { getStatus, getStatusSchema } from "./tools/get_status.js";
import { replyTo, replyToSchema } from "./tools/reply_to.js";
import { requestApproval, requestApprovalSchema } from "./tools/request_approval.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  handler: ToolHandler;
}

const tools: ToolDefinition[] = [
  {
    name: "list_devices",
    description:
      "List all devices in the Tailscale network with their status (online/offline). " +
      "Shows which devices have configured peers.",
    schema: listDevicesSchema,
    handler: (args) => listDevices(listDevicesSchema.parse(args)),
  },
  {
    name: "send_message",
    description:
      "Send an encrypted message to another device/AI on the Tailscale network. " +
      "Automatically fetches the recipient's public key on first contact.",
    schema: sendMessageSchema,
    handler: (args) => sendMessage(sendMessageSchema.parse(args)),
  },
  {
    name: "read_messages",
    description:
      "Read incoming messages from other devices/AIs. " +
      "By default returns unread messages and marks them as read.",
    schema: readMessagesSchema,
    handler: (args) => readMessages(readMessagesSchema.parse(args)),
  },
  {
    name: "wait_for_reply",
    description:
      "Wait (poll) for a reply to a specific message or any new message. " +
      "Blocks until a reply arrives or timeout expires.",
    schema: waitForReplySchema,
    handler: (args) => waitForReply(waitForReplySchema.parse(args)),
  },
  {
    name: "ping_with_message",
    description:
      "Atomic send + wait_for_reply. Send a message and wait for response in one call. " +
      "Returns the reply or a timeout.",
    schema: pingWithMessageSchema,
    handler: (args) => pingWithMessage(pingWithMessageSchema.parse(args)),
  },
  {
    name: "wake_device",
    description:
      "Wake a remote device (WoL or SSH) and optionally start an AI agent on it. " +
      "Use when a device is offline before sending messages.",
    schema: wakeDeviceSchema,
    handler: (args) => wakeDevice(wakeDeviceSchema.parse(args)),
  },
  {
    name: "start_listener",
    description:
      "Start background polling for incoming messages. " +
      "Optionally enables auto-reply with a custom prompt.",
    schema: startListenerSchema,
    handler: (args) => startListener(startListenerSchema.parse(args)),
  },
  {
    name: "stop_listener",
    description:
      "Stop the background message listener. Returns stats about messages received.",
    schema: stopListenerSchema,
    handler: (args) => stopListener(stopListenerSchema.parse(args)),
  },
  {
    name: "get_status",
    description:
      "Get current status: alias, IP, public key, unread count, listener state, and connected peers.",
    schema: getStatusSchema,
    handler: (args) => getStatus(getStatusSchema.parse(args)),
  },
  {
    name: "reply_to",
    description:
      "Reply to a specific incoming message by its ID. " +
      "Automatically finds the sender and sends an encrypted reply.",
    schema: replyToSchema,
    handler: (args) => replyTo(replyToSchema.parse(args)),
  },
  {
    name: "request_approval",
    description:
      "Request explicit approval from a remote device/human for an action. " +
      "Sends a structured approval request and waits for 'approve'/'deny' response. " +
      "Use before performing risky or irreversible operations on remote systems. " +
      "Returns {approved: bool, timeout: bool, response: string}.",
    schema: requestApprovalSchema,
    handler: (args) => requestApproval(requestApprovalSchema.parse(args)),
  },
];

function zodSchemaToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    const zodField = field as z.ZodTypeAny;
    properties[key] = zodTypeToJsonSchema(zodField);

    // Check if required (not optional, not has default)
    if (!(zodField instanceof z.ZodOptional) && !(zodField instanceof z.ZodDefault)) {
      required.push(key);
    }
  }

  const result: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) {
    result.required = required;
  }
  return result;
}

function zodTypeToJsonSchema(zodType: z.ZodTypeAny): Record<string, unknown> {
  // Unwrap Optional and Default
  if (zodType instanceof z.ZodOptional) {
    return zodTypeToJsonSchema(zodType.unwrap());
  }
  if (zodType instanceof z.ZodDefault) {
    const inner = zodTypeToJsonSchema(zodType._def.innerType);
    inner.default = zodType._def.defaultValue();
    return inner;
  }

  const description = zodType.description;
  const base: Record<string, unknown> = {};
  if (description) base.description = description;

  if (zodType instanceof z.ZodString) return { ...base, type: "string" };
  if (zodType instanceof z.ZodNumber) return { ...base, type: "number" };
  if (zodType instanceof z.ZodBoolean) return { ...base, type: "boolean" };
  if (zodType instanceof z.ZodEnum) {
    return { ...base, type: "string", enum: zodType.options };
  }
  if (zodType instanceof z.ZodObject) {
    return zodSchemaToJsonSchema(zodType);
  }

  return { ...base, type: "string" };
}

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: "mcp-ai-comm", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
        logging: {},
      },
    }
  );

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodSchemaToJsonSchema(t.schema),
    })),
  }));

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const result = await tool.handler((args ?? {}) as Record<string, unknown>);
      return {
        content: [{ type: "text", text: result }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[mcp] Tool ${name} error: ${message}`);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[mcp] MCP server connected via stdio");
}
