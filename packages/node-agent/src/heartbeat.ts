import type { NodeAgentConfig } from './server.js';
import { getHealthInfo, getCapabilities } from './monitor.js';

const HEARTBEAT_INTERVAL = 30_000; // 30s

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function startHeartbeat(config: NodeAgentConfig) {
  // Initial registration
  sendHeartbeat(config);

  // Periodic heartbeat
  heartbeatTimer = setInterval(() => {
    sendHeartbeat(config);
  }, HEARTBEAT_INTERVAL);

  // Don't keep process alive just for heartbeat
  heartbeatTimer.unref();
}

async function sendHeartbeat(config: NodeAgentConfig) {
  try {
    const health = getHealthInfo(config.name);
    const capabilities = getCapabilities();

    const response = await fetch(`${config.hubUrl}/nodes/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        name: config.name,
        port: config.port,
        health,
        capabilities,
      }),
    });

    if (!response.ok) {
      console.error(`[heartbeat] Hub returned ${response.status}: ${response.statusText}`);
    }
  } catch (error) {
    console.error(`[heartbeat] Failed to reach hub at ${config.hubUrl}:`, (error as Error).message);
  }
}

export function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
