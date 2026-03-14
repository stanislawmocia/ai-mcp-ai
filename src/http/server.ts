import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { randomUUID } from "crypto";
import { hostname } from "os";
import { existsSync, readFileSync } from "fs";
import { messages, peers, state } from "../db/index.js";
import { decryptMessage, getPublicKeyBase64 } from "../crypto/index.js";
import { getConfig, getSession } from "../config/index.js";
import { isTailscaleIp } from "../tailscale/index.js";

const IncomingMessageSchema = z.object({
  from: z.string(),
  from_ip: z.string(),
  encrypted_content: z.string(),
  nonce: z.string(),
  public_key: z.string(),
  message_type: z.string().optional().default("message"),
  reply_to_id: z.string().optional(),
  session_id: z.string().optional(),
});

let _startTime = Date.now();

function requireTailscaleIp(request: FastifyRequest, reply: FastifyReply): boolean {
  const sourceIp = request.socket.remoteAddress ?? "";

  // Normalize IPv6 mapped IPv4 addresses
  const normalizedIp = sourceIp.startsWith("::ffff:") ? sourceIp.slice(7) : sourceIp;

  if (!isTailscaleIp(normalizedIp) && normalizedIp !== "127.0.0.1" && normalizedIp !== "::1") {
    reply.code(403).send({ error: "Access denied: only Tailscale IPs allowed", ip: normalizedIp });
    return false;
  }

  return true;
}

export async function startHttpServer(tailscaleIp: string): Promise<void> {
  const config = getConfig();
  const session = getSession();
  const port = config.device.http_port;

  // Determine bind address:
  // 1. Explicit bind_address in config
  // 2. MCP_COMM_BIND_ADDRESS env var (handled in config)
  // 3. "0.0.0.0" if we're in Docker or can't bind to Tailscale IP
  // 4. Tailscale IP
  let bindAddress = config.device.bind_address;
  if (!bindAddress) {
    // In Docker, always bind to 0.0.0.0 (port mapping handles routing)
    const inDocker = process.env.MCP_COMM_DOCKER === "1" || isRunningInDocker();
    bindAddress = inDocker ? "0.0.0.0" : tailscaleIp;
  }

  const fastify = Fastify({
    logger: false,
    trustProxy: false,
  });

  _startTime = Date.now();

  // POST /message - receive encrypted message from peer
  fastify.post("/message", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireTailscaleIp(request, reply)) return;

    const sourceIp = (() => {
      const raw = request.socket.remoteAddress ?? "";
      return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
    })();

    const parsed = IncomingMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "Invalid message format", details: parsed.error.format() });
      return;
    }

    const { from, encrypted_content, nonce, public_key, message_type, reply_to_id, session_id: senderSessionId } = parsed.data;

    let content: string;
    try {
      content = decryptMessage(encrypted_content, nonce, public_key);
    } catch (err) {
      reply.code(400).send({ error: "Decryption failed", details: String(err) });
      return;
    }

    // Auto-save/update peer's public key
    const existingPeer = peers.findByIp(sourceIp) ?? peers.findByAlias(from);
    if (existingPeer) {
      if (!existingPeer.public_key || existingPeer.public_key !== public_key) {
        peers.updatePublicKey(existingPeer.alias, public_key);
      }
      peers.updateLastSeen(existingPeer.alias);
    } else {
      // Auto-register unknown peer
      peers.upsert({
        alias: from,
        tailscale_ip: sourceIp,
        public_key,
        preferred_agent: "claude",
      });
    }

    const msgId = randomUUID();
    messages.insert({
      id: msgId,
      direction: "in",
      from_alias: from,
      from_ip: sourceIp,
      to_alias: session?.session_alias ?? config.device.alias,
      to_ip: tailscaleIp,
      content,
      reply_to_id: reply_to_id ?? null,
      message_type: message_type ?? "message",
      status: "pending",
    });

    // Increment messages_received counter
    const currentCount = parseInt(state.get("messages_received") ?? "0", 10);
    state.set("messages_received", String(currentCount + 1));

    console.error(
      `[http] Received ${message_type} from ${from}${senderSessionId ? `/${senderSessionId}` : ""} (${sourceIp}): ${content.slice(0, 80)}${content.length > 80 ? "..." : ""}`
    );

    reply.code(200).send({
      received: true,
      id: msgId,
      session_id: session?.session_id ?? null,
    });
  });

  // GET /pubkey - return our public key
  fastify.get("/pubkey", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireTailscaleIp(request, reply)) return;

    reply.send({
      public_key: getPublicKeyBase64(),
      alias: config.device.alias,
      session_id: session?.session_id ?? null,
      session_alias: session?.session_alias ?? config.device.alias,
      device: hostname(),
    });
  });

  // GET /health - health check (no auth required)
  fastify.get("/health", async (_request: FastifyRequest, reply: FastifyReply) => {
    const uptimeSeconds = Math.floor((Date.now() - _startTime) / 1000);
    reply.send({
      ok: true,
      alias: config.device.alias,
      session_id: session?.session_id ?? null,
      session_alias: session?.session_alias ?? config.device.alias,
      uptime_seconds: uptimeSeconds,
      unread_count: messages.countUnread(),
    });
  });

  // GET /messages/unread - count unread (Tailscale-only)
  fastify.get("/messages/unread", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireTailscaleIp(request, reply)) return;
    reply.send({
      unread_count: messages.countUnread(),
      session_id: session?.session_id ?? null,
    });
  });

  try {
    await fastify.listen({ port, host: bindAddress });
    console.error(`[http] HTTP server listening on http://${bindAddress}:${port}`);
    if (bindAddress === "0.0.0.0") {
      console.error(`[http] Accessible via Tailscale IP: http://${tailscaleIp}:${port}`);
    }
  } catch (err) {
    // If binding to Tailscale IP fails, try 0.0.0.0
    if (bindAddress !== "0.0.0.0") {
      console.error(`[http] Failed to bind to ${bindAddress}:${port}, trying 0.0.0.0...`);
      try {
        await fastify.listen({ port, host: "0.0.0.0" });
        console.error(`[http] HTTP server listening on http://0.0.0.0:${port} (fallback)`);
        return;
      } catch (fallbackErr) {
        throw new Error(`Failed to start HTTP server on 0.0.0.0:${port}: ${fallbackErr}`);
      }
    }
    throw new Error(`Failed to start HTTP server on ${bindAddress}:${port}: ${err}`);
  }
}

/**
 * Detect if we're running inside a Docker container.
 */
function isRunningInDocker(): boolean {
  try {
    if (existsSync("/.dockerenv")) return true;
    try {
      const cgroup = readFileSync("/proc/1/cgroup", "utf-8");
      return cgroup.includes("docker") || cgroup.includes("containerd") || cgroup.includes("kubepods");
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}
