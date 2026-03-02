import { initDb, closeDb } from "./db/index.js";
import { initCrypto } from "./crypto/index.js";
import { startHttpServer } from "./http/server.js";
import { startMcpServer } from "./mcp/server.js";
import { getConfig } from "./config/index.js";
import { getMyTailscaleIp } from "./tailscale/index.js";
import { peers } from "./db/index.js";

async function main(): Promise<void> {
  const config = getConfig();

  // Init database
  initDb(config.device.db_path);
  console.error(`[main] Database initialized at ${config.device.db_path}`);

  // Init crypto (requires MCP_COMM_KEY_PASSPHRASE)
  await initCrypto();
  console.error("[main] Crypto initialized");

  // Seed peers from config.json
  for (const [alias, peerConfig] of Object.entries(config.peers)) {
    peers.upsert({
      alias,
      tailscale_ip: peerConfig.tailscale_ip,
      public_key: peerConfig.public_key ?? "",
      mac_address: peerConfig.mac_address ?? "",
      preferred_agent: peerConfig.preferred_agent ?? "claude",
      ssh_user: peerConfig.ssh_user ?? "",
      auto_wake: peerConfig.auto_wake ? 1 : 0,
    });
  }

  // Get Tailscale IP for HTTP server binding
  let tailscaleIp: string;
  try {
    tailscaleIp = await getMyTailscaleIp();
    console.error(`[main] Tailscale IP: ${tailscaleIp}`);
  } catch (err) {
    console.error(`[main] WARNING: ${err}`);
    console.error("[main] Falling back to 127.0.0.1 - HTTP server will only be accessible locally");
    tailscaleIp = "127.0.0.1";
  }

  // Start HTTP server (non-blocking)
  await startHttpServer(tailscaleIp);

  // Graceful shutdown
  function shutdown(signal: string): void {
    console.error(`[main] Received ${signal}, shutting down...`);
    closeDb();
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Start MCP server (blocks - stdio)
  console.error(`[main] Starting MCP server (alias: ${config.device.alias}, port: ${config.device.http_port})`);
  await startMcpServer();
}

main().catch((err) => {
  console.error("[main] Fatal error:", err);
  process.exit(1);
});
