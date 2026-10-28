import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { FixLoopService } from '../services/fix-loop-service';
import { RsiSafetyGuard } from '../services/rsi-safety-guard';

/**
 * OPS-004: executeWorker wrote a 'running' spawn row and a separate completion row — two roots, no parent edge, both
 * ended_at null — and a rejected executeMaker left only the 'running' row. A maker lease has one span, child of the run,
 * opened at first dispatch and closed only when the maker settles (ok / error / cancelled) with the time it settled; an
 * approval / in-progress exit leaves it open for the resumed call. Every maker entry point (executeWorker, executeMaker
 * as used by the execute-maker route and FixLoopService) goes through it.
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
  /** Stub the runtime step under the shared maker path (span ownership stays in the real executeMaker). */
  const stubRunMaker = () => vi.spyOn(loops.workerExecutor as any, 'runMaker');
  const workerSpans = (leaseId: string) => (db.prepare("SELECT * FROM agent_trace_spans WHERE span_type = 'worker' AND json_extract(metadata, '$.worker_lease_id') = ?")
    .all(leaseId) as Array<{ status: string; started_at: string; ended_at: string | null; parent_span_id: string | null }>);

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
    stubRunMaker().mockImplementation(async () => {
      loops.updateWorkerLeaseStatus(maker.id, 'running', { started_at: new Date().toISOString() });
      throw new Error('MAKER_EXPLODED');
    });
    await expect(loops.executeWorker(runId, { lease_id: maker.id })).rejects.toThrow('MAKER_EXPLODED');

    const trace = traceOf(runId, maker.id);
    const worker = trace.spans.find((s) => s.span_type === 'worker')!;
    expect(worker).toMatchObject({ status: 'error', ended_at: expect.any(String), metadata: expect.objectContaining({ terminal_status: 'error', error: 'MAKER_EXPLODED' }) });
    expect(trace.edges).toHaveLength(1);
    expect(trace.spans.filter((s) => s.status === 'running' || !s.ended_at)).toEqual([]);
  });

  it('a cancelled maker closes the worker span as a terminal failure with an end time', async () => {
    const { runId, maker } = prepareMaker();
    stubRunMaker().mockImplementation(async () => {
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
    stubRunMaker().mockImplementation(async () => {
      vi.setSystemTime(settled);
      loops.updateWorkerLeaseStatus(maker.id, 'completed', {});
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

  it('approval -> execution -> resumed collection is one worker span: start at first dispatch, end at settlement', async () => {
    const { runId, maker } = prepareMaker();
    vi.useFakeTimers({ toFake: ['Date'] });
    const dispatched = new Date('2026-10-28T10:00:00.000Z');
    const resumed = new Date('2026-10-28T10:30:00.000Z');
    const settled = new Date('2026-10-28T10:31:00.000Z');
    vi.setSystemTime(dispatched);
    stubRunMaker()
      .mockImplementationOnce(async () => { throw new Error('LOOP_WORKER_APPROVAL_REQUIRED'); }) // the lease stays 'prepared'
      .mockImplementationOnce(async () => {
        vi.setSystemTime(settled);
        loops.updateWorkerLeaseStatus(maker.id, 'completed', {});
        return fakeExecution(runId, maker.id);
      });
    await expect(loops.executeWorker(runId, { lease_id: maker.id })).rejects.toThrow('LOOP_WORKER_APPROVAL_REQUIRED');
    expect(workerSpans(maker.id)).toEqual([expect.objectContaining({ status: 'running', ended_at: null })]); // open, not an error

    vi.setSystemTime(resumed);
    await loops.executeWorker(runId, { lease_id: maker.id });
    const spans = workerSpans(maker.id);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ status: 'ok', started_at: dispatched.toISOString(), ended_at: settled.toISOString() });
    const trace = traceOf(runId, maker.id);
    expect(trace.edges).toEqual([{ from: trace.roots[0].id, to: trace.spans.find((s) => s.span_type === 'worker')!.id }]);
  });

  it('executeMaker called directly (execute-maker route) records the same closed span', async () => {
    const { runId, maker } = prepareMaker();
    const executed = await loops.executeMaker(runId, { lease_id: maker.id, timeout_ms: 10_000 });
    expect(executed.lease.status).toBe('completed');
    expect(workerSpans(maker.id)).toEqual([expect.objectContaining({ status: 'ok', ended_at: expect.any(String), parent_span_id: expect.any(String) })]);
    expect(traceOf(runId, maker.id).edges).toHaveLength(1);
  });

  it('FixLoopService (executeMaker entry point) records the maker span', async () => {
    vi.spyOn(RsiSafetyGuard.prototype, 'canMutate').mockReturnValue({ allowed: true });
    const result = await new FixLoopService(db as any, loops).fixFile({ repositoryPath: tmp, filePath: 'README.md', description: 'Improve wording', category: 'refactor', runtime: 'mock' });
    const maker = loops.listWorkerLeases(result.loopRunId!).find((l) => l.role === 'maker')!;
    expect(workerSpans(maker.id)).toEqual([expect.objectContaining({ status: maker.status === 'completed' ? 'ok' : 'error', ended_at: expect.any(String) })]);
  });
});
