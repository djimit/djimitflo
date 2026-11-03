import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { calibrated, recordForecasts, sourceRate } from '../services/forecasters';
import { forecastScores } from '../services/forecast-scoring';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());

const prop = (id: string, source: string, status: string) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at)
  VALUES (?, 'feature', ?, 'd', 'r', ?, ?, 0.5, datetime('now','-1 day'), datetime('now','-1 day'))`).run(id, id, source, status);
const prescreen = (id: string, v: number) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
  VALUES (?, 'proposal_prescreen', 'self_improvement', ?, '', 'shadow', 'yes', '', ?, datetime('now','-1 day'))`).run(`ps-${id}`, id, JSON.stringify({ verifiable: { noul: v }, concrete: { noul: v }, names_file: { noul: v } }));

it('base rate is the Laplace-smoothed verified rate of the source', () => {
  prop('a', 'gap_analysis', 'verified'); prop('b', 'gap_analysis', 'regressed'); prop('c', 'gap_analysis', 'needs_more_evidence');
  expect(sourceRate(db, 'gap_analysis')).toBeCloseTo(2 / 5);
  expect(sourceRate(db, 'reflection')).toBeCloseTo(0.5); // no history → uninformative
});

it('jev_calibrated maps the raw prescreen product to the empirical rate of its bucket, shrunk to the source rate', () => {
  for (let i = 0; i < 10; i++) { prop(`h${i}`, 'gap_analysis', i < 6 ? 'verified' : 'needs_more_evidence'); prescreen(`h${i}`, 0.95); }
  for (let i = 0; i < 10; i++) { prop(`l${i}`, 'gap_analysis', 'needs_more_evidence'); prescreen(`l${i}`, 0.3); }
  expect(calibrated(db, 'gap_analysis', 0.9)).toBeGreaterThan(0.5);
  expect(calibrated(db, 'gap_analysis', 0.01)).toBeLessThan(0.15);
});

it('records each forecaster once per proposal, and the scoreboard picks them up', () => {
  prop('new', 'gap_analysis', 'proposed');
  recordForecasts(db, { id: 'new', source: 'gap_analysis' }, { verifiable: { noul: 0.9 }, concrete: { noul: 0.9 }, names_file: { noul: 0.9 } });
  recordForecasts(db, { id: 'new', source: 'gap_analysis' }, { verifiable: { noul: 0.1 }, concrete: { noul: 0.1 }, names_file: { noul: 0.1 } });
  expect(db.prepare("SELECT judgment, count(*) n FROM judgments WHERE subject_id = 'new' GROUP BY 1 ORDER BY 1").all())
    .toEqual([{ judgment: 'forecast:base_rate', n: 1 }, { judgment: 'forecast:jev_calibrated', n: 1 }]);
  recordForecasts(db, { id: 'np', source: 'reflection' }, null);
  expect(db.prepare("SELECT judgment FROM judgments WHERE subject_id = 'np'").all()).toEqual([{ judgment: 'forecast:base_rate' }]);
  db.prepare("UPDATE self_improvements SET status = 'verified' WHERE id = 'new'").run();
  expect(forecastScores(db).map((s) => s.forecaster)).toEqual(expect.arrayContaining(['forecast:base_rate', 'forecast:jev_calibrated']));
});
