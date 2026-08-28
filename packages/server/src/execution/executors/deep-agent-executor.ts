import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  ExecutionEventType,
  LogLevel,
  type ExecutionEventCreateInput,
  type Task,
} from '@djimitflo/shared';
import type {
  ExecutionResult,
  ExecutionSession,
  ExecutorKind,
  ExecutorOptions,
  TaskExecutor,
} from '../types';

interface ProcessOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export class DeepAgentExecutor implements TaskExecutor {
  readonly kind: ExecutorKind = 'deep-agent';

  constructor(
    private readonly runtimeRoot = process.env.DJIMIT_DEEP_RUNTIME_ROOT ?? '',
    private readonly pythonPath = process.env.DJIMIT_DEEP_PYTHON ?? '',
    private readonly runtimeUrl = process.env.DJIMIT_DEEP_URL ?? '',
  ) {}

  private executionUrl(): string {
    const url = new URL(this.runtimeUrl);
    const octets = url.hostname.split('.').map(Number);
    const tailscale = octets.length === 4
      && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
      && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'http:' || (!tailscale && !loopback) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
      throw new Error('DJIMIT_DEEP_URL must be an HTTP loopback or literal Tailscale IPv4 origin');
    }
    return new URL('/v1/execute', url).toString();
  }

  canExecute(task: Task): boolean {
    const contract = task.metadata.deep_agent_contract;
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return false;
    const identity = (contract as Record<string, unknown>).identity;
    const capabilities = (contract as Record<string, unknown>).capabilities;
    return !!identity && typeof identity === 'object'
      && (identity as Record<string, unknown>).task_id === task.id
      && !!capabilities && typeof capabilities === 'object'
      && (capabilities as Record<string, unknown>).profile_id === 'no-tool-canary';
  }

  buildCommand(task: Task): { command: string; args: string[] } {
    const command = this.pythonPath || path.join(this.runtimeRoot, '.venv/bin/python');
    const args = [
      '-m', 'djimit_deep', 'run-no-tool', '--contract', '-',
      '--profiles', path.join(this.runtimeRoot, 'config/profiles'),
      '--nonce-db', path.join(this.runtimeRoot, 'evidence/nonces.sqlite3'),
      '--events', path.join(this.runtimeRoot, 'evidence/events.jsonl'),
      '--audit-db', path.join(this.runtimeRoot, 'evidence/audit.sqlite3'),
    ];
    const contract = task.metadata.deep_agent_contract as Record<string, any>;
    if (contract?.signature?.algorithm === 'Ed25519') {
      args.push('--key-env', 'DJIMIT_DEEP_FEDERATION_PUBLIC_KEY', '--key-id', String(contract.signature.key_id), '--issuer', 'djimitflo-federation');
    }
    if (process.env.DJIMIT_EVENT_BUS_URL) args.push('--event-bus-url', process.env.DJIMIT_EVENT_BUS_URL);
    return {
      command,
      args,
    };
  }

  async start(task: Task, options?: ExecutorOptions): Promise<ExecutionSession> {
    if (!this.canExecute(task)) throw new Error('DEEP_AGENT_CONTRACT_INVALID_FOR_TASK');
    if (this.runtimeUrl) return this.startRemote(task, options);
    if (!this.runtimeRoot) throw new Error('DJIMIT_DEEP_RUNTIME_ROOT is required');
    const contract = task.metadata.deep_agent_contract as Record<string, any>;
    const ed25519 = contract?.signature?.algorithm === 'Ed25519';
    const verificationKey = ed25519 ? process.env.DJIMIT_DEEP_FEDERATION_PUBLIC_KEY : process.env.DJIMIT_CANARY_SIGNING_KEY;
    if (!verificationKey) throw new Error(ed25519 ? 'DJIMIT_DEEP_FEDERATION_PUBLIC_KEY is required' : 'DJIMIT_CANARY_SIGNING_KEY is required');

    const startedAt = new Date();
    let child: ChildProcess | null = null;
    const { command, args } = this.buildCommand(task);
    const output = new Promise<ProcessOutput>((resolve) => {
      const env: NodeJS.ProcessEnv = {};
      for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP']) {
        if (process.env[name] !== undefined) env[name] = process.env[name];
      }
      env.PYTHONPATH = path.join(this.runtimeRoot, 'src');
      env[ed25519 ? 'DJIMIT_DEEP_FEDERATION_PUBLIC_KEY' : 'DJIMIT_CANARY_SIGNING_KEY'] = verificationKey;
      child = spawn(command, args, {
        cwd: this.runtimeRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const limit = 1024 * 1024;
      child.stdout?.on('data', (data) => { stdout = (stdout + data.toString()).slice(-limit); });
      child.stderr?.on('data', (data) => { stderr = (stderr + data.toString()).slice(-limit); });
      child.on('error', (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin?.end(JSON.stringify(task.metadata.deep_agent_contract));
    });

    const timeoutMs = options?.timeout ?? 10_000;
    const timeout = setTimeout(() => child?.kill('SIGTERM'), timeoutMs);
    void output.finally(() => clearTimeout(timeout));
    const result = output.then((value) => this.toResult(value, Date.now() - startedAt.getTime()));

    const session: ExecutionSession = {
      id: randomUUID(),
      taskId: task.id,
      executorKind: this.kind,
      status: 'running',
      startedAt,
      events: this.events(task.id, output),
      result,
      cancel: async () => {
        child?.kill('SIGTERM');
        session.status = 'cancelled';
        session.completedAt = new Date();
      },
    };
    return session;
  }

  private async startRemote(task: Task, options?: ExecutorOptions): Promise<ExecutionSession> {
    const startedAt = new Date();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeout ?? 10_000);
    const output = fetch(this.executionUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(task.metadata.deep_agent_contract),
      signal: controller.signal,
    }).then(async (response): Promise<ProcessOutput> => {
      const body = (await response.text()).slice(-1024 * 1024);
      return { code: response.ok ? 0 : response.status, stdout: response.ok ? body : '', stderr: response.ok ? '' : body };
    }).catch((error: unknown): ProcessOutput => ({
      code: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    })).finally(() => clearTimeout(timeout));
    const result = output.then((value) => this.toResult(value, Date.now() - startedAt.getTime()));
    const session: ExecutionSession = {
      id: randomUUID(),
      taskId: task.id,
      executorKind: this.kind,
      status: 'running',
      startedAt,
      events: this.events(task.id, output),
      result,
      cancel: async () => {
        controller.abort();
        session.status = 'cancelled';
        session.completedAt = new Date();
      },
    };
    return session;
  }

  private async *events(taskId: string, output: Promise<ProcessOutput>): AsyncIterable<ExecutionEventCreateInput> {
    yield {
      task_id: taskId,
      event_type: ExecutionEventType.TASK_STARTED,
      message: 'Contract-gated Deep Agents canary started',
      level: LogLevel.INFO,
      metadata: { executor: this.kind, profile: 'no-tool-canary' },
    };
    const value = await output;
    const completed = this.completed(value);
    yield {
      task_id: taskId,
      event_type: completed ? ExecutionEventType.TASK_COMPLETED : ExecutionEventType.TASK_FAILED,
      message: completed ? 'Deep Agents canary completed' : 'Deep Agents canary failed',
      level: completed ? LogLevel.INFO : LogLevel.ERROR,
      metadata: { executor: this.kind, exitCode: value.code },
    };
  }

  private completed(output: ProcessOutput): boolean {
    try {
      return output.code === 0
        && JSON.parse(output.stdout.trim().split('\n').at(-1) ?? '{}').status === 'COMPLETED';
    } catch {
      return false;
    }
  }

  private toResult(output: ProcessOutput, executionTimeMs: number): ExecutionResult {
    if (this.completed(output)) {
      return {
        status: 'completed',
        message: 'Contract-gated Deep Agents canary completed',
        stdout: output.stdout,
        stderr: output.stderr,
        metrics: { executionTimeMs, toolCalls: 0, tokenUsage: 0, costDollars: 0 },
      };
    }
    return {
      status: 'failed',
      message: 'Contract-gated Deep Agents canary failed closed',
      stdout: output.stdout,
      stderr: output.stderr,
      error: output.stderr || output.stdout || `Process exited with code ${output.code}`,
      metrics: { executionTimeMs, toolCalls: 0, tokenUsage: 0, costDollars: 0 },
    };
  }
}
