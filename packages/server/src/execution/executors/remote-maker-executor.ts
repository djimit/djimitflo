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

/** How long a host may work on one maker job, counted from its claim (REMOTE_MAKER_TIMEOUT_MS, default 30 min). */
export const remoteMakerTimeoutMs = (): number => Number(process.env.REMOTE_MAKER_TIMEOUT_MS) || 1_800_000;
/** How long a job may wait for a claim before an absent host fails it (REMOTE_MAKER_QUEUE_TIMEOUT_MS, default 45 min). */
export const remoteMakerQueueTimeoutMs = (): number => Number(process.env.REMOTE_MAKER_QUEUE_TIMEOUT_MS) || 2_700_000;
const WAIT_MARGIN_MS = 60_000;
/** The longest a caller can wait for a remote maker: queue wait + work + margin (the daemon waits this for a remote sibling). */
export const remoteMakerWaitMs = (workMs = remoteMakerTimeoutMs()): number => remoteMakerQueueTimeoutMs() + workMs + WAIT_MARGIN_MS;
/** The cancel reason a failed remote maker reports in its stderr (`remote_maker_cancelled:<reason>`), for the lease's failure_reason. */
export const remoteMakerCancelReason = (stderr: string | undefined): string | null => /remote_maker_cancelled:([a-z_;]+)/.exec(stderr || '')?.[1] ?? null;

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
    // waiting costs no CPU here; the host's worker polls every few minutes and a maker there takes ~5 min, so a loop
    // maker timeout of 300-600 s would expire before the host even looked. Work is timed from the claim (the host may be
    // busy finishing a gym attempt first); an unclaimed job fails after the queue timeout.
    const workMs = Math.max(options?.timeout ?? 0, remoteMakerTimeoutMs());
    const queueMs = remoteMakerQueueTimeoutMs();
    const cancelled = (reason: string, detail: string) => finish(1, '', `remote maker cancelled (${detail}): remote_maker_cancelled:${reason}`);

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
      const deadline = Date.now() + remoteMakerWaitMs(workMs); // backstop only: expire() fails the job first
      const poll = () => {
        if (finished) return;
        const job = this.queue.get(jobId!);
        if (job && job.status === 'done') {
          if (!job.patch) return finish(0, `remote maker (${target.host}): ${job.reason || 'no change'}`);
          const applied = spawnSync('git', ['-C', cwd, 'apply', '--whitespace=nowarn', '-'], { input: job.patch, encoding: 'utf8' });
          return applied.status === 0 ? finish(0, `remote maker (${target.host}): ${job.reason || 'patch applied'}`) : finish(1, '', `remote patch did not apply: ${(applied.stderr || '').slice(0, 300)}`);
        }
        if (job && job.status === 'failed') return finish(1, '', `remote maker failed: ${job.reason || ''}`);
        if (job && job.status === 'cancelled') return cancelled(job.reason || 'unknown', 'by the server');
        const expired = this.queue.expire(jobId!, queueMs, workMs);
        if (expired) return cancelled(expired, expired === 'queue_timeout' ? `not claimed within ${queueMs} ms` : `not finished within ${workMs} ms of its claim`);
        if (Date.now() > deadline) { this.queue.cancel(jobId!, 'wait_timeout'); return cancelled('wait_timeout', `${job?.status ?? 'unknown'}`); }
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
      cancel: async () => { session.status = 'cancelled'; if (jobId) this.queue.cancel(jobId, 'session_cancelled'); finish(1, '', 'cancelled: remote_maker_cancelled:session_cancelled'); session.completedAt = new Date(); },
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
