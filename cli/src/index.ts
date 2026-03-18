#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();

const HUB_URL = process.env.HUB_URL ?? 'http://localhost:7433';
const HUB_TOKEN = process.env.HUB_TOKEN ?? '';

async function hubFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${HUB_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${HUB_TOKEN}`,
      ...opts.headers,
    },
  });
}

program
  .name('hub')
  .description('MeshMind Hub CLI')
  .version('1.0.0');

// hub status
program
  .command('status')
  .description('Show all nodes and their status')
  .action(async () => {
    try {
      const res = await hubFetch('/nodes');
      const nodes = await res.json() as Array<{
        name: string;
        status: string;
        tailscaleIp: string;
        lastSeen: string;
        capabilities: { tools?: string[] };
      }>;

      if (nodes.length === 0) {
        console.log('No nodes registered.');
        return;
      }

      console.log('\n  MeshMind Hub — Node Status\n');
      for (const node of nodes) {
        const status = node.status === 'online' ? '\x1b[32m●\x1b[0m' : '\x1b[31m●\x1b[0m';
        const tools = (node.capabilities as { tools?: string[] })?.tools?.join(', ') ?? '';
        console.log(`  ${status} ${node.name.padEnd(20)} ${node.tailscaleIp.padEnd(18)} [${tools}]`);
        console.log(`    Last seen: ${node.lastSeen}`);
      }
      console.log();
    } catch (error) {
      console.error('Failed to connect to hub:', (error as Error).message);
      process.exit(1);
    }
  });

// hub exec <node> "<cmd>"
program
  .command('exec <node> <cmd>')
  .description('Execute a command on a remote node')
  .option('-w, --workdir <dir>', 'Working directory')
  .option('-t, --timeout <ms>', 'Timeout in milliseconds')
  .action(async (node: string, cmd: string, opts: { workdir?: string; timeout?: string }) => {
    try {
      const res = await hubFetch('/exec', {
        method: 'POST',
        body: JSON.stringify({
          nodeName: node,
          cmd,
          workdir: opts.workdir,
          timeout: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
        }),
      });

      const result = await res.json() as {
        stdout: string;
        stderr: string;
        exitCode: number;
        duration: number;
        error?: string;
      };

      if (!res.ok) {
        console.error(`Error: ${result.error ?? 'Unknown error'}`);
        process.exit(1);
      }

      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
      process.exit(result.exitCode);
    } catch (error) {
      console.error('Failed:', (error as Error).message);
      process.exit(1);
    }
  });

// hub logs <sessionId>
program
  .command('logs <sessionId>')
  .description('View agent session logs')
  .action(async (sessionId: string) => {
    console.log(`Agent logs for ${sessionId} — Phase 2`);
  });

// hub context get <key>
program
  .command('context')
  .description('Manage shared context')
  .command('get <key>')
  .action(async (key: string) => {
    try {
      const res = await hubFetch(`/context/${encodeURIComponent(key)}`);
      if (!res.ok) {
        console.error(`Context "${key}" not found or expired.`);
        process.exit(1);
      }
      const entry = await res.json();
      console.log(JSON.stringify(entry, null, 2));
    } catch (error) {
      console.error('Failed:', (error as Error).message);
      process.exit(1);
    }
  });

program.parse();
