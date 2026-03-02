import { z } from "zod";
import { messages } from "../../db/index.js";
import { getConfig } from "../../config/index.js";

export const waitForReplySchema = z.object({
  message_id: z.string().optional().describe("Wait for reply to this message ID"),
  from_device: z.string().optional().describe("Wait for message from this device alias"),
  timeout_seconds: z.number().optional().default(60).describe("Max wait time in seconds"),
  message_type: z
    .enum(["message", "approval_request", "approval_response", "any"])
    .optional()
    .describe("Type of message to wait for (default: any)"),
});

export async function waitForReply(args: z.infer<typeof waitForReplySchema>): Promise<string> {
  const config = getConfig();
  const { message_id, from_device, timeout_seconds, message_type } = args;

  const pollInterval = config.listener.poll_interval_ms;
  const timeoutMs = (timeout_seconds ?? 60) * 1000;
  const startTime = Date.now();

  console.error(
    `[wait] Waiting for ${message_id ? `reply to ${message_id.slice(0, 8)}...` : "any message"} ` +
    `from ${from_device ?? "any"} (timeout: ${timeout_seconds}s)`
  );

  while (Date.now() - startTime < timeoutMs) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    // Check for replies
    let found = null;

    if (message_id) {
      const replies = messages.findReplies(message_id);
      if (replies.length > 0) {
        found = replies[0];
      }
    }

    if (!found && from_device) {
      const incoming = messages.findIncoming({
        from: from_device,
        unread_only: true,
        limit: 1,
        message_type: message_type !== "any" ? message_type : undefined,
      });
      if (incoming.length > 0) {
        found = incoming[0];
      }
    }

    if (!found && !message_id && !from_device) {
      const incoming = messages.findIncoming({
        unread_only: true,
        limit: 1,
        message_type: message_type !== "any" ? message_type : undefined,
      });
      if (incoming.length > 0) {
        found = incoming[0];
      }
    }

    if (found) {
      messages.markAsRead(found.id);
      console.error(`[wait] Got reply after ${elapsed}s`);
      return JSON.stringify({
        timeout: false,
        id: found.id,
        from: found.from_alias ?? found.from_ip ?? "unknown",
        message: found.content,
        message_type: found.message_type,
        timestamp: found.created_at,
        reply_to_id: found.reply_to_id,
        waited_seconds: elapsed,
      });
    }

    // Log progress every 10 seconds
    if (elapsed > 0 && elapsed % 10 === 0) {
      console.error(`[wait] Still waiting... ${elapsed}s / ${timeout_seconds}s`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return JSON.stringify({
    timeout: true,
    waited_seconds: timeout_seconds,
    message: `No reply received within ${timeout_seconds} seconds`,
  });
}
