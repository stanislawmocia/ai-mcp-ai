#!/usr/bin/env node
import { Command } from 'commander';
import { startNodeAgent } from '../server.js';

const program = new Command();

program
  .name('meshmind-node')
  .description('MeshMind node agent — join a MeshMind Hub mesh')
  .requiredOption('--name <name>', 'Node name (e.g., macbook, alienware)')
  .requiredOption('--hub <url>', 'Hub URL (e.g., http://100.x.x.x:7433)')
  .option('--token <token>', 'Auth token (or set HUB_TOKEN env)', process.env.HUB_TOKEN)
  .option('--port <port>', 'Agent port', '7432')
  .option('--bind <host>', 'Bind address (default: 0.0.0.0)', process.env.BIND_HOST ?? '0.0.0.0')
  .option('--tls-cert <path>', 'TLS certificate path', process.env.TLS_CERT || undefined)
  .option('--tls-key <path>', 'TLS key path', process.env.TLS_KEY || undefined)
  .action(async (opts) => {
    const token = opts.token;
    if (!token) {
      console.error('Error: --token or HUB_TOKEN env is required');
      process.exit(1);
    }

    const proto = opts.tlsCert ? 'https' : 'http';
    console.log(`
  ╔══════════════════════════════════════╗
  ║        MeshMind Node Agent           ║
  ╠══════════════════════════════════════╣
  ║  Node:  ${opts.name.padEnd(27)}║
  ║  Hub:   ${opts.hub.padEnd(27)}║
  ║  Port:  ${opts.port.padEnd(27)}║
  ║  Bind:  ${opts.bind.padEnd(27)}║
  ║  TLS:   ${(opts.tlsCert ? 'enabled' : 'disabled').padEnd(27)}║
  ╚══════════════════════════════════════╝
`);

    await startNodeAgent({
      name: opts.name,
      port: parseInt(opts.port, 10),
      hubUrl: opts.hub,
      token,
      bindHost: opts.bind,
      tlsCert: opts.tlsCert,
      tlsKey: opts.tlsKey,
    });
  });

program.parse();
