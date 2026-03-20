import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ──── Constants ────

const RING_BUFFER_SIZE = 100;
const LOG_DIR = process.env.AGENT_LOG_DIR ?? '/tmp/meshmind-agents';
const DEFAULT_ONESHOT_TIMEOUT_MS = 5 * 60_000;
const KILL_GRACE_PERIOD_MS = 5_000;
const SESSION_RETENTION_MS = 60 * 60_000; // keep finished sessions for 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60_000;

// ──── Types ────

export type AgentMode = 'oneshot' | 'interactive';
export type AgentStatus = 'starting' | 'running' | 'done' | 'failed' | 'killed' | 'timeout';

export interface AgentSession {
  id: string;
  tool: string;
  mode: AgentMode;
  workdir: string;
  pid: number | null;
  status: AgentStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  ringBuffer: string[];
  logFile: string;
  timeoutMs: number | null;
}

export interface AgentStartOpts {
  tool: string;
  mode: AgentMode;
  workdir: string;
  args?: string[];
  prompt?: string;
  systemPrompt?: string;
  timeoutMs?: number;
}

export interface AgentManager {
  start(opts: AgentStartOpts): AgentSession;
  get(id: string): AgentSession | null;
  send(id: string, message: string): { ok: boolean; error?: string };
  read(id: string, opts?: { offset?: number; limit?: number }): {
    lines: string[];
    total: number;
    isRunning: boolean;
    status: AgentStatus;
    exitCode: number | null;
  } | null;
  kill(id: string): { ok: boolean; error?: string };
  list(): AgentSession[];
  runningIds(): string[];
}

// ──── Tool Resolution ────

function resolveCommand(tool: string, mode: AgentMode, opts: AgentStartOpts): { cmd: string; args: string[] } {
  if (tool === 'claude-code' || tool === 'claude') {
    const args: string[] = [];
    if (mode === 'oneshot') args.push('--print');
    if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt);
    if (mode === 'oneshot' && opts.prompt) args.push(opts.prompt);
    return { cmd: 'claude', args };
  }

  const toolMap: Record<string, { cmd: string; defaultArgs: string[] }> = {
    aider:   { cmd: 'aider',   defaultArgs: [] },
    python:  { cmd: 'python3', defaultArgs: ['-u'] },
    python3: { cmd: 'python3', defaultArgs: ['-u'] },
    node:    { cmd: 'node',    defaultArgs: ['-i'] },
    bash:    { cmd: '/bin/sh', defaultArgs: [] },
    sh:      { cmd: '/bin/sh', defaultArgs: [] },
  };

  const known = toolMap[tool];
  if (known) {
    return { cmd: known.cmd, args: [...known.defaultArgs, ...(opts.args ?? [])] };
  }

  return { cmd: tool, args: opts.args ?? [] };
}

// ──── Agent Manager ────

export function createAgentManager(): AgentManager {
  const sessions = new Map<string, AgentSession>();
  const processes = new Map<string, ChildProcess>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  // Cleanup finished sessions to prevent memory leak
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.endedAt && now - new Date(session.endedAt).getTime() > SESSION_RETENTION_MS) {
        sessions.delete(id);
        processes.delete(id); // safety
        timers.delete(id);    // safety
      }
    }
  }, CLEANUP_INTERVAL_MS).unref();

  function appendToRing(session: AgentSession, line: string) {
    session.ringBuffer.push(line);
    if (session.ringBuffer.length > RING_BUFFER_SIZE) {
      session.ringBuffer.shift();
    }
  }

  function appendToLog(session: AgentSession, data: string) {
    try {
      fs.appendFileSync(session.logFile, data);
    } catch {
      // Logging failure shouldn't crash the agent
    }
  }

  function clearTimer(id: string) {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }

  function killProcess(id: string, proc: ChildProcess) {
    proc.kill('SIGTERM');
    const forceKill = setTimeout(() => {
      if (processes.has(id)) {
        proc.kill('SIGKILL');
      }
    }, KILL_GRACE_PERIOD_MS);
    forceKill.unref();
  }

  function setupProcessHandlers(id: string, proc: ChildProcess, session: AgentSession) {
    const handleOutput = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString();
      const prefix = stream === 'stderr' ? '[stderr] ' : '';
      appendToLog(session, prefix ? `${prefix}${text}` : text);
      for (const line of text.split('\n')) {
        if (line.length > 0) {
          appendToRing(session, `${prefix}${line}`);
        }
      }
    };

    proc.stdout?.on('data', handleOutput('stdout'));
    proc.stderr?.on('data', handleOutput('stderr'));

    proc.on('close', (code, signal) => {
      clearTimer(id);
      session.exitCode = code;
      session.endedAt = new Date().toISOString();
      if (session.status !== 'timeout') {
        session.status = (signal === 'SIGKILL' || signal === 'SIGTERM') ? 'killed'
          : code === 0 ? 'done' : 'failed';
      }
      appendToRing(session, `[agent] Exited: code=${code} signal=${signal}`);
      processes.delete(id);
    });

    proc.on('error', (err) => {
      clearTimer(id);
      session.status = 'failed';
      session.endedAt = new Date().toISOString();
      appendToRing(session, `[agent] Error: ${err.message}`);
      processes.delete(id);
    });
  }

  return {
    start(opts) {
      const id = `agent-${crypto.randomUUID().slice(0, 8)}`;
      const logFile = path.join(LOG_DIR, `${id}.log`);
      const { cmd, args } = resolveCommand(opts.tool, opts.mode, opts);
      const timeoutMs = opts.mode === 'oneshot'
        ? (opts.timeoutMs ?? DEFAULT_ONESHOT_TIMEOUT_MS)
        : null;

      const session: AgentSession = {
        id, tool: opts.tool, mode: opts.mode, workdir: opts.workdir,
        pid: null, status: 'starting', exitCode: null,
        startedAt: new Date().toISOString(), endedAt: null,
        ringBuffer: [], logFile, timeoutMs,
      };
      sessions.set(id, session);

      try {
        const proc = spawn(cmd, args, {
          cwd: opts.workdir,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
        });

        session.pid = proc.pid ?? null;
        session.status = 'running';
        processes.set(id, proc);

        appendToRing(session, `[agent] Started: ${cmd} ${args.join(' ')} (pid=${proc.pid})`);
        appendToLog(session, `[${session.startedAt}] Started: ${cmd} ${args.join(' ')} (pid=${proc.pid})\n`);

        setupProcessHandlers(id, proc, session);

        if (timeoutMs) {
          const timer = setTimeout(() => {
            if (session.status === 'running') {
              session.status = 'timeout';
              appendToRing(session, `[agent] Timeout after ${timeoutMs}ms`);
              killProcess(id, proc);
            }
            timers.delete(id);
          }, timeoutMs);
          timer.unref();
          timers.set(id, timer);
        }
      } catch (err) {
        session.status = 'failed';
        session.endedAt = new Date().toISOString();
        appendToRing(session, `[agent] Failed to start: ${(err as Error).message}`);
      }

      return session;
    },

    get(id) {
      return sessions.get(id) ?? null;
    },

    send(id, message) {
      const session = sessions.get(id);
      if (!session) return { ok: false, error: 'Session not found' };
      if (session.status !== 'running') return { ok: false, error: `Agent is ${session.status}` };

      const proc = processes.get(id);
      if (!proc?.stdin?.writable) return { ok: false, error: 'stdin not writable' };

      proc.stdin.write(message + '\n');
      appendToRing(session, `[input] ${message}`);
      appendToLog(session, `[input] ${message}\n`);
      return { ok: true };
    },

    read(id, opts) {
      const session = sessions.get(id);
      if (!session) return null;

      const offset = opts?.offset ?? 0;
      const limit = opts?.limit ?? RING_BUFFER_SIZE;
      return {
        lines: session.ringBuffer.slice(offset, offset + limit),
        total: session.ringBuffer.length,
        isRunning: session.status === 'running',
        status: session.status,
        exitCode: session.exitCode,
      };
    },

    kill(id) {
      const session = sessions.get(id);
      if (!session) return { ok: false, error: 'Session not found' };

      clearTimer(id);
      const proc = processes.get(id);
      if (proc) killProcess(id, proc);
      return { ok: true };
    },

    list: () => Array.from(sessions.values()),
    runningIds: () => Array.from(sessions.values()).filter(s => s.status === 'running').map(s => s.id),
  };
}
