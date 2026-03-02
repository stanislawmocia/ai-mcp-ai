import { z } from "zod";
import { sendMessage } from "./send_message.js";
import { waitForReply } from "./wait_for_reply.js";

export const requestApprovalSchema = z.object({
  to: z.string().describe("Device alias or Tailscale IP of the approver"),
  action: z.string().describe("Action that needs approval (be specific and clear)"),
  context: z.string().optional().describe("Additional context or reasoning for the action"),
  timeout_seconds: z.number().optional().describe("How long to wait for approval (default: 120s)"),
});

const APPROVAL_KEYWORDS = ["yes", "approve", "approved", "ok", "proceed", "go", "tak", "zgoda"];
const DENIAL_KEYWORDS = ["no", "deny", "denied", "reject", "rejected", "stop", "abort", "nie", "odmawiam"];

function parseApprovalResponse(response: string): { approved: boolean; ambiguous: boolean } {
  const lower = response.toLowerCase().trim();

  for (const keyword of APPROVAL_KEYWORDS) {
    if (lower.includes(keyword)) {
      return { approved: true, ambiguous: false };
    }
  }

  for (const keyword of DENIAL_KEYWORDS) {
    if (lower.includes(keyword)) {
      return { approved: false, ambiguous: false };
    }
  }

  return { approved: false, ambiguous: true };
}

export async function requestApproval(
  args: z.infer<typeof requestApprovalSchema>
): Promise<string> {
  const { to, action, context, timeout_seconds } = args;

  const messageLines = [
    `[APPROVAL REQUEST]`,
    ``,
    `Action: ${action}`,
  ];

  if (context) {
    messageLines.push(``, `Context: ${context}`);
  }

  messageLines.push(
    ``,
    `Reply with:`,
    `  "approve" or "yes" - to allow the action`,
    `  "deny" or "no" - to reject the action`,
    ``,
    `Timeout: ${timeout_seconds}s`
  );

  const approvalMessage = messageLines.join("\n");

  console.error(`[approval] Sending approval request to ${to} for: ${action.slice(0, 80)}`);

  // Send approval request
  const sendResult = JSON.parse(
    await sendMessage({
      to,
      message: approvalMessage,
      message_type: "approval_request",
    })
  ) as { message_id: string; to: string };

  console.error(`[approval] Waiting up to ${timeout_seconds}s for response...`);

  // Wait for response
  const reply = JSON.parse(
    await waitForReply({
      message_id: sendResult.message_id,
      from_device: to,
      timeout_seconds: timeout_seconds ?? 120,
      message_type: "any",
    })
  ) as {
    timeout: boolean;
    message?: string;
    id?: string;
    from?: string;
    waited_seconds?: number;
  };

  if (reply.timeout) {
    return JSON.stringify({
      approved: false,
      timeout: true,
      action,
      to,
      message: `No approval response from ${to} within ${timeout_seconds}s. Action BLOCKED by timeout.`,
    });
  }

  const { approved, ambiguous } = parseApprovalResponse(reply.message ?? "");

  if (ambiguous) {
    return JSON.stringify({
      approved: false,
      timeout: false,
      ambiguous: true,
      action,
      to,
      response: reply.message,
      message:
        `Response from ${to} was ambiguous: "${reply.message}". ` +
        `Action BLOCKED. Ask for explicit "approve" or "deny".`,
    });
  }

  console.error(`[approval] Decision from ${to}: ${approved ? "APPROVED" : "DENIED"}`);

  return JSON.stringify({
    approved,
    timeout: false,
    ambiguous: false,
    action,
    to,
    responded_by: reply.from ?? to,
    response: reply.message,
    waited_seconds: reply.waited_seconds,
    message: approved
      ? `Action APPROVED by ${reply.from ?? to}`
      : `Action DENIED by ${reply.from ?? to}`,
  });
}
