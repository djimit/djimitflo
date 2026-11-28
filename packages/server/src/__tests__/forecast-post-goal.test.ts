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
