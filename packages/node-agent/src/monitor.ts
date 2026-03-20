import os from 'node:os';
import { execSync } from 'node:child_process';

export interface HealthInfo {
  name: string;
  os: string;
  platform: string;
  arch: string;
  cpu: string;
  cpuCount: number;
  ramTotal: string;
  ramFree: string;
  uptime: number;
  version: string;
  timestamp: string;
}

export interface Capabilities {
  hasGpu: boolean;
  tools: string[];
  runningAgents: string[];
}

// Optional callback to get running agent IDs from AgentManager
let getRunningAgentIds: (() => string[]) | null = null;

export function setAgentProvider(fn: () => string[]) {
  getRunningAgentIds = fn;
}

export function getHealthInfo(name: string): HealthInfo {
  return {
    name,
    os: os.type(),
    platform: os.platform(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    ramTotal: `${Math.round(os.totalmem() / 1024 / 1024)}MB`,
    ramFree: `${Math.round(os.freemem() / 1024 / 1024)}MB`,
    uptime: os.uptime(),
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  };
}

function commandExists(cmd: string): boolean {
  // Validate command name to prevent injection via toolChecks array
  if (!/^[a-zA-Z0-9_-]+$/.test(cmd)) return false;
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function detectGpu(): boolean {
  try {
    execSync('nvidia-smi', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getCapabilities(): Capabilities {
  const toolChecks = ['claude', 'git', 'docker', 'node', 'python3', 'go', 'cargo', 'bun'];
  const tools = toolChecks.filter(commandExists);

  return {
    hasGpu: detectGpu(),
    tools,
    runningAgents: getRunningAgentIds ? getRunningAgentIds() : [],
  };
}
