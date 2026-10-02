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
