import { z } from "zod";
import { messages, state } from "../../db/index.js";
import { getConfig } from "../../config/index.js";
import { sendMessage } from "./send_message.js";

export const startListenerSchema = z.object({
  auto_reply: z.boolean().optional().describe("Auto-reply to messages (default: false)"),
  auto_reply_prompt: z.string().optional().describe("Prompt context for auto-replies"),
  interval_ms: z.number().optional().describe("Polling interval in ms (overrides config)"),
});

let _listenerInterval: ReturnType<typeof setInterval> | null = null;
let _messagesReceivedSinceStart = 0;
let _listenerStartTime: Date | null = null;

export function isListenerActive(): boolean {
  return _listenerInterval !== null;
}

export function getListenerStats(): { messages_received: number; start_time: string | null } {
  return {
    messages_received: _messagesReceivedSinceStart,
    start_time: _listenerStartTime?.toISOString() ?? null,
  };
}

export async function startListener(args: z.infer<typeof startListenerSchema>): Promise<string> {
  const config = getConfig();

  if (_listenerInterval) {
    return JSON.stringify({
      started: false,
      already_active: true,
      message: "Listener is already running. Use stop_listener first.",
    });
  }

  const interval = args.interval_ms ?? config.listener.poll_interval_ms;
  const autoReply = args.auto_reply ?? config.listener.auto_reply;
  const autoReplyPrompt = args.auto_reply_prompt ?? config.listener.auto_reply_prompt;

  _messagesReceivedSinceStart = 0;
  _listenerStartTime = new Date();

  state.set("listener_active", "true");
  state.set("listener_start_time", _listenerStartTime.toISOString());
  state.set("messages_received", "0");

  _listenerInterval = setInterval(async () => {
    const newMessages = messages.findIncoming({
      unread_only: true,
      limit: 50,
    });

    if (newMessages.length === 0) return;

    _messagesReceivedSinceStart += newMessages.length;
    state.set("messages_received", String(_messagesReceivedSinceStart));

    for (const msg of newMessages) {
      messages.markAsRead(msg.id);

      console.error(
        `[listener] New message from ${msg.from_alias ?? msg.from_ip}: ${msg.content.slice(0, 100)}`
      );

      if (autoReply && msg.from_alias) {
        const replyContent = autoReplyPrompt
          ? `[Auto-reply]\nContext: ${autoReplyPrompt}\nResponding to: ${msg.content}`
          : `[Auto-reply] Message received: "${msg.content.slice(0, 100)}${msg.content.length > 100 ? "..." : ""}"`;

        try {
          await sendMessage({
            to: msg.from_alias,
            message: replyContent,
            reply_to_id: msg.id,
          });
          console.error(`[listener] Auto-replied to ${msg.from_alias}`);
        } catch (err) {
          console.error(`[listener] Auto-reply failed: ${err}`);
        }
      }
    }
  }, interval);

  console.error(
    `[listener] Started polling every ${interval}ms, auto_reply=${autoReply}`
  );

  return JSON.stringify({
    started: true,
    interval_ms: interval,
    auto_reply: autoReply,
    auto_reply_prompt: autoReplyPrompt || null,
    started_at: _listenerStartTime.toISOString(),
  });
}

export async function stopListener(): Promise<string> {
  if (!_listenerInterval) {
    return JSON.stringify({
      stopped: false,
      message: "Listener was not running",
    });
  }

  clearInterval(_listenerInterval);
  _listenerInterval = null;

  state.set("listener_active", "false");

  const stats = {
    stopped: true,
    messages_received_since_start: _messagesReceivedSinceStart,
    was_running_since: _listenerStartTime?.toISOString() ?? null,
  };

  _listenerStartTime = null;
  _messagesReceivedSinceStart = 0;

  console.error(`[listener] Stopped`);

  return JSON.stringify(stats);
}
