import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT = 30_000; // 30s
const MAX_TIMEOUT = 300_000;    // 5min
const MAX_BUFFER = 5 * 1024 * 1024; // 5MB (reduced from 10MB)

// Shell metacharacters that indicate injection attempts
const SHELL_METACHARACTERS = /[;|&`$(){}[\]<>!#~\n\r\\]/;
const DANGEROUS_PATTERNS = [
  /\.\.\//,           // directory traversal
  /\/etc\/(passwd|shadow|sudoers)/,
  /\/proc\//,
  /\/dev\/(sd|null|zero|random)/,
];

// EXEC_ALLOWLIST=docker,git,ls,cat  — only these binaries allowed (empty = allow all)
// EXEC_DENYLIST=rm,dd,mkfs          — these binaries always blocked (checked first)
const ALLOWLIST: string[] = (process.env.EXEC_ALLOWLIST ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Default denylist includes destructive commands even if user doesn't set one
const DEFAULT_DENYLIST = [
  'rm', 'dd', 'mkfs', 'fdisk', 'mount', 'umount',
  'chmod', 'chown', 'chroot',
  'reboot', 'shutdown', 'poweroff', 'halt', 'init',
  'kill', 'killall', 'pkill',
  'iptables', 'ip6tables', 'nft',
  'useradd', 'userdel', 'usermod', 'passwd', 'su', 'sudo',
  'nc', 'ncat', 'socat',       // network backdoor tools
  'wget', 'curl',              // download - block by default, add to allowlist if needed
  'ssh', 'scp',                // lateral movement
  'eval', 'exec',              // shell builtins
  'crontab', 'at',             // scheduled execution
];

const USER_DENYLIST: string[] = (process.env.EXEC_DENYLIST ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);

const DENYLIST = [...new Set([...DEFAULT_DENYLIST, ...USER_DENYLIST])];

// Allowed base directories for workdir
const ALLOWED_WORKDIRS: string[] = (process.env.EXEC_ALLOWED_WORKDIRS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);

function extractBinary(cmd: string): string {
  const token = cmd.trim().split(/\s+/)[0];
  return token.split('/').at(-1) ?? token;
}

function parseCommand(cmd: string): { binary: string; args: string[] } {
  // Simple shell-style tokenizer that respects quotes
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === ' ' && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    tokens.push(current);
  }

  const [binary, ...args] = tokens;
  return { binary: binary ?? '', args };
}

function checkAllowed(cmd: string): { ok: boolean; reason?: string } {
  // 1. Check for shell metacharacters (injection prevention)
  if (SHELL_METACHARACTERS.test(cmd)) {
    const matched = cmd.match(SHELL_METACHARACTERS);
    return {
      ok: false,
      reason: `Command contains blocked shell metacharacter: "${matched?.[0]}". Use separate exec calls instead of chaining.`,
    };
  }

  // 2. Check for dangerous path patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) {
      return { ok: false, reason: `Command matches blocked pattern: ${pattern}` };
    }
  }

  // 3. Extract and validate binary name
  const bin = extractBinary(cmd);

  if (DENYLIST.includes(bin)) {
    return { ok: false, reason: `Command "${bin}" is in the denylist` };
  }

  if (ALLOWLIST.length > 0 && !ALLOWLIST.includes(bin)) {
    return { ok: false, reason: `Command "${bin}" is not in the allowlist (${ALLOWLIST.join(', ')})` };
  }

  return { ok: true };
}

function validateWorkdir(workdir: string): { ok: boolean; reason?: string } {
  // Resolve to absolute path and check for traversal
  const resolved = path.resolve(workdir);

  // Block path traversal
  if (workdir.includes('..')) {
    return { ok: false, reason: `Workdir contains path traversal: "${workdir}"` };
  }

  // If ALLOWED_WORKDIRS is set, enforce it
  if (ALLOWED_WORKDIRS.length > 0) {
    const isAllowed = ALLOWED_WORKDIRS.some(base => resolved.startsWith(base));
    if (!isAllowed) {
      return {
        ok: false,
        reason: `Workdir "${resolved}" is not under allowed directories: ${ALLOWED_WORKDIRS.join(', ')}`,
      };
    }
  }

  // Verify directory exists
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { ok: false, reason: `Workdir "${resolved}" does not exist or is not a directory` };
  }

  return { ok: true };
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

export async function execHandler(
  cmd: string,
  workdir?: string,
  timeout?: number,
): Promise<ExecResult> {
  // Validate command
  const check = checkAllowed(cmd);
  if (!check.ok) {
    return { stdout: '', stderr: check.reason!, exitCode: 1, duration: 0 };
  }

  // Validate workdir
  if (workdir) {
    const wdCheck = validateWorkdir(workdir);
    if (!wdCheck.ok) {
      return { stdout: '', stderr: wdCheck.reason!, exitCode: 1, duration: 0 };
    }
  }

  const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
  const start = Date.now();

  try {
    const extendedPath = [
      process.env.PATH,
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/snap/bin',
      '/usr/local/sbin',
      '/usr/sbin',
      '/sbin',
    ].filter(Boolean).join(':');

    // Parse command into binary + args (no shell!)
    const { binary, args } = parseCommand(cmd);

    const { stdout, stderr } = await execFileAsync(binary, args, {
      cwd: workdir ?? process.cwd(),
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, PATH: extendedPath },
      // No shell: true — execFile doesn't use shell by default
    });

    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: 0,
      duration: Date.now() - start,
    };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
    return {
      stdout: (err.stdout ?? '').trim(),
      stderr: (err.stderr ?? (error as Error).message).trim(),
      exitCode: err.code ?? 1,
      duration: Date.now() - start,
    };
  }
}
