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

// hub spawn <node> <tool> --workdir <dir> [--mode oneshot|interactive] [--prompt "..."]
program
  .command('spawn <node> <tool>')
  .description('Spawn an agent on a remote node')
  .requiredOption('-w, --workdir <dir>', 'Working directory')
  .option('-m, --mode <mode>', 'Agent mode: oneshot or interactive', 'oneshot')
  .option('-p, --prompt <prompt>', 'Prompt for oneshot mode')
  .option('--system-prompt <sp>', 'System prompt for Claude Code')
  .option('--timeout <ms>', 'Oneshot timeout in ms (default: 300000 = 5min)')
  .action(async (node: string, tool: string, opts: {
    workdir: string;
    mode: string;
    prompt?: string;
    systemPrompt?: string;
    timeout?: string;
  }) => {
    try {
      const res = await hubFetch('/agents/spawn', {
        method: 'POST',
        body: JSON.stringify({
          nodeName: node,
          tool,
          workdir: opts.workdir,
          mode: opts.mode,
          prompt: opts.prompt,
          systemPrompt: opts.systemPrompt,
          timeoutMs: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
        }),
      });

      const result = await res.json() as Record<string, unknown>;

      if (!res.ok) {
        console.error('Error:', JSON.stringify(result));
        process.exit(1);
      }

      console.log(`Agent spawned: ${result.sessionId}`);
      console.log(`  Tool: ${result.tool} | Mode: ${result.mode} | PID: ${result.pid}`);
      console.log(`  Use: hub logs ${result.sessionId}`);
    } catch (error) {
      console.error('Failed:', (error as Error).message);
      process.exit(1);
    }
  });

// hub logs <sessionId>
program
  .command('logs <sessionId>')
  .description('View agent session output')
  .option('-f, --follow', 'Follow output (poll every 2s)')
  .action(async (sessionId: string, opts: { follow?: boolean }) => {
    try {
      const printOutput = async () => {
        const res = await hubFetch(`/agents/${encodeURIComponent(sessionId)}/read`);
        const result = await res.json() as {
          lines?: string[];
          total?: number;
          isRunning?: boolean;
          status?: string;
          exitCode?: number | null;
          nodeName?: string;
          error?: string;
        };

        if (!res.ok) {
          console.error(`Error: ${result.error ?? 'Unknown'}`);
          return false;
        }

        console.log(`[${sessionId}] Status: ${result.status} | Node: ${result.nodeName}`);
        if (result.exitCode !== null) console.log(`Exit code: ${result.exitCode}`);
        console.log(`--- output (${result.total} lines in buffer) ---`);
        for (const line of result.lines ?? []) {
          console.log(line);
        }
        return result.isRunning;
      };

      const isRunning = await printOutput();

      if (opts.follow && isRunning) {
        const interval = setInterval(async () => {
          console.log('\n--- refresh ---');
          const still = await printOutput();
          if (!still) {
            clearInterval(interval);
            console.log('\nAgent finished.');
          }
        }, 2000);
      }
    } catch (error) {
      console.error('Failed:', (error as Error).message);
      process.exit(1);
    }
  });

// hub agents — list all agents
program
  .command('agents')
  .description('List all agent sessions across all nodes')
  .action(async () => {
    try {
      const res = await hubFetch('/agents');
      const agents = await res.json() as Array<{
        id: string;
        tool: string;
        mode: string;
        status: string;
        pid: number | null;
        nodeName: string;
        startedAt: string;
        endedAt: string | null;
      }>;

      if (agents.length === 0) {
        console.log('No agent sessions.');
        return;
      }

      console.log('\n  MeshMind Hub — Agent Sessions\n');
      for (const a of agents) {
        const icon = a.status === 'running' ? '\x1b[32m●\x1b[0m'
          : a.status === 'done' ? '\x1b[34m●\x1b[0m'
          : '\x1b[31m●\x1b[0m';
        console.log(`  ${icon} ${a.id.padEnd(20)} ${a.tool.padEnd(14)} ${a.status.padEnd(10)} ${a.nodeName}`);
      }
      console.log();
    } catch (error) {
      console.error('Failed:', (error as Error).message);
      process.exit(1);
    }
  });

// hub kill <sessionId>
program
  .command('kill <sessionId>')
  .description('Kill a running agent session')
  .action(async (sessionId: string) => {
    try {
      const res = await hubFetch(`/agents/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        console.error(`Error: ${err.error ?? 'Unknown'}`);
        process.exit(1);
      }
      console.log(`Kill signal sent to ${sessionId}`);
    } catch (error) {
      console.error('Failed:', (error as Error).message);
      process.exit(1);
    }
  });

// hub send <sessionId> "<message>"
program
  .command('send <sessionId> <message>')
  .description('Send a message to an interactive agent session')
  .action(async (sessionId: string, message: string) => {
    try {
      const res = await hubFetch(`/agents/${encodeURIComponent(sessionId)}/send`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        console.error(`Error: ${err.error ?? 'Unknown'}`);
        process.exit(1);
      }
      console.log(`Sent to ${sessionId}. Use: hub logs ${sessionId}`);
    } catch (error) {
      console.error('Failed:', (error as Error).message);
      process.exit(1);
    }
  });

// hub context get <key> / hub context set <key> <json>
const contextCmd = program
  .command('context')
  .description('Manage shared context');

contextCmd
  .command('get <key>')
  .description('Get a context value by key')
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

contextCmd
  .command('set <key> <json>')
  .description('Set a context value')
  .option('--ttl <hours>', 'Time-to-live in hours')
  .option('--share <nodes>', 'Comma-separated node names to share with')
  .action(async (key: string, json: string, opts: { ttl?: string; share?: string }) => {
    try {
      const data = JSON.parse(json);
      const res = await hubFetch('/context', {
        method: 'POST',
        body: JSON.stringify({
          key,
          data,
          ttlHours: opts.ttl ? parseInt(opts.ttl, 10) : undefined,
          sharedWith: opts.share ? opts.share.split(',') : undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        console.error(`Error: ${err.error ?? 'Unknown'}`);
        process.exit(1);
      }
      console.log(`Context "${key}" saved.`);
    } catch (error) {
      console.error('Failed:', (error as Error).message);
      process.exit(1);
    }
  });

contextCmd
  .command('delete <key>')
  .description('Delete a context value')
  .action(async (key: string) => {
    try {
      const res = await hubFetch(`/context/${encodeURIComponent(key)}`, { method: 'DELETE' });
      if (!res.ok) {
        console.error(`Error deleting context "${key}".`);
        process.exit(1);
      }
      console.log(`Context "${key}" deleted.`);
    } catch (error) {
      console.error('Failed:', (error as Error).message);
      process.exit(1);
    }
  });

program.parse();
