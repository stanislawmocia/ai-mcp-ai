import { z } from "zod";
import { messages } from "../../db/index.js";

export const readMessagesSchema = z.object({
  from: z.string().optional().describe("Filter by sender alias"),
  unread_only: z.boolean().optional().describe("Show only unread messages (default: true)"),
  limit: z.number().optional().describe("Max messages to return (default: 20)"),
  mark_as_read: z.boolean().optional().describe("Mark returned messages as read (default: true)"),
  message_type: z
    .enum(["message", "approval_request", "approval_response", "all"])
    .optional()
    .describe("Filter by message type (default: all)"),
});

export async function readMessages(args: z.infer<typeof readMessagesSchema>): Promise<string> {
  const { from, unread_only, limit, mark_as_read, message_type } = args;

  const typeFilter = message_type === "all" ? undefined : message_type;

  const msgs = messages.findIncoming({
    from,
    unread_only: unread_only ?? true,
    limit: limit ?? 20,
    message_type: typeFilter,
  });

  if (mark_as_read) {
    for (const msg of msgs) {
      messages.markAsRead(msg.id);
    }
  }

  const formatted = msgs.map((m) => ({
    id: m.id,
    from: m.from_alias ?? m.from_ip ?? "unknown",
    message: m.content,
    message_type: m.message_type,
    timestamp: m.created_at,
    replied: false, // TODO: check for replies
    status: m.status,
    reply_to_id: m.reply_to_id,
  }));

  const unreadCount = messages.countUnread();

  return JSON.stringify(
    {
      messages: formatted,
      count: formatted.length,
      unread_remaining: unreadCount,
    },
    null,
    2
  );
}
