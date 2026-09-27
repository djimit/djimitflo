/**
 * Plan I3: runtime `remote` — the maker runs on a compute host (see remote-maker-queue.ts). The lease's model names
 * `<host>/<species>`, e.g. `workstation/atomic@llama-router`. The base commit must be on origin/main (the host clones
 * from GitHub); the returned patch is applied to this worktree and the loop's gates judge it like any maker's diff.
 */

import { randomUUID } from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import type { Database } from 'better-sqlite3';
import { Task, ExecutionEventType, LogLevel, type ExecutionEventCreateInput } from '@djimitflo/shared';
import type { ExecutionResult, ExecutionSession, ExecutorKind, ExecutorOptions, TaskExecutor } from '../types';
import { RemoteMakerQueue } from '../../services/remote-maker-queue';

export function parseRemoteTarget(model: string | undefined): { host: string; species: string } | null {
  const m = /^([A-Za-z0-9._-]{1,40})\/([A-Za-z0-9._:@/-]{1,80})$/.exec(model || '');
  return m ? { host: m[1], species: m[2] } : null;
}

export class RemoteMakerExecutor implements TaskExecutor {
  readonly kind: ExecutorKind = 'remote';
  private readonly queue: RemoteMakerQueue;
  constructor(db: Database, private readonly pollMs = 5_000) { this.queue = new RemoteMakerQueue(db); }

  canExecute(_task: Task): boolean { return true; }
  buildCommand(_task: Task, options?: ExecutorOptions): { command: string; args: string[] } { return { command: 'remote-maker', args: [options?.model || ''] }; }

  async start(task: Task, options?: ExecutorOptions): Promise<ExecutionSession> {
    const emitter = new EventEmitter();
    let jobId: string | null = null;
    let finished = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const finish = (code: number, stdout: string, stderr = '') => { if (finished) return; finished = true; emitter.emit('done', { code, stdout, stderr }); resolveClosed(); };
    const cwd = options?.workingDirectory || process.cwd();
    const timeoutMs = options?.timeout ?? 900_000;

    const run = () => {
      const target = parseRemoteTarget(options?.model);
      if (!target) return finish(1, '', `remote maker needs model '<host>/<species>', got '${options?.model ?? ''}'`);
      let base: string;
      try {
        base = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        execFileSync('git', ['-C', cwd, 'merge-base', '--is-ancestor', base, 'origin/main'], { stdio: 'ignore' });
      } catch { return finish(1, '', 'infra: base commit is not on origin/main, the remote host cannot fetch it'); }
      jobId = this.queue.enqueue(target.host, target.species, base, task.description);
      emitter.emit('log', `queued remote maker job ${jobId} for ${target.host} (${target.species}) at ${base.slice(0, 8)}`);
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        if (finished) return;
        const job = this.queue.get(jobId!);
        if (job && job.status === 'done') {
          if (!job.patch) return finish(0, `remote maker (${target.host}): ${job.reason || 'no change'}`);
          const applied = spawnSync('git', ['-C', cwd, 'apply', '--whitespace=nowarn', '-'], { input: job.patch, encoding: 'utf8' });
          return applied.status === 0 ? finish(0, `remote maker (${target.host}): ${job.reason || 'patch applied'}`) : finish(1, '', `remote patch did not apply: ${(applied.stderr || '').slice(0, 300)}`);
        }
        if (job && (job.status === 'failed' || job.status === 'cancelled')) return finish(1, '', `remote maker ${job.status}: ${job.reason || ''}`);
        if (Date.now() > deadline) { this.queue.cancel(jobId!); return finish(1, '', `remote maker timed out after ${timeoutMs} ms (${job?.status ?? 'unknown'})`); }
        setTimeout(poll, this.pollMs).unref?.();
      };
      poll();
    };

    const session: ExecutionSession = {
      id: randomUUID(), taskId: task.id, executorKind: this.kind, status: 'starting', startedAt: new Date(), closed,
      events: this.events(task, emitter, run),
      result: new Promise<ExecutionResult>((resolve) => emitter.once('done', ({ code, stdout, stderr }: { code: number; stdout: string; stderr: string }) => resolve(code === 0
        ? { status: 'completed', message: 'Remote maker completed', stdout, stderr, metrics: { executionTimeMs: 0 } }
        : { status: 'failed', message: 'Remote maker failed', stdout, stderr, error: stderr, metrics: { executionTimeMs: 0 } }))),
      cancel: async () => { session.status = 'cancelled'; if (jobId) this.queue.cancel(jobId); finish(1, '', 'cancelled'); session.completedAt = new Date(); },
    };
    return session;
  }

  private async *events(task: Task, emitter: EventEmitter, run: () => void): AsyncIterable<ExecutionEventCreateInput> {
    const logs: string[] = [];
    let done: { code: number; stdout: string; stderr: string } | null = null;
    let wake: (() => void) | null = null;
    emitter.on('log', (line: string) => { logs.push(line); wake?.(); wake = null; });
    emitter.on('done', (d: { code: number; stdout: string; stderr: string }) => { done = d; wake?.(); wake = null; });
    run();
    yield { task_id: task.id, event_type: ExecutionEventType.TASK_STARTED, message: 'Remote maker started', level: LogLevel.INFO, metadata: { executor: 'remote', usage_source: 'unavailable' } };
    while (!done || logs.length) {
      if (!logs.length && !done) await new Promise<void>((resolve) => { wake = resolve; });
      while (logs.length) yield { task_id: task.id, event_type: ExecutionEventType.LOG, message: logs.shift()!, level: LogLevel.INFO, metadata: { executor: 'remote' } };
    }
    const d = done as { code: number; stdout: string; stderr: string };
    yield { task_id: task.id, event_type: d.code === 0 ? ExecutionEventType.TASK_COMPLETED : ExecutionEventType.TASK_FAILED, message: d.code === 0 ? d.stdout : d.stderr, level: d.code === 0 ? LogLevel.INFO : LogLevel.ERROR, metadata: { executor: 'remote', exit_code: d.code } };
  }
}
