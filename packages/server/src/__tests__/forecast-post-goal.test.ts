import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { forecastScores } from '../services/forecast-scoring';
import { postGoalForecastScores, POST_GOAL_MIN_N } from '../services/forecast-post-goal';

let db: Database.Database;
const NOW = Date.parse('2026-11-20T00:00:00Z');
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());
const at = (h: number) => new Date(Date.parse('2026-11-10T00:00:00Z') + h * 3_600_000).toISOString();
/** a proposal that got its goal at hour 0 and resolved at hour 10, with one forecast written at `forecastHour` */
function proposal(id: string, status: string, forecaster: string, p: number, forecastHour: number) {
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at)
    VALUES (?, 'feature', 't', 'd', 'r', 'gap_analysis', ?, '[]', ?, ?)`).run(id, status, at(0), at(10));
  db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'completed', '{}', ?, ?, ?)`).run(`g-${id}`, id, at(0), at(0));
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at) VALUES (?, ?, 'self_improvement', ?, '', 'shadow', 'yes', 'r', ?, ?)`)
    .run(`j-${id}`, forecaster, id, JSON.stringify({ p }), at(forecastHour));
}

it('scores a forecast made after the goal but before the outcome — the ones V1 drops as leakage', () => {
  for (let i = 0; i < POST_GOAL_MIN_N; i++) proposal(`a${i}`, i % 2 ? 'verified' : 'regressed', 'forecast:committee:cm-skeptic', i % 2 ? 0.8 : 0.2, 5);
  expect(forecastScores(db, 3650).find((s) => s.forecaster === 'forecast:committee:cm-skeptic')).toBeUndefined(); // V1: after the goal
  const s = postGoalForecastScores(db, NOW).forecasters.find((f) => f.forecaster === 'forecast:committee:cm-skeptic')!;
  expect(s).toMatchObject({ n: 20, positives: 10, base_rate: 0.5, brier: 0.04, baseline_brier: 0.25, skill: 0.84, auc: 1 });
});

it('drops a forecast written after the outcome, ignores unresolved proposals, and reports null below min_n', () => {
  proposal('late', 'verified', 'forecast:committee:cm-oracle', 0.9, 11);
  proposal('open', 'approved', 'forecast:committee:cm-oracle', 0.9, 5);
  proposal('ok', 'verified', 'forecast:committee:cm-oracle', 0.9, 5);
  const r = postGoalForecastScores(db, NOW);
  expect(r.written_after_resolution).toBe(1);
  expect(r.forecasters).toEqual([{ forecaster: 'forecast:committee:cm-oracle', n: 1, positives: 1, base_rate: null, brier: null, baseline_brier: null, skill: null, auc: null }]);
  expect(postGoalForecastScores(new Database(':memory:'), NOW).forecasters).toEqual([]); // fail-soft on an empty schema
});

it('counts a forecast at resolution time as late, dedupes repeat judgments, scores applied as positive, and reports window_days', () => {
  for (let i = 0; i < 10; i++) proposal(`v${i}`, 'verified', 'forecast:committee:cm-edge', 0.8, 5);
  for (let i = 0; i < 5; i++) proposal(`r${i}`, 'regressed', 'forecast:committee:cm-edge', 0.2, 5);
  for (let i = 0; i < 5; i++) proposal(`p${i}`, 'applied', 'forecast:committee:cm-edge', 0.7, 5);
  // duplicate judgment for v0 (later timestamp, different p) — first forecast must win
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at) VALUES (?, ?, 'self_improvement', ?, '', 'shadow', 'yes', 'r', ?, ?)`)
    .run('j-v0-dup', 'forecast:committee:cm-edge', 'v0', JSON.stringify({ p: 0.01 }), at(6));
  // forecast written exactly at resolved_at — must be late, not scored
  proposal('boundary', 'verified', 'forecast:committee:cm-edge', 0.9, 10);
  // error decision — must be excluded
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at) VALUES (?, 'feature', 't', 'd', 'r', 'gap_analysis', 'verified', '[]', ?, ?)`).run('err', at(0), at(10));
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at) VALUES (?, ?, 'self_improvement', ?, '', 'shadow', 'error', 'r', ?, ?)`)
    .run('j-err', 'forecast:committee:cm-edge', 'err', JSON.stringify({ p: 0.5 }), at(5));

  const r = postGoalForecastScores(db, NOW);
  expect(r.window_days).toBe(90);
  expect(r.written_after_resolution).toBe(1);
  const s = r.forecasters.find((f) => f.forecaster === 'forecast:committee:cm-edge')!;
  expect(s).toMatchObject({ n: 20, positives: 15, base_rate: 0.75, brier: 0.0525, baseline_brier: 0.1875, skill: 0.72, auc: 1 });
  expect(postGoalForecastScores(db, NOW, 5).forecasters).toEqual([]); // 5-day window excludes 10-day-old data
});

it('rounds metrics to 4 decimal places and returns null skill when base rate is 0 or 1', () => {
  for (let i = 0; i < POST_GOAL_MIN_N; i++) proposal(`x${i}`, 'verified', 'forecast:committee:cm-precision', 0.123, 5);
  const s = postGoalForecastScores(db, NOW).forecasters.find((f) => f.forecaster === 'forecast:committee:cm-precision')!;
  expect(s).toMatchObject({ n: 20, positives: 20, base_rate: 1, brier: 0.7691, baseline_brier: 0, skill: null, auc: null });
});

it('sorts forecasters by skill descending with null-skill forecasters last', () => {
  for (let i = 0; i < 10; i++) proposal(`h${i}`, 'verified', 'forecast:committee:cm-high', 0.9, 5);
  for (let i = 0; i < 10; i++) proposal(`h${i}r`, 'regressed', 'forecast:committee:cm-high', 0.1, 5);
  for (let i = 0; i < 13; i++) proposal(`l${i}`, 'verified', 'forecast:committee:cm-low', 0.5, 5);
  for (let i = 0; i < 12; i++) proposal(`l${i}r`, 'regressed', 'forecast:committee:cm-low', 0.5, 5);
  for (let i = 0; i < 5; i++) proposal(`f${i}`, 'verified', 'forecast:committee:cm-few', 0.9, 5);

  const r = postGoalForecastScores(db, NOW).forecasters;
  expect(r.map((f) => f.forecaster)).toEqual(['forecast:committee:cm-high', 'forecast:committee:cm-low', 'forecast:committee:cm-few']);
  expect(r[0]).toMatchObject({ n: 20, skill: 0.96, auc: 1 });
  expect(r[2]).toMatchObject({ n: 5, skill: null });
});
