import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import * as bandit from '../services/bandit-propensity';
import { buildEvolutionEvidence, cachedEvolutionEvidence, EVIDENCE_CACHE_MS } from '../services/evolution-evidence';

// pass-through spy: the real banditOpe runs, the test sees whether (and how often) the evidence build called it
vi.mock('../services/bandit-propensity', async (orig) => {
  const real = await orig<typeof import('../services/bandit-propensity')>();
  return { ...real, banditOpe: vi.fn(real.banditOpe) };
});

const NOW = Date.parse('2026-11-12T19:15:00Z'); // the audit's snapshot: the 30-d window starts 2026-10-13T19:15Z
let db: Database.Database;
afterEach(() => { db?.close(); vi.mocked(bandit.banditOpe).mockClear(); });

const fresh = () => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); new SkillEvolutionEngine(db); return db; };

/** n logged bandit decisions, each with a fitness_shadow event and the maker outcome — what banditOpe replays */
function banditEvents(n: number) {
  const run = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'test-gap', 'closed', 'completed', '[]', '{}', '[]', '[]', '{}', ?, ?)`);
  const ev = db.prepare("INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, ?, 'info', ?, ?, ?)");
  const out = db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, task_id, created_at) VALUES (?, 'loop-maker:test-gap:opencode', ?, 'loop', ?, ?)");
  const posterior = [{ species: 'opencode', runs: 30, ok: 10 }, { species: 'remote@ws/atomic', runs: 5, ok: 4 }];
  for (let i = 0; i < n; i++) {
    const at = new Date(NOW - (i + 1) * 3_600_000).toISOString(); const id = `r${i}`;
    run.run(id, at, at);
    ev.run(randomUUID(), id, 'bandit_selected', 'Maker species opencode: incumbent sampled best', JSON.stringify({ posterior, chosen: 'opencode', max_share: 0.1 }), at);
    ev.run(randomUUID(), id, 'fitness_shadow', 'Fitness view would pick opencode', JSON.stringify({ would_pick: i % 2 ? 'opencode' : 'remote@ws/atomic' }), at);
    out.run(randomUUID(), i % 3 ? 1 : 0, id, at);
  }
}

it('evolution page load: the default build does not run banditOpe (RX-15 is report-only, no page reads it); ?ope=1 does', () => {
  fresh(); banditEvents(5);
  const e = buildEvolutionEvidence(db, {}, NOW);
  expect(bandit.banditOpe).not.toHaveBeenCalled();
  expect(e.ope).toBeNull();
  // the ledger says the value was not computed here — not 'unknown', and never a number it did not compute
  expect(e.learning_ledger.mechanisms.find((m) => m.mechanism === 'species_selection')?.note).toContain('not computed in this build (GET /api/health/evolution-evidence?ope=1)');
  const withOpe = buildEvolutionEvidence(db, {}, NOW, 30, { ope: true });
  expect(bandit.banditOpe).toHaveBeenCalledTimes(1);
  expect(withOpe.ope).toMatchObject({ events: 5, reconstructable: 5, n: 5 });
  expect(withOpe.learning_ledger.mechanisms.find((m) => m.mechanism === 'species_selection')?.note).toMatch(/fitness-view policy − the logged bandit = -?\d/);
});

it('banditOpe reads the fitness view and the outcomes in one query each, not two lookups per logged decision', () => {
  fresh(); banditEvents(40);
  const prepare = db.prepare.bind(db); const sqls: string[] = [];
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => { sqls.push(sql); return prepare(sql); };
  const o = bandit.banditOpe(db, {});
  expect(o).toMatchObject({ events: 40, reconstructable: 40, not_reconstructable: 0 });
  expect(sqls.filter((s) => s.includes("'fitness_shadow'"))).toHaveLength(1);
  expect(sqls.filter((s) => s.includes('FROM skill_outcomes'))).toHaveLength(1);
});

it('banditOpe matches outcomes as before: same species suffix and model, first outcome by time; others are not reconstructable', () => {
  fresh();
  const run = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'test-gap', 'closed', 'completed', '[]', '{}', '[]', '[]', '{}', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`);
  const ev = db.prepare("INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, ?, 'info', 'm', ?, ?)");
  const out = db.prepare('INSERT INTO skill_outcomes (id, skill_id, success, domain, task_id, model, created_at) VALUES (?, ?, ?, \'loop\', ?, ?, ?)');
  const posterior = [{ species: 'opencode', runs: 30, ok: 10 }, { species: 'remote@ws/atomic', runs: 5, ok: 4 }];
  const decision = (id: string, chosen: string) => {
    run.run(id);
    ev.run(randomUUID(), id, 'bandit_selected', JSON.stringify({ posterior, chosen, max_share: 0.1 }), '2026-11-01T00:00:00Z');
    ev.run(randomUUID(), id, 'fitness_shadow', JSON.stringify({ would_pick: 'remote@ws/atomic' }), '2026-11-01T00:00:00Z'); // older view …
    ev.run(randomUUID(), id, 'fitness_shadow', JSON.stringify({ would_pick: chosen }), '2026-11-01T00:00:01Z'); // … the latest one counts
  };
  decision('a', 'remote@ws/atomic'); // first outcome (failure) counts, the later success does not
  out.run('a1', 'loop-maker:test-gap:remote', 0, 'a', 'ws/atomic', '2026-11-01T01:00:00Z');
  out.run('a2', 'loop-maker:test-gap:remote', 1, 'a', 'ws/atomic', '2026-11-01T02:00:00Z');
  decision('b', 'opencode'); // only an outcome of another species / another model: not reconstructable
  out.run('b1', 'loop-maker:test-gap:remote', 1, 'b', null, '2026-11-01T01:00:00Z');
  out.run('b2', 'loop-maker:test-gap:opencode', 1, 'b', 'other-model', '2026-11-01T01:00:00Z');
  const o = bandit.banditOpe(db, {});
  expect(o).toMatchObject({ events: 2, reconstructable: 1, not_reconstructable: 1, logged_value: 0, target_value: 0 });
});

it('the evidence route cache: one build per window for 5 minutes; fresh or an expired entry rebuilds; ope is cached apart', () => {
  fresh();
  const a = cachedEvolutionEvidence(db, {}, NOW, 30);
  expect(cachedEvolutionEvidence(db, {}, NOW + EVIDENCE_CACHE_MS - 1, 30)).toBe(a);
  expect(cachedEvolutionEvidence(db, {}, NOW + 1, 7)).not.toBe(a); // another window is another entry
  expect(cachedEvolutionEvidence(db, {}, NOW + 2, 30, { ope: true }).ope).not.toBeNull();
  expect(cachedEvolutionEvidence(db, {}, NOW + 3, 30)).toBe(a); // the ope build did not replace the default one
  const b = cachedEvolutionEvidence(db, {}, NOW + 4, 30, { fresh: true });
  expect(b).not.toBe(a); expect(b.at).toBe(new Date(NOW + 4).toISOString());
  expect(cachedEvolutionEvidence(db, {}, NOW + 4 + EVIDENCE_CACHE_MS, 30)).not.toBe(b);
});

const outcome = (ref: string, success: boolean, at: string) => db.prepare(`INSERT INTO skill_outcomes
    (id, skill_id, success, tokens_used, duration_ms, domain, task_id, agent_id, evidence_refs_json, created_at) VALUES (?, 'loop-maker:test-gap:opencode', ?, 1000, 1, 'x', ?, 'a', ?, ?)`)
  .run(randomUUID(), success ? 1 : 0, randomUUID(), JSON.stringify([ref]), at);

it('ACE-001 / STE-001: the evidence section counts the same window as the registry row (the experiment\'s own), not the page window', () => {
  fresh();
  // inside each experiment (ACE-001 from 2026-10-12, STE-001 from 2026-10-11) but before the 30-d page window (2026-10-13T19:15Z)
  outcome('ace-001-arm:00', true, '2026-10-12T12:00:00.000Z'); outcome('ace-001-arm:00', false, '2026-11-01T00:00:00.000Z');
  outcome('ace-001-arm:11', true, '2026-10-13T00:00:00.000Z');
  outcome('ste-001-arm:1', true, '2026-10-11T12:00:00.000Z'); outcome('ste-001-arm:1', true, '2026-11-02T00:00:00.000Z');
  outcome('ace-001-arm:01', true, '2026-10-01T00:00:00.000Z'); // before ACE-001's analysis window: excluded by both readings
  const e = buildEvolutionEvidence(db, { ACE_001_MODE: 'on', STE_001_MODE: 'on' }, NOW, 30);
  const row = (id: string) => e.experiments.experiments.find((x) => x.id === id)!;
  expect(Object.fromEntries(Object.entries(e.ace_001.arms).map(([k, v]) => [k, v.n]))).toEqual(row('ACE-001').n_per_arm);
  expect(e.ace_001.arms['00'].n).toBe(2); expect(e.ace_001.arms['11'].n).toBe(1); expect(e.ace_001.arms['01'].n).toBe(0);
  expect(row('STE-001').n_per_arm).toEqual({ 0: e.ste_001.arms['0'].n, 1: e.ste_001.arms['1'].n });
  expect(e.ste_001.arms['1'].n).toBe(2);
  // a later ACE_001_ANALYSIS_SINCE (Amendment 1) still applies to the section, as to the registry row
  const late = buildEvolutionEvidence(db, { ACE_001_MODE: 'on', ACE_001_ANALYSIS_SINCE: '2026-10-20T00:00:00Z' }, NOW, 30);
  expect(late.ace_001.arms['00'].n).toBe(1); expect(late.ace_001.arms['11'].n).toBe(0);
  expect(Object.fromEntries(Object.entries(late.ace_001.arms).map(([k, v]) => [k, v.n]))).toEqual(late.experiments.experiments.find((x) => x.id === 'ACE-001')!.n_per_arm);
});
