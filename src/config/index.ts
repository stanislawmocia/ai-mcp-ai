import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir, hostname } from "os";
import { randomBytes } from "crypto";
import { z } from "zod";

const AgentConfigSchema = z.object({
  enabled: z.boolean().default(false),
  command: z.string().default(""),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
});

const PeerConfigSchema = z.object({
  tailscale_ip: z.string(),
  alias: z.string(),
  public_key: z.string().default(""),
  mac_address: z.string().default(""),
  preferred_agent: z.enum(["claude", "gemini", "custom"]).default("claude"),
  ssh_user: z.string().default(""),
  auto_wake: z.boolean().default(false),
});

const ConfigSchema = z.object({
  device: z.object({
    alias: z.string().default(""),
    http_port: z.number().default(7432),
    db_path: z.string().default("./comm.db"),
    ssh_user: z.string().default(""),
    ssh_key_path: z.string().default("~/.ssh/id_ed25519"),
    bind_address: z.string().default("").describe("Address to bind HTTP server to. Empty = auto-detect"),
  }),
  listener: z.object({
    enabled: z.boolean().default(true),
    poll_interval_ms: z.number().default(2000),
    auto_reply: z.boolean().default(false),
    auto_reply_prompt: z.string().default(""),
  }),
  wake: z.object({
    wol_enabled: z.boolean().default(false),
    wol_broadcast: z.string().default("255.255.255.255"),
    ssh_enabled: z.boolean().default(true),
    ssh_startup_wait_seconds: z.number().default(10),
  }),
  agents: z.object({
    claude: AgentConfigSchema.default({}),
    gemini: AgentConfigSchema.default({}),
    custom: AgentConfigSchema.default({}),
  }),
  peers: z.record(PeerConfigSchema).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type PeerConfig = z.infer<typeof PeerConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * Session identity — unique per running MCP instance.
 * Allows multiple MCP sessions on the same device to be addressable individually.
 */
export interface SessionInfo {
  /** Short unique ID for this session, e.g. "a3f1" */
  session_id: string;
  /** Full session alias: "{device_alias}/{session_id}", e.g. "macbook-stan/a3f1" */
  session_alias: string;
  /** Port this session's HTTP server is bound to */
  port: number;
}

let _sessionInfo: SessionInfo | null = null;

function generateSessionId(): string {
  // Use env var if set (for deterministic IDs in Docker), else random 4-hex
  if (process.env.MCP_COMM_SESSION_ID) {
    return process.env.MCP_COMM_SESSION_ID;
  }
  return randomBytes(2).toString("hex");
}

export function initSession(alias: string, port: number): SessionInfo {
  const sessionId = generateSessionId();
  _sessionInfo = {
    session_id: sessionId,
    session_alias: `${alias}/${sessionId}`,
    port,
  };
  return _sessionInfo;
}

export function getSession(): SessionInfo | null {
  return _sessionInfo;
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return resolve(p);
}

function loadConfig(): Config {
  const configPath = process.env.MCP_COMM_CONFIG || join(process.cwd(), "config.json");

  let rawConfig: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      rawConfig = JSON.parse(content);
    } catch (err) {
      console.error(`[config] Failed to parse config.json: ${err}`);
    }
  } else {
    console.warn(`[config] No config.json found at ${configPath}, using defaults`);
  }

  // Environment variable overrides
  if (process.env.MCP_COMM_ALIAS) {
    (rawConfig.device as Record<string, unknown> | undefined) = {
      ...(rawConfig.device as Record<string, unknown> | undefined ?? {}),
      alias: process.env.MCP_COMM_ALIAS,
    };
  }
  if (process.env.MCP_COMM_PORT) {
    (rawConfig.device as Record<string, unknown> | undefined) = {
      ...(rawConfig.device as Record<string, unknown> | undefined ?? {}),
      http_port: parseInt(process.env.MCP_COMM_PORT, 10),
    };
  }
  if (process.env.MCP_COMM_DB_PATH) {
    (rawConfig.device as Record<string, unknown> | undefined) = {
      ...(rawConfig.device as Record<string, unknown> | undefined ?? {}),
      db_path: process.env.MCP_COMM_DB_PATH,
    };
  }
  if (process.env.MCP_COMM_BIND_ADDRESS) {
    (rawConfig.device as Record<string, unknown> | undefined) = {
      ...(rawConfig.device as Record<string, unknown> | undefined ?? {}),
      bind_address: process.env.MCP_COMM_BIND_ADDRESS,
    };
  }

  const parsed = ConfigSchema.parse(rawConfig);

  // Expand ~ paths
  parsed.device.db_path = expandPath(parsed.device.db_path);
  parsed.device.ssh_key_path = expandPath(parsed.device.ssh_key_path);

  // Default alias to hostname
  if (!parsed.device.alias) {
    parsed.device.alias = hostname();
  }

  return parsed;
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

export function reloadConfig(): Config {
  _config = null;
  return getConfig();
}
