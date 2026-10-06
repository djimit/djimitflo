import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BASELINE_GENOME, holdout, holdoutEpoch, mutantHoldout, mutantHoldoutKeys } from '../services/genome-registry';
import { dreamInputs, ePaired, eValue, evaluateTrials } from '../services/dream-evolution';
import { rng } from '../services/gym-mutants';
import type { GymTask } from '../services/gym-task-miner';
import type { MutantTask } from '../services/gym-mutants';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON'); vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true'); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const tasks = (n: number, prefix = 'c'): GymTask[] => Array.from({ length: n }, (_, i) => ({ commit: `${prefix}${String(i).padStart(3, '0')}`, source: 's.ts', tests: ['t.test.ts'], sourceLines: 5 }));
const trial = (id: string) => db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, ?, 'strategy_lines', '[\"x\"]', 'dream', 'trial', ?, ?)")
  .run(id, BASELINE_GENOME, '2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z');
let seq = 0;
const mutant = (tier: number): MutantTask => ({ commit: `mut:b:s.ts:${tier}:${++seq}`, base: 'b', source: 's.ts', tests: ['t.test.ts'], sourceLines: 5, mutant: 'x', tier });

it('RX-12: the default epoch reproduces today\'s frozen holdout', () => {
  const first = holdout(db, tasks(60));
  expect(first).toHaveLength(20);
  expect(holdoutEpoch(db, 'gym_holdout')).toBe(0);
  expect(holdout(db, tasks(60, 'z'))).toEqual(first); // frozen: new tasks never change it
  expect((db.prepare('SELECT DISTINCT epoch FROM gym_holdout').all() as Array<{ epoch: number }>).map((r) => r.epoch)).toEqual([0]);
});

it('RX-12: a new epoch freezes fresh tasks beside the old ones (nothing deleted)', () => {
  const e0 = holdout(db, tasks(60));
  vi.stubEnv('GYM_HOLDOUT_EPOCH', '1');
  const e1 = holdout(db, tasks(60));
  expect(e1).toHaveLength(20);
  expect(e1.some((c) => e0.includes(c))).toBe(false);
  expect((db.prepare('SELECT COUNT(*) AS n FROM gym_holdout').get() as { n: number }).n).toBe(40);
  const m1 = mutantHoldout(db, (tier) => mutant(tier));
  vi.stubEnv('GYM_HOLDOUT_EPOCH', '0');
  expect(holdout(db, [])).toEqual(e0);
  expect(mutantHoldoutKeys(db)).toEqual([]); // the epoch-1 mutants belong to epoch 1 only
  vi.stubEnv('GYM_HOLDOUT_EPOCH', '1');
  expect(mutantHoldoutKeys(db)).toEqual(m1.map((m) => m.commit).sort());
});

it('RX-12: rotation is refused while a genome is in trial — the old epoch stays', () => {
  const e0 = holdout(db, tasks(60));
  trial('g-t');
  vi.stubEnv('GYM_HOLDOUT_EPOCH', '1');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(holdoutEpoch(db, 'gym_holdout')).toBe(0);
  expect(holdout(db, tasks(60))).toEqual(e0);
  expect((db.prepare('SELECT COUNT(*) AS n FROM gym_holdout WHERE epoch = 1').get() as { n: number }).n).toBe(0);
});

it('RX-12: holdout tasks of every epoch never reach dream inputs', () => {
  holdout(db, tasks(60));
  vi.stubEnv('GYM_HOLDOUT_EPOCH', '1');
  const e1 = holdout(db, tasks(60));
  const all = (db.prepare('SELECT commit_sha FROM gym_holdout').all() as Array<{ commit_sha: string }>).map((r) => r.commit_sha);
  const fail = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, datetime('now'), datetime('now'))`);
  [...all, 'not-a-holdout'].forEach((c, i) => fail.run(`f${i}`, JSON.stringify({ gym: { commit: c, source: c, species: 'atomic@llama-router' }, gym_result: { status: 'failure', reason: 'tests still red' } })));
  const text = JSON.stringify(dreamInputs(db));
  expect(text).toContain('not-a-holdout');
  for (const c of [...all, ...e1]) expect(text).not.toContain(c);
});

it('RX-13: the mixture e-value matches its closed form', () => {
  expect(eValue(10, 8)).toBeCloseTo(4.0, 2);
  expect(eValue(20, 16)).toBeCloseTo(20.54, 1);
  expect(Math.abs(eValue(20, 17) - 87.5)).toBeLessThan(0.5);
  expect(ePaired([1, 1, 1, 1, 1, 1, 1, 1, -1, -1])).toBeCloseTo(eValue(10, 8), 10);
  expect(eValue(0, 0)).toBe(1);
});

it('RX-13: looking after every pair keeps the false-promotion rate ≤ alpha under the null (10 000 seeded runs)', () => {
  const random = rng(20261006);
  let rejected = 0;
  for (let run = 0; run < 10_000; run++) {
    const pairs: Array<1 | -1> = [];
    for (let i = 0; i < 60; i++) { pairs.push(random() < 0.5 ? 1 : -1); if (ePaired(pairs) >= 20) { rejected++; break; } }
  }
  expect(rejected / 10_000).toBeLessThanOrEqual(0.05);
});

it('RX-13: DREAM_PROMOTION_RULE=both records the e-process decision and never changes the promotion', () => {
  const run = (rule: string | undefined) => {
    db.close(); db = new Database(':memory:'); db.exec(schema); runMigrations(db);
    if (rule) vi.stubEnv('DREAM_PROMOTION_RULE', rule); else vi.unstubAllEnvs();
    vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true');
    db.prepare("INSERT OR IGNORE INTO maker_genomes (id, gene, lines_json, origin, status, created_at, updated_at) VALUES (?, 'baseline', '[]', 'baseline', 'active', ?, ?)").run(BASELINE_GENOME, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
    trial('g-e');
    const commits = Array.from({ length: 20 }, (_, i) => `h${i}`);
    const ins = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`);
    commits.forEach((c, i) => {
      const meta = (genome: string, ok: boolean) => JSON.stringify({ gym: { commit: c, species: 'atomic@llama-router', genome }, gym_result: { status: ok ? 'success' : 'failure', reason: ok ? 'tests green' : 'tests still red' } });
      ins.run(`p${i}`, meta(BASELINE_GENOME, i >= 10), `2026-10-05T11:${String(i).padStart(2, '0')}:00Z`, `2026-10-05T11:${String(i).padStart(2, '0')}:00Z`);
      ins.run(`m${i}`, meta('g-e', i !== 0), `2026-10-05T12:${String(i).padStart(2, '0')}:00Z`, `2026-10-05T12:${String(i).padStart(2, '0')}:00Z`);
    });
    return evaluateTrials(db, 'atomic@llama-router', commits, Date.parse('2026-10-05T13:00:00Z'));
  };
  const plain = run(undefined);
  const both = run('both');
  expect(both).toEqual(plain);
  const row = db.prepare('SELECT e_value, n_discordant, e_rule_decision FROM genome_trial_results WHERE trial_id = ?').get('g-e') as { e_value: number; n_discordant: number; e_rule_decision: string };
  expect(row.n_discordant).toBe(9); // 9 wins, 0 losses
  expect(row.e_value).toBeCloseTo(eValue(9, 9), 6);
  expect(['promote', 'hold']).toContain(row.e_rule_decision);
});
