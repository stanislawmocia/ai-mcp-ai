import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const RING_SIZE = 100;
const LOG_DIR = process.env.AGENT_LOG_DIR ?? '/tmp/meshmind-agents';

export type AgentMode = 'oneshot' | 'interactive';
export type AgentStatus = 'starting' | 'running' | 'done' | 'failed' | 'killed';

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
}

export interface AgentStartOpts {
  tool: string;
  mode: AgentMode;
  workdir: string;
  args?: string[];
  prompt?: string;       // for oneshot mode — the prompt to send
  systemPrompt?: string; // passed as arg if tool supports it
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
}

// Map tool names to actual commands
const TOOL_COMMANDS: Record<string, { cmd: string; defaultArgs: string[] }> = {
  'claude-code': { cmd: 'claude', defaultArgs: ['--print'] },
  'claude': { cmd: 'claude', defaultArgs: ['--print'] },
  'aider': { cmd: 'aider', defaultArgs: [] },
  'python': { cmd: 'python3', defaultArgs: ['-u'] }, // unbuffered
  'node': { cmd: 'node', defaultArgs: ['-i'] },
  'bash': { cmd: 'bash', defaultArgs: [] },
};

function resolveCommand(tool: string, mode: AgentMode, opts: AgentStartOpts): { cmd: string; args: string[] } {
  const known = TOOL_COMMANDS[tool];

  if (tool === 'claude-code' || tool === 'claude') {
    if (mode === 'oneshot') {
      // claude --print "prompt"
      const args = ['--print'];
      if (opts.systemPrompt) {
        args.push('--system-prompt', opts.systemPrompt);
      }
      if (opts.prompt) {
        args.push(opts.prompt);
      }
      return { cmd: 'claude', args };
    } else {
      // interactive: claude (no --print, we'll write to stdin)
      const args: string[] = [];
      if (opts.systemPrompt) {
        args.push('--system-prompt', opts.systemPrompt);
      }
      return { cmd: 'claude', args };
    }
  }

  if (known) {
    return { cmd: known.cmd, args: [...known.defaultArgs, ...(opts.args ?? [])] };
  }

  // Generic: treat tool as the command itself
  return { cmd: tool, args: opts.args ?? [] };
}

export function createAgentManager(): AgentManager {
  const sessions = new Map<string, AgentSession>();
  const processes = new Map<string, ChildProcess>();

  // Ensure log dir exists
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  function appendToRing(session: AgentSession, line: string) {
    session.ringBuffer.push(line);
    if (session.ringBuffer.length > RING_SIZE) {
      session.ringBuffer.shift();
    }
  }

  function appendToLog(session: AgentSession, data: string) {
    fs.appendFileSync(session.logFile, data);
  }

  function setupProcessHandlers(id: string, proc: ChildProcess, session: AgentSession) {
    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      appendToLog(session, text);
      for (const line of text.split('\n')) {
        if (line.length > 0) {
          appendToRing(session, line);
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      appendToLog(session, `[stderr] ${text}`);
      for (const line of text.split('\n')) {
        if (line.length > 0) {
          appendToRing(session, `[stderr] ${line}`);
        }
      }
    });

    proc.on('close', (code, signal) => {
      session.exitCode = code;
      session.endedAt = new Date().toISOString();
      session.status = signal === 'SIGKILL' || signal === 'SIGTERM' ? 'killed'
        : code === 0 ? 'done' : 'failed';
      appendToRing(session, `[agent] Process exited: code=${code} signal=${signal}`);
      processes.delete(id);
    });

    proc.on('error', (err) => {
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

      const session: AgentSession = {
        id,
        tool: opts.tool,
        mode: opts.mode,
        workdir: opts.workdir,
        pid: null,
        status: 'starting',
        exitCode: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        ringBuffer: [],
        logFile,
      };

      sessions.set(id, session);

      try {
        const proc = spawn(cmd, args, {
          cwd: opts.workdir,
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
        });

        session.pid = proc.pid ?? null;
        session.status = 'running';
        processes.set(id, proc);

        appendToRing(session, `[agent] Started: ${cmd} ${args.join(' ')} (pid=${proc.pid})`);
        appendToLog(session, `[${session.startedAt}] Started: ${cmd} ${args.join(' ')} (pid=${proc.pid})\n`);

        setupProcessHandlers(id, proc, session);
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
      if (session.status !== 'running') return { ok: false, error: `Agent is ${session.status}, cannot send` };

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
      const limit = opts?.limit ?? RING_SIZE;
      const lines = session.ringBuffer.slice(offset, offset + limit);

      return {
        lines,
        total: session.ringBuffer.length,
        isRunning: session.status === 'running',
        status: session.status,
        exitCode: session.exitCode,
      };
    },

    kill(id) {
      const session = sessions.get(id);
      if (!session) return { ok: false, error: 'Session not found' };

      const proc = processes.get(id);
      if (!proc) {
        // Already exited
        return { ok: true };
      }

      proc.kill('SIGTERM');
      // Force kill after 5s if still alive
      setTimeout(() => {
        if (processes.has(id)) {
          proc.kill('SIGKILL');
        }
      }, 5000).unref();

      return { ok: true };
    },

    list() {
      return Array.from(sessions.values());
    },
  };
}
