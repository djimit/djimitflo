import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { LoopRecoveryService } from '../services/loop-recovery-service';
import { QueueHygieneService } from '../services/queue-hygiene-service';

/**
 * RIR (LOOP_RESUME_INTERRUPTED): before this, resumeInterruptedRun only flipped an interrupted run to 'running' and had no
 * caller, so every run a restart interrupted waited 48 h for queue hygiene to cancel it.
 */
let db: Database.Database; let loops: LoopService; let repo: string; let evidence: string;
const prevFlag = process.env.LOOP_RESUME_INTERRUPTED;

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rir-repo-'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  for (const args of [['init'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Test'], ['add', '.'], ['commit', '-m', 'init']]) {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  }
  evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'rir-ev-'));
  loops = new LoopService(db, evidence);
  delete process.env.LOOP_RESUME_INTERRUPTED;
});
afterEach(() => {
  db.close();
  fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(evidence, { recursive: true, force: true });
  if (prevFlag === undefined) delete process.env.LOOP_RESUME_INTERRUPTED; else process.env.LOOP_RESUME_INTERRUPTED = prevFlag;
});

/** A daemon goal whose maker was running when the server died; boot recovery then marks the run interrupted. */
function interruptedRun(opts: { goalStatus?: string; proposalStatus?: string; runMeta?: Record<string, unknown>; task?: { status: string; hold?: boolean } } = {}) {
  const at = new Date(Date.now() - 60_000).toISOString();
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, grounding_json, created_at, updated_at)
    VALUES ('p1', 'test', 't', 'd', 'r', 'test-gap', ?, 0.5, '[]', '{}', ?, ?)`).run(opts.proposalStatus ?? 'executing', at, at);
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id, metadata, created_at, updated_at) VALUES ('g1', 'Improve README wording', 'low', 'running', 'p1', '{}', ?, ?)")
    .run(at, at);
  const run = loops.startDocDriftAndSmallFixLoop({ goal_id: 'g1', repository_path: repo, target_finding: { file_path: 'README.md', description: 'Improve wording', category: 'refactor' } });
  const maker = loops.continueLoopRun(run.id, { runtime: 'mock', max_assignments: 1, max_maker_workers: 1 }).leases.find((l) => l.role === 'maker')!;
  if (opts.task) {
    db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, metadata) VALUES ('t1', 'maker', 'p', ?, 'low', 'low', 'local', ?)")
      .run(opts.task.status, JSON.stringify(opts.task.hold ? { execution_recovery_hold: true, execution_recovery_reason: 'server_restart' } : {}));
  }
  db.prepare("UPDATE worker_leases SET status = 'running', metadata = json_set(metadata, '$.execution_task_id', ?) WHERE id = ?").run(opts.task ? 't1' : null, maker.id);
  db.prepare("UPDATE loop_runs SET status = 'running', metadata = json_patch(metadata, ?) WHERE id = ?").run(JSON.stringify(opts.runMeta ?? {}), run.id);
  if (opts.goalStatus) db.prepare('UPDATE goals SET status = ? WHERE id = ?').run(opts.goalStatus, 'g1');
  const bootedAt = new Date(Date.now() - 1000).toISOString();
  const recovery = loops.recoverInterruptedRuns();
  return { runId: run.id, makerId: maker.id, bootedAt, recovery };
}

const goal = () => db.prepare("SELECT status, metadata FROM goals WHERE id = 'g1'").get() as { status: string; metadata: string };
const runStatus = (id: string) => (db.prepare('SELECT status FROM loop_runs WHERE id = ?').get(id) as { status: string }).status;
const makers = (runId: string) => loops.listWorkerLeases(runId).filter((l) => l.role === 'maker');
const events = (runId: string, type: string) => db.prepare('SELECT message, metadata FROM loop_events WHERE loop_run_id = ? AND event_type = ?').all(runId, type) as Array<{ message: string; metadata: string }>;

describe('RIR: resume interrupted runs at boot', () => {
  it('RIR-1: flag off = identical boot behaviour (run stays interrupted, no retry, goal untouched, no event)', () => {
    const { runId, bootedAt, recovery } = interruptedRun();
    expect(recovery).toMatchObject({ interruptedRuns: 1, failedLeases: 1, settledRuns: 0 });
    expect(loops.resumeInterruptedRuns({ bootedAt })).toEqual({ mode: 'off', resumed: 0, skipped: 0, details: [] });
    expect(runStatus(runId)).toBe('interrupted');
    expect(makers(runId).map((l) => l.status)).toEqual(['failed']);
    expect(goal()).toEqual({ status: 'running', metadata: '{}' });
    expect(events(runId, 'run_resumed').length + events(runId, 'run_resume_skipped').length + events(runId, 'run_resume_shadow').length).toBe(0);
  });

  it('RIR-2: flag on — an interrupted run gets a fresh prepared maker, its goal goes back to decomposed with resume_run_id, and run_resumed is recorded', () => {
    process.env.LOOP_RESUME_INTERRUPTED = 'on';
    const { runId, makerId, bootedAt } = interruptedRun();
    const summary = loops.resumeInterruptedRuns({ bootedAt });
    expect(summary).toEqual({ mode: 'on', resumed: 1, skipped: 0, details: [{ runId, resumed: true, reason: 'server_restart' }] });
    expect(runStatus(runId)).toBe('running');
    const fresh = makers(runId).filter((l) => l.status === 'prepared');
    expect(fresh).toHaveLength(1);
    expect(fresh[0].metadata).toMatchObject({ retry_of_maker_lease_id: makerId, retry_attempt: 1 });
    const g = goal();
    expect(g.status).toBe('decomposed');
    expect(JSON.parse(g.metadata).resume_run_id).toBe(runId);
    const resumed = events(runId, 'run_resumed');
    expect(resumed).toHaveLength(1);
    expect(JSON.parse(resumed[0].metadata)).toMatchObject({ reason: 'server_restart', resume_attempt: 1, retry_maker_lease_id: fresh[0].id, goal_id: 'g1' });
    expect(loops.getLoopRun(runId).metadata).toMatchObject({ resume_attempts: 1, resume_reason: 'server_restart' });
  });

  it('RIR-3: a run whose maker task is under execution_recovery_hold (external outcome unknown) is never replayed', () => {
    process.env.LOOP_RESUME_INTERRUPTED = 'on';
    const { runId, bootedAt } = interruptedRun({ task: { status: 'paused', hold: true } });
    expect(loops.resumeInterruptedRuns({ bootedAt })).toEqual({ mode: 'on', resumed: 0, skipped: 1, details: [{ runId, resumed: false, reason: 'execution_recovery_hold' }] });
    expect(runStatus(runId)).toBe('interrupted');
    expect(makers(runId)).toHaveLength(1);
    expect(goal().status).toBe('running');
    expect(JSON.parse(events(runId, 'run_resume_skipped')[0].metadata)).toEqual({ reason: 'execution_recovery_hold', resume_attempt: 1 });
  });

  it('RIR-3b: a maker task the engine has not reconciled yet (still running) counts as unknown, not as safe', () => {
    process.env.LOOP_RESUME_INTERRUPTED = 'on';
    const { runId, bootedAt } = interruptedRun({ task: { status: 'running' } });
    expect(loops.resumeInterruptedRuns({ bootedAt }).details).toEqual([{ runId, resumed: false, reason: 'execution_outcome_unknown' }]);
    expect(makers(runId)).toHaveLength(1);
  });

  it('RIR-4: resume_attempts >= 3 is not resumed and is left for queue hygiene to cancel', () => {
    process.env.LOOP_RESUME_INTERRUPTED = 'on';
    const { runId, bootedAt } = interruptedRun({ runMeta: { resume_attempts: 3 } });
    expect(loops.resumeInterruptedRuns({ bootedAt }).details).toEqual([{ runId, resumed: false, reason: 'resume_attempts_exhausted' }]);
    expect(runStatus(runId)).toBe('interrupted');
    expect(makers(runId)).toHaveLength(1);
    expect(goal().status).toBe('running');
    expect(new QueueHygieneService(db).sweepZombies(new Date(Date.now() + 49 * 3_600_000)).runsReaped).toBe(1);
    expect(runStatus(runId)).toBe('cancelled');
  });

  it('RIR-4b: an exhausted retry budget is not resumed', () => {
    process.env.LOOP_RESUME_INTERRUPTED = 'on';
    const { runId, bootedAt } = interruptedRun();
    db.prepare("UPDATE goals SET budget_json = '{\"max_retries\":0}' WHERE id = 'g1'").run();
    expect(loops.resumeInterruptedRuns({ bootedAt }).details).toEqual([{ runId, resumed: false, reason: 'LOOP_RETRY_BUDGET_EXHAUSTED' }]);
    expect(runStatus(runId)).toBe('interrupted');
    expect(makers(runId)).toHaveLength(1);
  });

  it.each([
    [{ goalStatus: 'cancelled' }, 'goal_cancelled'],
    [{ goalStatus: 'blocked' }, 'goal_blocked'],
    [{ proposalStatus: 'rejected' }, 'proposal_rejected'],
  ])('RIR-5: an operator-cancelled/blocked goal or proposal is not resumed (%j → %s)', (opts, reason) => {
    process.env.LOOP_RESUME_INTERRUPTED = 'on';
    const { runId, bootedAt } = interruptedRun(opts);
    expect(loops.resumeInterruptedRuns({ bootedAt }).details).toEqual([{ runId, resumed: false, reason }]);
    expect(makers(runId)).toHaveLength(1);
    expect(JSON.parse(goal().metadata).resume_run_id).toBeUndefined();
  });

  it('RIR-6: idempotent across two boots — the second boot neither settles nor retries the re-queued run again', () => {
    process.env.LOOP_RESUME_INTERRUPTED = 'on';
    const { runId, bootedAt } = interruptedRun();
    expect(loops.resumeInterruptedRuns({ bootedAt }).resumed).toBe(1);
    // second restart before the daemon picked the goal up: every row predates this boot
    const boot2 = new Date(Date.now() + 60_000).toISOString();
    expect(new LoopRecoveryService(db).recoverInterruptedRuns({ bootedAt: boot2 })).toEqual({ interruptedRuns: 0, failedLeases: 0, settledRuns: 0 });
    expect(new LoopService(db, evidence).resumeInterruptedRuns({ bootedAt: boot2 })).toEqual({ mode: 'on', resumed: 0, skipped: 0, details: [] });
    expect(makers(runId).map((l) => l.status).sort()).toEqual(['failed', 'prepared']);
    expect(runStatus(runId)).toBe('running');
    expect(goal().status).toBe('decomposed');
    expect(events(runId, 'run_resumed')).toHaveLength(1);
  });

  it('RIR-7: shadow records what it would do and changes nothing', () => {
    process.env.LOOP_RESUME_INTERRUPTED = 'shadow';
    const { runId, bootedAt } = interruptedRun();
    expect(loops.resumeInterruptedRuns({ bootedAt })).toEqual({ mode: 'shadow', resumed: 0, skipped: 0, details: [{ runId, resumed: false, reason: 'shadow' }] });
    expect(runStatus(runId)).toBe('interrupted');
    expect(makers(runId)).toHaveLength(1);
    expect(goal().status).toBe('running');
    expect(JSON.parse(events(runId, 'run_resume_shadow')[0].metadata)).toEqual({ would_resume: true, reason: 'server_restart', resume_attempt: 1 });
  });
});
