import { z } from "zod";
import { messages } from "../../db/index.js";
import { sendMessage } from "./send_message.js";

export const replyToSchema = z.object({
  message_id: z.string().describe("ID of the message to reply to"),
  reply: z.string().describe("Reply text"),
});

export async function replyTo(args: z.infer<typeof replyToSchema>): Promise<string> {
  const { message_id, reply } = args;

  const originalMessage = messages.findById(message_id);
  if (!originalMessage) {
    throw new Error(`Message ${message_id} not found in database`);
  }

  if (originalMessage.direction !== "in") {
    throw new Error(`Message ${message_id} is an outgoing message - can only reply to incoming messages`);
  }

  const to = originalMessage.from_alias ?? originalMessage.from_ip;
  if (!to) {
    throw new Error(`Cannot determine sender of message ${message_id}`);
  }

  const result = await sendMessage({
    to,
    message: reply,
    reply_to_id: message_id,
  });

  return JSON.stringify({
    sent: true,
    ...JSON.parse(result),
    replied_to: message_id,
    original_from: to,
  });
}
