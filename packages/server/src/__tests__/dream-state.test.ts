import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { resetTypesafeBreaker } from '../services/typesafe-client';
import { DreamStateService } from '../services/dream-state-service';

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

it('off by default; in shadow it classifies each failed run once', async () => {
  const f = reply('missing_context', 0.9, 0.8); vi.stubGlobal('fetch', f);
  const svc = new DreamStateService(db);
  expect(await svc.replay()).toEqual({ candidates: 0, classified: 0 });
  expect(f).not.toHaveBeenCalled();
  process.env.TYPESAFE_FAILURE_CAUSE_MODE = 'shadow';
  expect(await svc.replay()).toEqual({ candidates: 1, classified: 1 });
  expect(db.prepare("SELECT decision, reason FROM judgments WHERE judgment = 'failure_cause'").get())
    .toEqual({ decision: 'yes', reason: 'cause=missing_context conf=0.90 platform_fault=0.80' });
  expect(await svc.replay()).toEqual({ candidates: 0, classified: 0 }); // never twice
});

it('an uncertain classification gets exactly one more try', async () => {
  process.env.TYPESAFE_FAILURE_CAUSE_MODE = 'shadow';
  vi.stubGlobal('fetch', reply('wrong_approach', 0.3, 0.5));
  const svc = new DreamStateService(db);
  expect(await svc.replay()).toEqual({ candidates: 1, classified: 1 }); // uncertain
  expect(await svc.replay()).toEqual({ candidates: 1, classified: 1 }); // one retry
  expect(await svc.replay()).toEqual({ candidates: 0, classified: 0 }); // then done
});
