import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { resetTypesafeBreaker } from '../services/typesafe-client';
import { DreamStateService, dreamVerdict } from '../services/dream-state-service';

let db: Database.Database;
const now = () => new Date().toISOString();
const reply = (choice: string, conf: number, pf: number) => vi.fn().mockResolvedValue({ ok: true, status: 200,
  json: async () => ({ model: 'jev-1.13.0', answers: { cause: { type: 'choice', choice, confidence: conf, probabilities: {} }, platform_fault: { type: 'noul', noul: pf } } }) });

beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); process.env.TYPESAFE_API_KEY = 'k'; resetTypesafeBreaker();
  const run = (id: string, status: string, gates: unknown) => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, created_at, updated_at)
    VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', ?, ?, ?, ?)`).run(id, status, JSON.stringify(gates), now(), now());
  run('r-blocked', 'blocked', [{ name: 'checker_verdict', status: 'fail', evidence: 'insufficient_evidence: No diff available' }, { name: 'tests', status: 'pass' }]);
  run('r-ok', 'completed', []);
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
    VALUES ('l1', 'r-blocked', 'checker', 'opencode', 'completed', ?, ?, ?)`).run(JSON.stringify({ verdict: 'insufficient_evidence', notes: 'Maker diff artifact is missing' }), now(), now());
  db.prepare(`INSERT INTO loop_events (id, loop_run_id, event_type, level, message, created_at) VALUES ('e1', 'r-blocked', 'checker_dispatch_failed', 'warning', 'Automated checker dispatch failed: CHECKER_LEASE_NOT_FOUND', ?)`).run(now());
});
afterEach(() => { delete process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_FAILURE_CAUSE_MODE; vi.unstubAllGlobals(); db.close(); });

it('collects only failed/blocked runs, with failed gates and worker verdicts as evidence', () => {
  const pending = new DreamStateService(db).pendingFailures();
  expect(pending.map((p) => p.id)).toEqual(['r-blocked']);
  const run = (pending[0].state as { run: { failed_gates: string[]; workers: Array<{ verdict: string }> } }).run;
  expect(run.failed_gates).toEqual(['checker_verdict: insufficient_evidence: No diff available']);
  expect(run.workers[0].verdict).toBe('insufficient_evidence');
  expect((pending[0].state as { run: { events: string[] } }).run.events).toEqual(['checker_dispatch_failed: Automated checker dispatch failed: CHECKER_LEASE_NOT_FOUND']);
});

it('shows a failed worker its own error (redacted stderr tail, exit status) and skips runs that never had a worker', () => {
  const err = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dream-')), 'stderr.log');
  const key = 'ghp_' + 'x'.repeat(36);
  fs.writeFileSync(err, `${'noise '.repeat(2000)}\nError: EACCES: permission denied, open '/data/loop-worktrees/a/.git/index' token=${key}\n`);
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES ('r-maker', 'doc-drift-and-small-fix-loop', 'closed', 'blocked', '[]', ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('l2', 'r-maker', 'maker', 'opencode', 'failed', ?, ?, ?)`)
    .run(JSON.stringify({ exit_status: 1, timed_out: false, stderr_path: err }), now(), now());
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES ('r-empty', 'doc-drift-and-small-fix-loop', 'closed', 'blocked', ?, ?, ?)`)
    .run(JSON.stringify([{ name: 'artifact_minimums', status: 'pending' }]), now(), now());
  const pending = new DreamStateService(db).pendingFailures();
  expect(pending.map((p) => p.id).sort()).toEqual(['r-blocked', 'r-maker']);
  const maker = (pending.find((p) => p.id === 'r-maker')!.state as { run: { workers: Array<Record<string, unknown>> } }).run.workers[0];
  expect(maker.exit_status).toBe(1);
  expect(maker.stderr_tail).toContain('EACCES: permission denied');
  expect(maker.stderr_tail).not.toContain(key);
  expect(String(maker.stderr_tail).length).toBeLessThanOrEqual(600);
});

it('off by default; in shadow it classifies each failed run once', async () => {
  const f = reply('missing_context', 0.9, 0.8); vi.stubGlobal('fetch', f);
  const svc = new DreamStateService(db);
  expect(await svc.replay()).toEqual({ candidates: 0, classified: 0 });
  expect(f).not.toHaveBeenCalled();
  process.env.TYPESAFE_FAILURE_CAUSE_MODE = 'shadow';
  expect(await svc.replay()).toMatchObject({ candidates: 1, classified: 1 });
  expect(db.prepare("SELECT decision, reason FROM judgments WHERE judgment = 'failure_cause'").get())
    .toEqual({ decision: 'yes', reason: 'cause=missing_context conf=0.90 platform_fault=0.80' });
  expect(await svc.replay()).toMatchObject({ candidates: 0, classified: 0 }); // never twice
});

it('an uncertain classification gets exactly one more try', async () => {
  process.env.TYPESAFE_FAILURE_CAUSE_MODE = 'shadow';
  vi.stubGlobal('fetch', reply('wrong_approach', 0.3, 0.5));
  const svc = new DreamStateService(db);
  expect(await svc.replay()).toMatchObject({ candidates: 1, classified: 1 }); // uncertain
  expect(await svc.replay()).toMatchObject({ candidates: 1, classified: 1 }); // one retry
  expect(await svc.replay()).toMatchObject({ candidates: 0, classified: 0 }); // then done
});

it('a cause that recurs at the same gate becomes one engineering-rule memory candidate, once', () => {
  const add = (id: string, reason: string) => {
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', 'blocked', ?, ?, ?)`)
      .run(id, JSON.stringify([{ name: 'checker_verdict', status: 'fail' }]), now(), now());
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'failure_cause', 'loop_run', ?, 'h', 'shadow', 'yes', ?, ?)`)
      .run(`j-${id}`, id, reason, now());
  };
  add('c1', 'cause=environment_noise conf=0.80 platform_fault=0.90');
  add('c2', 'cause=environment_noise conf=0.75 platform_fault=0.85');
  add('c3', 'cause=wrong_approach conf=0.70 platform_fault=0.10'); // once only: no rule
  const svc = new DreamStateService(db);
  expect(svc.consolidate()).toBe(1);
  expect(db.prepare("SELECT title, memory_type FROM memory_candidates WHERE source_ref LIKE 'dream:cause:%'").all())
    .toEqual([{ title: 'Recurring loop failure: environment_noise at checker_verdict', memory_type: 'engineering_rule' }]);
  expect(svc.consolidate()).toBe(0); // not again within the window
});

it('with DREAM_STATE_PROPOSALS_ENABLED a recurring platform cause also yields one grounded fix proposal', () => {
  process.env.DREAM_STATE_PROPOSALS_ENABLED = 'true';
  try {
    for (const id of ['p1', 'p2']) {
      db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', 'blocked', ?, ?, ?)`)
        .run(id, JSON.stringify([{ name: 'checker_verdict', status: 'fail' }]), now(), now());
      db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'failure_cause', 'loop_run', ?, 'h', 'shadow', 'yes', 'cause=parse_error conf=0.80 platform_fault=0.90', ?)`)
        .run(`jp-${id}`, id, now());
    }
    new DreamStateService(db).consolidate();
    const p = db.prepare("SELECT source, status, grounding_json FROM self_improvements WHERE source = 'dream_state'").all() as Array<{ source: string; status: string; grounding_json: string }>;
    expect(p).toHaveLength(1);
    expect(JSON.parse(p[0].grounding_json).target).toBe('packages/server/src/services/loop-service.ts');
    expect(p[0].status).toBe('proposed'); // goes to the specialist panel like every proposal
  } finally { delete process.env.DREAM_STATE_PROPOSALS_ENABLED; }
});

it('every pass ends in exactly one verdict and one ledger row (G13a, after dream-machine)', async () => {
  expect(dreamVerdict({ candidates: 3, classified: 3, confident: 2, consolidated: 1 }).verdict).toBe('ACCEPT');
  expect(dreamVerdict({ candidates: 0, classified: 0, confident: 0, consolidated: 0 }).verdict).toBe('INCONCLUSIVE');
  expect(dreamVerdict({ candidates: 2, classified: 0, confident: 0, consolidated: 0 })).toEqual({ verdict: 'INCONCLUSIVE', reason: '2 candidate(s), but the judge returned nothing' });
  expect(dreamVerdict({ candidates: 2, classified: 2, confident: 0, consolidated: 0 }).verdict).toBe('REJECT');

  process.env.TYPESAFE_FAILURE_CAUSE_MODE = 'shadow';
  vi.stubGlobal('fetch', reply('missing_context', 0.9, 0.8));
  const svc = new DreamStateService(db);
  expect((await svc.replay()).verdict).toBe('REJECT');       // examined one run, no cause recurs yet
  expect((await svc.replay()).verdict).toBe('INCONCLUSIVE'); // nothing new to examine
  expect(svc.ledger().map((r) => [r.verdict, r.candidates, r.confident])).toEqual([['INCONCLUSIVE', 0, 0], ['REJECT', 1, 1]]);
});

it('N9: at most one pass per interval, however often the service restarts', async () => {
  const svc = new DreamStateService(db);
  expect(svc.due(6 * 3600_000)).toBe(true);
  db.prepare("INSERT INTO dream_ledger (created_at, verdict, reason, candidates, classified, confident, consolidated) VALUES (?, 'INCONCLUSIVE', 'x', 0, 0, 0, 0)").run(new Date(Date.now() - 3600_000).toISOString());
  expect(svc.due(6 * 3600_000)).toBe(false);
  expect(svc.due(6 * 3600_000, Date.now() + 6 * 3600_000)).toBe(true);
});
