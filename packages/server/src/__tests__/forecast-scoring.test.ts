import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { auc, forecastOf, forecastScores } from '../services/forecast-scoring';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());

const t = (min: number) => new Date(Date.now() - 86_400_000 + min * 60_000).toISOString();
const proposal = (id: string, source: string, status: string, goalAtMin: number | null = null) => {
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at) VALUES (?, 'feature', ?, 'd', 'r', ?, ?, 0.5, ?, ?)`).run(id, id, source, status, t(0), t(0));
  if (goalAtMin !== null) db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'completed', '{}', ?, ?, ?)").run(`g-${id}`, id, t(goalAtMin), t(goalAtMin));
};
const forecast = (judgment: string, subject: string, answers: object, atMin: number) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
  VALUES (?, ?, 'self_improvement', ?, '', 'shadow', 'yes', '', ?, ?)`).run(`${judgment}-${subject}-${atMin}`, judgment, subject, JSON.stringify(answers), t(atMin));

it('scores a perfect forecaster above the per-source baseline and an anti-forecaster below it', () => {
  for (let i = 0; i < 10; i++) proposal(`gap${i}`, 'gap_analysis', i < 3 ? 'verified' : 'needs_more_evidence', 30);
  for (let i = 0; i < 10; i++) {
    forecast('forecast:good', `gap${i}`, { p: i < 3 ? 0.9 : 0.05 }, 10);
    forecast('forecast:bad', `gap${i}`, { p: i < 3 ? 0.05 : 0.9 }, 10);
  }
  const s = Object.fromEntries(forecastScores(db).map((x) => [x.forecaster, x]));
  expect(s['forecast:good']).toMatchObject({ n: 10, positives: 3, auc: 1 });
  expect(s['forecast:good'].skill).toBeGreaterThan(0.8);
  expect(s['forecast:bad'].skill).toBeLessThan(0);
  expect(s['forecast:bad'].auc).toBe(0);
  expect(s['baseline:source_rate'].skill).toBeCloseTo(0);
});

it('a forecast recorded after the goal was created (the gate already decided) does not count', () => {
  proposal('a', 'gap_analysis', 'verified', 30); proposal('b', 'gap_analysis', 'regressed', 30);
  forecast('forecast:late', 'a', { p: 1 }, 40); forecast('forecast:late', 'b', { p: 0 }, 40);
  expect(forecastScores(db).find((x) => x.forecaster === 'forecast:late')).toBeUndefined();
});

it('only the first forecast per subject counts; jev prescreen is read as the product of its Noul answers', () => {
  expect(forecastOf('proposal_prescreen', { verifiable: { noul: 0.5 }, concrete: { noul: 0.8 }, names_file: { noul: 0.5 } })).toBeCloseTo(0.2);
  expect(forecastOf('forecast:x', { p: 1.5 } as never)).toBeNull();
  expect(forecastOf('commons_idea', {})).toBeNull();
  proposal('a', 'reflection', 'verified');
  forecast('forecast:flip', 'a', { p: 0.1 }, 1); forecast('forecast:flip', 'a', { p: 0.99 }, 2);
  expect(forecastScores(db).find((x) => x.forecaster === 'forecast:flip')).toMatchObject({ n: 1, brier: expect.closeTo(0.81, 5) });
  expect(auc([[0.9, 1], [0.1, 0]])).toBe(1);
});

// --- RX-7: forecast scoring V2 (shadow, read-only) ---
import { forecastScoresV2 } from '../services/forecast-scoring';
const resolve = (id: string, atMin: number) => db.prepare('UPDATE self_improvements SET updated_at = ? WHERE id = ?').run(t(atMin), id);

it('RX-7: a zero-positive subset gets a negative V1 skill but is insufficient in V2', () => {
  // history: the source has verified before, so the trailing base rate is > 0; the scored forecaster only saw failures
  for (let i = 0; i < 4; i++) { proposal(`old${i}`, 'gap_analysis', i < 2 ? 'verified' : 'regressed', 600); resolve(`old${i}`, 5); }
  for (let i = 0; i < 12; i++) { proposal(`z${i}`, 'gap_analysis', 'needs_more_evidence', null); resolve(`z${i}`, 300); forecast('forecast:resident:zero', `z${i}`, { p: 0.4, as_of: t(100) }, 100); }
  const v1 = forecastScores(db).find((x) => x.forecaster === 'forecast:resident:zero')!;
  expect(v1.positives).toBe(0); expect(v1.skill).toBeLessThan(0);
  const v2 = forecastScoresV2(db).forecasters.find((x) => x.forecaster === 'forecast:resident:zero')!;
  expect(v2).toMatchObject({ n: 12, positives: 0, state: 'insufficient' });
  expect(v2.null_goal_n).toBe(12);
  const stop = forecastScoresV2(db).would_have_stopped.find((x) => x.forecaster === 'forecast:resident:zero');
  expect(stop).toMatchObject({ v2_stop: false });
});

it('RX-7: an outcome resolved after the forecast was made does not change its V2 base rate', () => {
  proposal('h1', 'gap_analysis', 'verified', 600); resolve('h1', 5);
  proposal('h2', 'gap_analysis', 'regressed', 600); resolve('h2', 6);
  proposal('s1', 'gap_analysis', 'regressed', 600); resolve('s1', 400);
  forecast('forecast:x', 's1', { p: 0.2 }, 100);
  const before = forecastScoresV2(db).forecasters.find((x) => x.forecaster === 'forecast:x')!.baselineBrier;
  proposal('late', 'gap_analysis', 'verified', 900); resolve('late', 500); // resolved after the forecast (min 100)
  const after = forecastScoresV2(db).forecasters.find((x) => x.forecaster === 'forecast:x')!.baselineBrier;
  expect(after).toBe(before);
});

it('RX-7: V1 output is unchanged and the V2 bootstrap CI is deterministic for a fixed seed', () => {
  for (let i = 0; i < 20; i++) { proposal(`d${i}`, 'gap_analysis', i % 4 === 0 ? 'verified' : 'regressed', 600); resolve(`d${i}`, 200 + i); forecast('forecast:det', `d${i}`, { p: i % 4 === 0 ? 0.7 : 0.2 }, 150); }
  const v1a = JSON.stringify(forecastScores(db)); const v1b = JSON.stringify(forecastScores(db));
  expect(v1a).toBe(v1b);
  const a = forecastScoresV2(db, { seed: 7 }).forecasters.find((x) => x.forecaster === 'forecast:det')!;
  const b = forecastScoresV2(db, { seed: 7 }).forecasters.find((x) => x.forecaster === 'forecast:det')!;
  expect(a.skill_ci).toEqual(b.skill_ci); expect(a.skill_ci[0]).toBeLessThanOrEqual(a.skill); expect(a.skill_ci[1]).toBeGreaterThanOrEqual(a.skill);
  expect(a.state).toBe('insufficient'); // n 20 < 100
});
