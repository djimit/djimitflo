import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { chooseSpecies } from '../services/runtime-bandit';
import { rng } from '../services/gym-mutants';
import { banditOpe, offPolicyValue, propensities, type OpeRow } from '../services/bandit-propensity';

let db: Database.Database;
afterEach(() => db?.close());
const fixture = (arms: Array<{ runtime: string; model?: string; runs: number; ok: number }>) => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON'); new SkillEvolutionEngine(db);
  const ins = db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, model, created_at) VALUES (?, ?, ?, 'loop', ?, '2026-10-01T00:00:00Z')");
  let id = 0;
  for (const a of arms) for (let i = 0; i < a.runs; i++) ins.run(`o${id++}`, `loop-maker:test-gap:${a.runtime}`, i < a.ok ? 1 : 0, a.model ?? null);
};

it('RX-15: propensities sum to 1 and match a direct simulation of chooseSpecies (incumbent, capped challenger, promoted challenger)', () => {
  for (const arms of [
    [{ runtime: 'opencode', runs: 30, ok: 10 }, { runtime: 'remote', model: 'ws/atomic', runs: 5, ok: 4 }], // challenger capped (< 20 runs)
    [{ runtime: 'opencode', runs: 30, ok: 10 }, { runtime: 'remote', model: 'ws/atomic', runs: 25, ok: 20 }], // challenger promoted
  ]) {
    fixture(arms);
    const p = propensities(arms.map((a) => ({ species: a.model ? `${a.runtime}@${a.model}` : a.runtime, runs: a.runs, ok: a.ok })), 0.1, 20_000, 3);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    const species = arms.map((a) => ({ runtime: a.runtime, ...(a.model ? { model: a.model } : {}) }));
    const r = rng(11); let challenger = 0; const N = 20_000;
    for (let i = 0; i < N; i++) if (chooseSpecies(db, 'test-gap', species, r, 0.1)!.species.runtime === 'remote') challenger++;
    expect(Math.abs(p[1] - challenger / N)).toBeLessThan(0.015);
    db.close();
  }
});

it('RX-15: a target policy equal to the logged one has value difference 0; few rows are insufficient (ESS < 30)', () => {
  const rows: OpeRow[] = Array.from({ length: 40 }, (_, i) => ({ run_id: `r${i}`, chosen: i % 3 ? 'a' : 'b', propensity: i % 3 ? 0.9 : 0.1, target_prob: i % 3 ? 0.9 : 0.1, reward: i % 2 }));
  const same = offPolicyValue(rows);
  expect(same.difference).toBe(0); expect(same.status).toBe('ok');
  const tiny = offPolicyValue(rows.slice(0, 10));
  expect(tiny.status).toBe('insufficient'); expect(tiny.ess).toBeLessThan(30);
  expect(offPolicyValue([]).status).toBe('insufficient');
});

it('RX-15: banditOpe joins logged choices to outcomes and the fitness view; events without state are counted, not guessed', () => {
  fixture([{ runtime: 'opencode', runs: 30, ok: 10 }]);
  const run = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'test-gap', 'closed', 'completed', '[]', '{}', '[]', '[]', '{}', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')`);
  const ev = db.prepare("INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, ?, 'info', ?, ?, ?)");
  const posterior = [{ species: 'opencode', runs: 30, ok: 10, sample: 0.3 }, { species: 'remote@ws/atomic', runs: 5, ok: 4, sample: 0.2 }];
  run.run('r1'); ev.run('e1', 'r1', 'bandit_selected', 'Maker species opencode: incumbent sampled best', JSON.stringify({ posterior, chosen: 'opencode', max_share: 0.1 }), '2026-10-02T00:00:01Z');
  ev.run('e2', 'r1', 'fitness_shadow', 'Fitness view would pick opencode', JSON.stringify({ would_pick: 'opencode' }), '2026-10-02T00:00:01Z');
  db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, task_id, created_at) VALUES ('x1', 'loop-maker:test-gap:opencode', 1, 'loop', 'r1', '2026-10-02T01:00:00Z')").run();
  run.run('r2'); ev.run('e3', 'r2', 'bandit_selected', 'Maker species opencode: incumbent sampled best', JSON.stringify({}), '2026-10-02T00:00:02Z'); // pre-RX-15 event without posterior
  const o = banditOpe(db, {});
  expect(o).toMatchObject({ events: 2, reconstructable: 1, not_reconstructable: 1, assumed_max_share: 0, n: 1, status: 'insufficient' });
  expect(o.target_value).toBe(1);
});
