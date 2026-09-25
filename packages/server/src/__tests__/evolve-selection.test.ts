import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evolveEligible, evolveSpecies, selectEvolveWinner } from '../services/evolve-selection';

let db: Database.Database;
const now = new Date().toISOString();
const maker = (id: string, runtime: string, meta: object) => db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, 'run-1', 'maker', ?, 'completed', ?, ?, ?)`)
  .run(id, runtime, JSON.stringify(meta), now, now);
const reviewer = (id: string, role: string, makerId: string) => db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, 'run-1', ?, 'manual', 'prepared', ?, ?, ?)`)
  .run(id, role, JSON.stringify({ maker_lease_id: makerId }), now, now);
const meta = (id: string) => JSON.parse((db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(id) as { metadata: string }).metadata);
const status = (id: string) => (db.prepare('SELECT status FROM worker_leases WHERE id = ?').get(id) as { status: string }).status;
const ok = (diff: number, extra: object = {}) => ({ exit_status: 0, deterministic_checks: [{ name: 'test', status: 'pass' }], diff_lines: diff, diff_max_lines: 200, completed_at: now, ...extra });

beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES ('run-1', 'doc-drift-and-small-fix-loop', 'closed', 'running', '[]', ?, ?)`).run(now, now);
});
afterEach(() => db.close());

it('species come from LOOP_EVOLVE_SPECIES only when enabled, at most two extra makers', () => {
  expect(evolveSpecies({ LOOP_EVOLVE_SPECIES: 'codex' })).toEqual([]);
  expect(evolveSpecies({ LOOP_EVOLVE_ENABLED: 'true', LOOP_EVOLVE_SPECIES: 'opencode@ollama/kimi-k2.6:cloud, codex, pi' }))
    .toEqual([{ runtime: 'opencode', model: 'ollama/kimi-k2.6:cloud' }, { runtime: 'codex' }]);
});

it('only test-gap goals (or goals marked evolve) are eligible', () => {
  const si = (id: string, refs: string[]) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, created_at, updated_at) VALUES (?, 'feature', 't', 'd', 'r', 'gap_analysis', 'executing', 0.5, ?, ?, ?)`).run(id, JSON.stringify(refs), now, now);
  const goal = (id: string, improvementId: string | null, metadata: object = {}) => db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'running', ?, ?, ?, ?)`).run(id, JSON.stringify(metadata), improvementId, now, now);
  si('p-tg', ['test-gap:board-protocol']); si('p-other', ['reflection:x']); si('p-mut', ['mutation-gap:secret-patterns']);
  goal('g-tg', 'p-tg'); goal('g-other', 'p-other'); goal('g-flag', null, { evolve: true }); goal('g-mut', 'p-mut');
  expect([evolveEligible(db, 'g-tg'), evolveEligible(db, 'g-other'), evolveEligible(db, 'g-flag'), evolveEligible(db, 'g-mut')]).toEqual([true, false, true, true]);
});

it('the fittest maker stays the only non-superseded one; losers are superseded and their reviewers cancelled', () => {
  maker('m-a', 'opencode', ok(80, { superseded_by_maker_lease_id: 'm-b' })); reviewer('c-a', 'checker', 'm-a'); reviewer('s-a', 'security_checker', 'm-a');
  maker('m-b', 'opencode', ok(40, { model: 'ollama/kimi-k2.6:cloud' })); reviewer('c-b', 'checker', 'm-b');
  maker('m-c', 'codex', { ...ok(10), exit_status: 1 }); reviewer('c-c', 'checker', 'm-c'); // smallest diff, but failed: not eligible

  expect(selectEvolveWinner(db, 'run-1', ['m-a', 'm-b', 'm-c'])).toBe('m-b');
  expect(meta('m-b').superseded_by_maker_lease_id).toBeUndefined();
  expect(meta('m-b').evolve).toMatchObject({ rank: 1, species: 'opencode@ollama/kimi-k2.6:cloud', reason: 'winner' });
  expect(meta('m-a').superseded_by_maker_lease_id).toBe('m-b');
  expect(meta('m-c').evolve.reason).toBe('runtime exit != 0');
  expect([status('c-a'), status('s-a'), status('c-c'), status('c-b')]).toEqual(['cancelled', 'cancelled', 'cancelled', 'prepared']);
  expect(db.prepare("SELECT event_type FROM loop_events WHERE loop_run_id = 'run-1'").all()).toEqual([{ event_type: 'evolve_selected' }]);
});

it('no eligible maker: nothing changes and the run fails like a single-maker run', () => {
  maker('m-a', 'opencode', { exit_status: 1 }); reviewer('c-a', 'checker', 'm-a');
  expect(selectEvolveWinner(db, 'run-1', ['m-a'])).toBeNull();
  expect(status('c-a')).toBe('prepared');
  expect(db.prepare("SELECT event_type FROM loop_events WHERE loop_run_id = 'run-1'").get()).toEqual({ event_type: 'evolve_no_winner' });
});

it('N7: losing species are recorded as outcomes, and a measured mutation score outranks a smaller diff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-'));
  const out = (score: number) => { const f = path.join(dir, `${score}.log`); fs.writeFileSync(f, `{"mutation_gain":{"before":30,"after":${score},"pass":true}}\n`); return f; };
  const mut = (diff: number, score: number, extra: object = {}) => ok(diff, { deterministic_checks: [{ name: 'test', status: 'pass' }, { name: 'test:mutation:grounded', status: 'pass', stdout_path: out(score) }], ...extra });
  maker('m-small', 'opencode', mut(10, 45)); maker('m-strong', 'codex', mut(60, 70, { model: 'gpt-5' }));
  expect(selectEvolveWinner(db, 'run-1', ['m-small', 'm-strong'])).toBe('m-strong');
  expect(db.prepare('SELECT skill_id, success, agent_id FROM skill_outcomes').all()).toEqual([{ skill_id: 'loop-maker:doc-drift-and-small-fix-loop:opencode', success: 0, agent_id: 'm-small' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});
