import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';

/**
 * OPS-004: executeWorker wrote a 'running' spawn row and a separate completion row — two roots, no parent edge, both
 * ended_at null — and a rejected executeMaker left only the 'running' row. A worker is one span, child of the run, closed
 * when the maker settles (ok / error / cancelled) with the time it settled.
 */
describe('loop worker trace span', () => {
  let db: Database.Database; let loops: LoopService; let tmp: string;
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-span-'));
    fs.writeFileSync(path.join(tmp, 'README.md'), '# fixture\n');
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
    execFileSync('git', ['add', '.'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmp, stdio: 'ignore' });
    loops = new LoopService(db, fs.mkdtempSync(path.join(os.tmpdir(), 'worker-span-ev-')));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  const prepareMaker = () => {
    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: tmp, target_finding: { file_path: 'README.md', description: 'Improve wording', category: 'refactor' } });
    const prepared = loops.continueLoopRun(run.id, { runtime: 'mock', max_assignments: 1, max_maker_workers: 1 });
    return { runId: run.id, maker: prepared.leases.find((l) => l.role === 'maker')! };
  };
  const traceOf = (runId: string, leaseId: string) => loops.assurance.getTrace(`loop-${runId}-worker-${leaseId}`);
  const fakeExecution = (runId: string, leaseId: string) => ({
    run: loops.getLoopRun(runId), lease: loops.listWorkerLeases(runId).find((l) => l.id === leaseId)!,
    gates: [], stdout_path: '/dev/null', stderr_path: '/dev/null',
  });

  it('success yields one closed worker span with a run->worker edge', async () => {
    const { runId, maker } = prepareMaker();
    const executed = await loops.executeWorker(runId, { lease_id: maker.id, timeout_ms: 10_000 });
    expect(executed.lease.status).toBe('completed');

    const trace = traceOf(runId, maker.id);
    const workers = trace.spans.filter((s) => s.span_type === 'worker');
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({ status: 'ok', loop_run_id: runId, ended_at: expect.any(String) });
    expect(Date.parse(workers[0].ended_at!)).toBeGreaterThanOrEqual(Date.parse(workers[0].started_at!));

    const runSpan = trace.spans.find((s) => s.span_type === 'loop')!;
    expect(runSpan).toMatchObject({ loop_run_id: runId, parent_span_id: null, ended_at: expect.any(String) });
    expect(trace.roots.map((s) => s.id)).toEqual([runSpan.id]);
    expect(trace.edges).toEqual([{ from: runSpan.id, to: workers[0].id }]);
    expect(trace.spans.filter((s) => s.status === 'running')).toEqual([]);
    expect(executed.trace).toEqual(trace);
  });

  it('a thrown executeMaker closes the worker span as an error with an end time', async () => {
    const { runId, maker } = prepareMaker();
    vi.spyOn(loops, 'executeMaker').mockRejectedValue(new Error('MAKER_EXPLODED'));
    await expect(loops.executeWorker(runId, { lease_id: maker.id })).rejects.toThrow('MAKER_EXPLODED');

    const trace = traceOf(runId, maker.id);
    const worker = trace.spans.find((s) => s.span_type === 'worker')!;
    expect(worker).toMatchObject({ status: 'error', ended_at: expect.any(String), metadata: expect.objectContaining({ terminal_status: 'error', error: 'MAKER_EXPLODED' }) });
    expect(trace.edges).toHaveLength(1);
    expect(trace.spans.filter((s) => s.status === 'running' || !s.ended_at)).toEqual([]);
  });

  it('a cancelled maker closes the worker span as a terminal failure with an end time', async () => {
    const { runId, maker } = prepareMaker();
    vi.spyOn(loops, 'executeMaker').mockImplementation(async () => {
      loops.updateWorkerLeaseStatus(maker.id, 'cancelled', { cancellation_reason: 'operator_stop' });
      return fakeExecution(runId, maker.id);
    });
    await loops.executeWorker(runId, { lease_id: maker.id });

    const worker = traceOf(runId, maker.id).spans.find((s) => s.span_type === 'worker')!;
    expect(worker).toMatchObject({ status: 'error', ended_at: expect.any(String), metadata: expect.objectContaining({ terminal_status: 'cancelled' }) });
  });

  it('span timing is the maker execution window, not when later bookkeeping ran', async () => {
    const { runId, maker } = prepareMaker();
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-28T10:00:00.000Z');
    const settled = new Date('2026-10-28T10:05:00.000Z');
    vi.setSystemTime(start);
    vi.spyOn(loops, 'executeMaker').mockImplementation(async () => {
      vi.setSystemTime(settled);
      return fakeExecution(runId, maker.id);
    });
    const createCheckpoint = loops.assurance.createCheckpoint.bind(loops.assurance);
    vi.spyOn(loops.assurance, 'createCheckpoint').mockImplementation((input) => {
      if (input.metadata?.phase === 'after_worker_execution') vi.setSystemTime(new Date('2026-10-28T11:00:00.000Z'));
      return createCheckpoint(input);
    });
    await loops.executeWorker(runId, { lease_id: maker.id });

    const worker = traceOf(runId, maker.id).spans.find((s) => s.span_type === 'worker')!;
    expect(worker.started_at).toBe(start.toISOString());
    expect(worker.ended_at).toBe(settled.toISOString());
  });
});
