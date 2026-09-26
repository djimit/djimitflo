/**
 * Atomic Agent executor (plan C5): `atomic-agent run` reads its goal from stdin and works in `--cwd`.
 *
 * Djimitflo stays the approval boundary: without `--no-approval` atomic blocks on stdin at the first edit, so the flag is
 * only passed when an operator-armed/approved run sets skipPermissions (same rule as Hermes `--yolo`). The model is an
 * OpenAI-compatible provider (default Ollama Cloud, key from OLLAMA_API_KEY) written into a Djimitflo-owned state dir
 * before each run, so the operator's own ~/.atomic-agent is never touched.
 */

import { randomUUID } from 'crypto';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { mkdirSync } from 'fs';
import { Task, ExecutionEventType, LogLevel, type ExecutionEventCreateInput } from '@djimitflo/shared';
import { captureExecutorOutput } from '../executor-output';
import type { ExecutionResult, ExecutionSession, ExecutorKind, ExecutorOptions, TaskExecutor } from '../types';
import { buildExecutorEnv } from './executor-env';
import { runtimeProcessClosed, stopRuntimeProcess } from './runtime-process';

/**
 * Which env var holds the provider key (prod 2026-09-26: OLLAMA_API_KEY was not set in the container, so atomic sent an
 * empty key and got 401; the working Ollama Cloud key is SOCIAL_COMPAT_API_KEY, which the Commons residents use).
 */
export const atomicKeyEnv = (env: NodeJS.ProcessEnv): string => env.ATOMIC_AGENT_API_KEY_ENV || 'OLLAMA_API_KEY';

/** The provider block atomic-agent needs; `local-llama` must stay listed because it is the default embedding provider. */
export function atomicConfig(env: NodeJS.ProcessEnv, model?: string): string {
  return JSON.stringify({
    version: 69,
    llm: {
      activeTextProvider: 'djimitflo-cloud', activeEmbeddingProvider: 'local-llama', toolTransport: 'auto',
      providers: [
        { id: 'local-llama', kind: 'llama-server', url: 'http://127.0.0.1:8084' },
        { id: 'djimitflo-cloud', kind: 'openai-compatible', baseUrl: env.ATOMIC_AGENT_BASE_URL || 'https://ollama.com/v1', apiKeyEnvVar: atomicKeyEnv(env), defaultChatModel: model || env.ATOMIC_AGENT_MODEL || 'kimi-k3' },
      ],
    },
  });
}

export class AtomicExecutor implements TaskExecutor {
  readonly kind: ExecutorKind = 'atomic';
  private readonly bin: string;
  private readonly stateDir: string;
  private readonly timeoutMs: number;

  constructor(bin?: string) {
    this.bin = bin || process.env.ATOMIC_AGENT_BIN_PATH || 'atomic-agent';
    this.stateDir = process.env.DJIMITFLO_ATOMIC_STATE_DIR || '/data/atomic-agent';
    this.timeoutMs = Number(process.env.ATOMIC_EXECUTION_TIMEOUT_MS || 600_000);
  }

  canExecute(_task: Task): boolean { return true; }

  buildCommand(_task: Task, options?: ExecutorOptions): { command: string; args: string[] } {
    const args = ['run', '--cwd', options?.workingDirectory || process.cwd(), '--max-steps', process.env.ATOMIC_AGENT_MAX_STEPS || '40'];
    if (options?.skipPermissions) args.push('--no-approval');
    return { command: this.bin, args };
  }

  async start(task: Task, options?: ExecutorOptions): Promise<ExecutionSession> {
    const emitter = new EventEmitter();
    let child: ChildProcess | null = null;
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    // the key var may sit outside the executor allowlist (e.g. SOCIAL_COMPAT_API_KEY): pass exactly that one through
    const keyVar = atomicKeyEnv(process.env);
    const env = buildExecutorEnv({ ...(options?.environment || {}), ATOMIC_AGENT_STATE_DIR: this.stateDir, ...(process.env[keyVar] ? { [keyVar]: process.env[keyVar]! } : {}) });
    const { args } = this.buildCommand(task, options);

    const spawnProcess = () => {
      if (session.status === 'cancelled') { resolveClosed(); emitter.emit('exit', null); return; }
      try { mkdirSync(this.stateDir, { recursive: true }); } catch { /* config set reports the real error below */ }
      // idempotent: the provider/model this run uses (a species may name its own model)
      const configured = spawnSync(this.bin, ['config', 'set', atomicConfig(process.env, options?.model)], { env, encoding: 'utf8', timeout: 15_000 });
      if (configured.status !== 0) { emitter.emit('error', new Error(`atomic-agent config failed: ${(configured.stderr || configured.error?.message || '').slice(0, 300)}`)); emitter.emit('exit', 1); resolveClosed(); return; }
      const proc = spawn(this.bin, args, { cwd: options?.workingDirectory || process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] });
      child = proc;
      void runtimeProcessClosed(proc).then(resolveClosed);
      proc.stdin?.end(`${task.description}\n`);
      const timeout = setTimeout(() => { stopRuntimeProcess(proc); emitter.emit('error', new Error(`Atomic execution timed out after ${options?.timeout ?? this.timeoutMs}ms`)); }, options?.timeout ?? this.timeoutMs);
      timeout.unref();
      proc.stdout?.on('data', data => emitter.emit('output', data.toString(), 'stdout'));
      proc.stderr?.on('data', data => emitter.emit('output', data.toString(), 'stderr'));
      proc.on('close', code => { clearTimeout(timeout); emitter.emit('exit', code); });
      proc.on('error', error => emitter.emit('error', error));
    };

    const events = this.events(task, emitter, spawnProcess);
    const result = this.result(emitter);
    const session: ExecutionSession = {
      id: randomUUID(), taskId: task.id, executorKind: this.kind, status: 'starting', startedAt: new Date(), events, result, closed,
      cancel: async () => { session.status = 'cancelled'; await stopRuntimeProcess(child); if (!child) resolveClosed(); session.completedAt = new Date(); },
    };
    return session;
  }

  private async *events(task: Task, emitter: EventEmitter, spawnProcess: () => void): AsyncIterable<ExecutionEventCreateInput> {
    spawnProcess();
    yield { task_id: task.id, event_type: ExecutionEventType.TASK_STARTED, message: 'Atomic execution started', level: LogLevel.INFO, metadata: { executor: 'atomic', output_mode: 'plain', usage_source: 'unavailable' } };
    const queue: Array<{ text: string; stream: 'stdout' | 'stderr' }> = [];
    const errors: Error[] = [];
    let exitCode: number | null | undefined;
    let wake: (() => void) | null = null;
    emitter.on('output', (text: string, stream: 'stdout' | 'stderr') => { queue.push({ text, stream }); wake?.(); wake = null; });
    emitter.on('error', (error: Error) => { errors.push(error); wake?.(); wake = null; });
    emitter.on('exit', (code: number | null) => { exitCode = code; wake?.(); wake = null; });
    while (exitCode === undefined || queue.length > 0 || errors.length > 0) {
      if (queue.length === 0 && errors.length === 0 && exitCode === undefined) await new Promise<void>(resolve => { wake = resolve; });
      while (errors.length > 0) yield { task_id: task.id, event_type: ExecutionEventType.ERROR, message: `Atomic process error: ${errors.shift()!.message}`, level: LogLevel.ERROR, metadata: { executor: 'atomic' } };
      while (queue.length > 0) {
        const { text, stream } = queue.shift()!;
        // atomic logs its progress on stderr; only stdout carries the answer
        for (const line of text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
          yield { task_id: task.id, event_type: ExecutionEventType.LOG, message: line, level: LogLevel.INFO, metadata: { executor: 'atomic', stream } };
        }
      }
    }
    yield {
      task_id: task.id, event_type: exitCode === 0 ? ExecutionEventType.TASK_COMPLETED : ExecutionEventType.TASK_FAILED,
      message: exitCode === 0 ? 'Atomic execution completed successfully' : `Atomic execution failed with exit code ${exitCode}`,
      level: exitCode === 0 ? LogLevel.INFO : LogLevel.ERROR, metadata: { executor: 'atomic', exit_code: exitCode, usage_source: 'unavailable' },
    };
  }

  private async result(emitter: EventEmitter): Promise<ExecutionResult> {
    const output = captureExecutorOutput(emitter);
    return new Promise(resolve => {
      emitter.once('exit', (code: number) => resolve(code === 0
        ? { status: 'completed', message: 'Atomic execution completed successfully', metrics: { executionTimeMs: 0 }, ...output() }
        : { status: 'failed', message: `Atomic execution failed with exit code ${code}`, error: `Process exited with code ${code}`, metrics: { executionTimeMs: 0 }, ...output() }));
      emitter.once('error', (error: Error) => resolve({ status: 'failed', message: `Atomic execution error: ${error.message}`, error: error.stack, metrics: { executionTimeMs: 0 }, ...output() }));
    });
  }
}
