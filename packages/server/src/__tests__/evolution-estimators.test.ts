import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { quantile, runEstimators, startEvolutionEstimators } from '../services/evolution-estimators';
import { detectStalls } from '../services/stall-watch';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { rng } from '../services/gym-mutants';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const hAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const ON = { EVOLUTION_ESTIMATORS_ENABLED: 'true' } as NodeJS.ProcessEnv;
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON'); new SkillEvolutionEngine(db); });
afterEach(() => db.close());

const run = (id: string, metadata: object, createdAt: string, loopName = 'test-gap') => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
  VALUES (?, ?, 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(id, loopName, JSON.stringify(metadata), createdAt, createdAt);
const row = (estimator: string, scope: string) => db.prepare('SELECT * FROM evolution_estimates WHERE estimator = ? AND scope = ?').get(estimator, scope) as
  { value: number | null; ci_low: number | null; ci_high: number | null; n: number; status: string; detail_json: string } | undefined;

it('RX-14: nearest-rank quantiles recover known values', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1);
  expect(quantile(xs, 0.5)).toBe(50); expect(quantile(xs, 0.9)).toBe(90); expect(quantile(xs, 1)).toBe(100);
  expect(quantile([], 0.5)).toBeNull();
});

it('RX-14: seeded synthetic outcomes recover the known delay quantiles and tier pass rates (foreign keys on)', () => {
  // 50 maker runs whose outcome lands exactly (i + 1) hours later → p50 = 25 h, p90 = 45 h
  const out = db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, task_id, created_at) VALUES (?, 'loop-maker:test-gap:opencode', 1, 'loop', ?, ?)");
  for (let i = 0; i < 50; i++) { run(`r${i}`, {}, hAgo(200)); out.run(`o${i}`, `r${i}`, hAgo(200 - (i + 1))); }
  // gym tier 4: 30 attempts, seeded 2/3 success; never-solved task for discriminability
  const random = rng(7); let ok = 0;
  for (let i = 0; i < 30; i++) {
    const success = random() < 2 / 3; if (success) ok++;
    run(`g${i}`, { gym: { commit: `mut:abc:s.ts:4:${i % 10}`, tier: 4 }, gym_result: { status: success ? 'success' : 'failure' } }, hAgo(24), 'evolution-gym');
  }
  run('canary', { gym: { commit: 'mut:abc:c.ts:4:1', tier: 4, canary: 1 }, gym_result: { status: 'success' } }, hAgo(24), 'evolution-gym');
  runEstimators(db, ON, NOW);
  const d = row('delay_run_to_outcome_h', 'loop')!;
  expect(d).toMatchObject({ value: 25, n: 50, status: 'ok' });
  expect(JSON.parse(d.detail_json)).toMatchObject({ p50: 25, p90: 45, max: 50 });
  const t4 = row('gym_pass_rate', 'tier:4')!;
  expect(t4).toMatchObject({ n: 30, status: 'ok' }); // the canary is excluded
  expect(t4.value).toBeCloseTo(ok / 30, 3); // stored at 4 decimals
  expect(t4.ci_low!).toBeLessThan(t4.value!); expect(t4.ci_high!).toBeGreaterThan(t4.value!);
  expect(row('discriminability', 'gym')!.n).toBe(10);
});

it('RX-14: n = 0 is recorded as insufficient with no value, never as 0', () => {
  runEstimators(db, ON, NOW);
  for (const [e, s] of [['delay_run_to_outcome_h', 'loop'], ['delay_pr_open_to_merge_h', 'loop_pr'], ['delay_merge_to_settlement_h', 'loop_pr'], ['discriminability', 'gym'], ['trial_blindness', 'trials']]) {
    expect(row(e, s)).toMatchObject({ value: null, n: 0, status: 'insufficient' });
  }
  expect(row('gate', 'A')).toMatchObject({ status: 'ok' }); // gates are always persisted (state + reason)
});

it('RX-14: a same-day rerun upserts (one row per estimator, scope and day)', () => {
  runEstimators(db, ON, NOW);
  const before = (db.prepare('SELECT COUNT(*) AS n FROM evolution_estimates').get() as { n: number }).n;
  db.prepare("INSERT INTO genome_trial_results (trial_id, state, recorded_at) VALUES ('t1', 'blind', ?)").run(hAgo(5));
  runEstimators(db, ON, NOW + 60_000);
  expect((db.prepare('SELECT COUNT(*) AS n FROM evolution_estimates').get() as { n: number }).n).toBe(before);
  expect(row('trial_blindness', 'trials')).toMatchObject({ value: 1, n: 1, status: 'ok' });
});

it('RX-14: the flag off writes nothing and starts no scheduler; on, the daily tick persists once per UTC day', () => {
  expect(startEvolutionEstimators(db, 3_600_000, {}, () => NOW)).toBeNull();
  expect((db.prepare('SELECT COUNT(*) AS n FROM evolution_estimates').get() as { n: number }).n).toBe(0);
  const stop = startEvolutionEstimators(db, 3_600_000, ON, () => NOW)!;
  const n = (db.prepare('SELECT COUNT(*) AS n FROM evolution_estimates').get() as { n: number }).n;
  expect(n).toBeGreaterThan(0);
  stop();
});

it('RX-14: a stall fires when the flag is on and no estimate was written for 36 h; quiet when fresh or off', () => {
  const stall = (env: NodeJS.ProcessEnv) => detectStalls(db, NOW, env).filter((s) => s.subsystem === 'estimates');
  expect(stall({})).toEqual([]);
  expect(stall(ON)).toHaveLength(1); // on, nothing written yet
  runEstimators(db, ON, NOW - 40 * 3_600_000);
  expect(stall(ON)).toHaveLength(1);
  runEstimators(db, ON, NOW - 3_600_000);
  expect(stall(ON)).toEqual([]);
});

it('RX-14: the evidence endpoint shows the last 14 days per estimator as a trend', () => {
  runEstimators(db, ON, NOW - 2 * 86_400_000); runEstimators(db, ON, NOW - 86_400_000); runEstimators(db, ON, NOW);
  const e = buildEvolutionEvidence(db, ON, NOW);
  const trend = e.estimates.find((t) => t.estimator === 'gate' && t.scope === 'A')!;
  expect(trend.days.map((d) => d.day)).toEqual(['2026-10-04', '2026-10-05', '2026-10-06']);
});
