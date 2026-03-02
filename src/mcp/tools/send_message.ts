import { z } from "zod";
import { randomUUID } from "crypto";
import { messages, peers } from "../../db/index.js";
import { encryptMessage, getPublicKeyBase64 } from "../../crypto/index.js";
import { getConfig } from "../../config/index.js";
import { resolveDeviceIp } from "../../tailscale/index.js";

export const sendMessageSchema = z.object({
  to: z.string().describe("Device alias or Tailscale IP"),
  message: z.string().describe("Message text to send"),
  reply_to_id: z.string().optional().describe("ID of message being replied to"),
  message_type: z
    .enum(["message", "approval_request", "approval_response"])
    .optional()
    .describe("Type of message (default: message)"),
});

async function fetchPubkey(ip: string, port: number, alias: string): Promise<string> {
  const url = `http://${ip}:${port}/pubkey`;
  console.error(`[send] Fetching pubkey from ${url}...`);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch pubkey from ${alias} (${ip}): HTTP ${response.status}`);
  }

  const data = (await response.json()) as { public_key: string; alias: string };
  return data.public_key;
}

export async function sendMessage(args: z.infer<typeof sendMessageSchema>): Promise<string> {
  const config = getConfig();
  const { to, message, reply_to_id, message_type } = args;

  // Resolve device
  const ip = await resolveDeviceIp(to, config.peers);
  const port = config.device.http_port;

  // Find or create peer record
  let peer = peers.findByAlias(to) ?? peers.findByIp(ip);
  const peerAlias = peer?.alias ?? to;

  // Get recipient's public key
  let recipientPublicKey = peer?.public_key ?? "";

  if (!recipientPublicKey) {
    recipientPublicKey = await fetchPubkey(ip, port, peerAlias);

    // Save to DB
    if (peer) {
      peers.updatePublicKey(peerAlias, recipientPublicKey);
    } else {
      peers.upsert({
        alias: peerAlias,
        tailscale_ip: ip,
        public_key: recipientPublicKey,
      });
    }
    console.error(`[send] Cached pubkey for ${peerAlias}`);
  }

  // Encrypt
  const { encryptedContent, nonce } = encryptMessage(message, recipientPublicKey);

  // Send
  const body = {
    from: config.device.alias,
    from_ip: "", // server will use actual source IP
    encrypted_content: encryptedContent,
    nonce,
    public_key: getPublicKeyBase64(),
    message_type: message_type ?? "message",
    reply_to_id: reply_to_id,
  };

  let response: Response;
  try {
    response = await fetch(`http://${ip}:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to reach ${peerAlias} (${ip}:${port}): ${errMsg}. ` +
      `Is the device online? Try using wake_device tool first.`
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Server returned ${response.status}: ${text}`);
  }

  const result = (await response.json()) as { received: boolean; id: string };

  // Save to our DB
  const msgId = randomUUID();
  messages.insert({
    id: msgId,
    direction: "out",
    from_alias: config.device.alias,
    from_ip: null,
    to_alias: peerAlias,
    to_ip: ip,
    content: message,
    reply_to_id: reply_to_id ?? null,
    message_type: message_type ?? "message",
    status: "sent",
  });

  console.error(`[send] Message sent to ${peerAlias} (remote id: ${result.id})`);

  return JSON.stringify({
    message_id: msgId,
    remote_id: result.id,
    status: "sent",
    to: peerAlias,
    ip,
  });
}
