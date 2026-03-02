import { z } from "zod";
import { sendMessage } from "./send_message.js";
import { waitForReply } from "./wait_for_reply.js";

export const pingWithMessageSchema = z.object({
  to: z.string().describe("Device alias or Tailscale IP"),
  message: z.string().describe("Message to send"),
  timeout_seconds: z.number().optional().describe("Wait timeout in seconds (default: 60)"),
});

export async function pingWithMessage(args: z.infer<typeof pingWithMessageSchema>): Promise<string> {
  const { to, message, timeout_seconds } = args;

  // Send message
  const sendResult = JSON.parse(await sendMessage({ to, message })) as {
    message_id: string;
    status: string;
    to: string;
    ip: string;
  };

  console.error(`[ping] Sent message to ${to}, waiting for reply...`);

  // Wait for reply
  const reply = JSON.parse(
    await waitForReply({
      message_id: sendResult.message_id,
      from_device: to,
      timeout_seconds: timeout_seconds ?? 60,
    })
  ) as { timeout: boolean; message?: string; from?: string; waited_seconds?: number };

  if (reply.timeout) {
    return JSON.stringify({
      success: false,
      timeout: true,
      sent_message_id: sendResult.message_id,
      to: sendResult.to,
      message: `No reply from ${to} within ${timeout_seconds}s. Device may be busy or offline.`,
    });
  }

  return JSON.stringify({
    success: true,
    timeout: false,
    sent_message_id: sendResult.message_id,
    to: sendResult.to,
    reply,
  });
}
