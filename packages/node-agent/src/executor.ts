import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT = 30_000; // 30s
const MAX_TIMEOUT = 300_000;    // 5min

// EXEC_ALLOWLIST=docker,git,ls,cat  — only these binaries allowed (empty = allow all)
// EXEC_DENYLIST=rm,dd,mkfs          — these binaries always blocked (checked first)
const ALLOWLIST: string[] = (process.env.EXEC_ALLOWLIST ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);
const DENYLIST: string[] = (process.env.EXEC_DENYLIST ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);

function extractBinary(cmd: string): string {
  // First token, strip any path prefix (e.g. /usr/bin/docker → docker)
  const token = cmd.trim().split(/\s+/)[0];
  return token.split('/').at(-1) ?? token;
}

function checkAllowed(cmd: string): { ok: boolean; reason?: string } {
  const bin = extractBinary(cmd);
  if (DENYLIST.includes(bin)) {
    return { ok: false, reason: `Command "${bin}" is in the denylist` };
  }
  if (ALLOWLIST.length > 0 && !ALLOWLIST.includes(bin)) {
    return { ok: false, reason: `Command "${bin}" is not in the allowlist (${ALLOWLIST.join(', ')})` };
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
  const check = checkAllowed(cmd);
  if (!check.ok) {
    return { stdout: '', stderr: check.reason!, exitCode: 1, duration: 0 };
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

    const { stdout, stderr } = await execAsync(cmd, {
      cwd: workdir ?? process.cwd(),
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      shell: '/bin/sh',
      env: { ...process.env, PATH: extendedPath },
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
