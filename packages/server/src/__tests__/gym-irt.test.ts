import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { fisherInformation, fitIrt, gymObservations, pickInformativeItems, probability, type Observation } from '../services/gym-irt';
import { HOLDOUT_SIZE, holdout } from '../services/genome-registry';
import { rng } from '../services/gym-mutants';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON'); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

/** 5 items of known difficulty (b −2 … 2, a 1.5) plus one item every respondent solves; 60 respondents with seeded abilities. */
function synthetic(): Observation[] {
  const r = rng(42); const obs: Observation[] = [];
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-9))) * Math.cos(2 * Math.PI * r());
  const bs = [-2, -1, 0, 1, 2];
  for (let j = 0; j < 60; j++) {
    const theta = normal();
    for (let rep = 0; rep < 3; rep++) {
      bs.forEach((b, i) => obs.push({ item: `item-${i}`, respondent: `r${j}`, y: r() < probability(1.5, b, theta) ? 1 : 0 }));
      obs.push({ item: 'all-pass', respondent: `r${j}`, y: 1 });
    }
  }
  return obs;
}

it('B8-IRT: the 2PL fit recovers the order of known difficulties and flags an all-pass task as non-discriminating', () => {
  const fit = fitIrt(synthetic());
  const byKey = new Map(fit.items.map((it) => [it.key, it]));
  const fitted = [0, 1, 2, 3, 4].map((i) => byKey.get(`item-${i}`)!);
  for (let i = 1; i < fitted.length; i++) expect(fitted[i].b).toBeGreaterThan(fitted[i - 1].b); // harder item → higher b
  expect(fitted.every((it) => it.flag === 'ok' && it.a > 0.3)).toBe(true);
  expect(byKey.get('all-pass')!.flag).toBe('non_discriminating');
});

it('B8-IRT: Fisher information peaks at the item difficulty', () => {
  const a = 1.5; const b = 0.7;
  const grid = Array.from({ length: 81 }, (_, i) => -4 + i * 0.1);
  const best = grid.reduce((x, t) => (fisherInformation(a, b, t) > fisherInformation(a, b, x) ? t : x), grid[0]);
  expect(Math.abs(best - b)).toBeLessThanOrEqual(0.1);
  expect(fisherInformation(a, b, b)).toBeCloseTo((a * a) / 4, 6);
});

it('B8-IRT: pickInformativeItems takes discriminating items closest in difficulty to θ and never an excluded key', () => {
  const items = fitIrt(synthetic()).items;
  const top = pickInformativeItems(items, 0, 2);
  expect(top.map((t) => t.key)).toContain('item-2');
  expect(top.some((t) => t.key === 'all-pass')).toBe(false);
  expect(pickInformativeItems(items, 0, 5, ['item-2']).map((t) => t.key)).not.toContain('item-2');
});

const TASK = (commit: string) => ({ commit, source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 });
const TASKS = Array.from({ length: 40 }, (_, i) => TASK(`c${String(i).padStart(2, '0')}`));
function seedAttempts() {
  // c30–c39 discriminate (half the respondents solve them); every other task is solved by everyone
  const run = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, datetime('now'), datetime('now'))`);
  let id = 0;
  for (const t of TASKS) for (let j = 0; j < 8; j++) {
    const ok = Number(t.commit.slice(1)) >= 30 ? j % 2 === 0 : true;
    run.run(`r${id++}`, JSON.stringify({ gym: { commit: t.commit, species: j < 4 ? 'atomic@llama-router' : 'opencode', genome: j % 4 === 1 ? 'g-x' : null }, gym_result: { status: ok ? 'success' : 'failure' } }));
  }
}

it('B8-IRT: with GYM_IRT_SELECTION off the holdout freeze is the deterministic spread, exactly as before', () => {
  seedAttempts();
  expect(gymObservations(db)).toHaveLength(320);
  const frozen = holdout(db, TASKS);
  expect(frozen).toHaveLength(HOLDOUT_SIZE);
  expect(frozen[0]).toBe('c00'); expect(frozen[1]).toBe('c02'); // every 2nd task, as in the Y3 test
});

it('B8-IRT: with GYM_IRT_SELECTION on a new epoch prefers the discriminating tasks, then fills with the spread', () => {
  seedAttempts();
  vi.stubEnv('GYM_IRT_SELECTION', 'true');
  const frozen = holdout(db, TASKS);
  expect(frozen).toHaveLength(HOLDOUT_SIZE);
  const discriminating = TASKS.filter((t) => Number(t.commit.slice(1)) >= 30).map((t) => t.commit);
  expect(discriminating.every((c) => frozen.includes(c))).toBe(true); // all 10 informative tasks are in
  expect(holdout(db, [TASK('zz')])).toEqual(frozen); // frozen once
});
