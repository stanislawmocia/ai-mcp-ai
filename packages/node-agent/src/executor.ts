import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT = 30_000; // 30s
const MAX_TIMEOUT = 300_000;    // 5min

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
  const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
  const start = Date.now();

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: workdir ?? process.cwd(),
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      shell: '/bin/bash',
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
