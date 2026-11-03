import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { recordPanelShadow, specialistAccuracy, weightedDecision } from '../services/panel-calibration-shadow';
import { ImprovementFunnelService } from '../services/improvement-funnel-service';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => { db.close(); delete process.env.PANEL_WEIGHTED_SHADOW_ENABLED; });

const proposal = (id: string, panel: string, status: string) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, panel_id, created_at, updated_at)
  VALUES (?, 'feature', 't', 'd', 'r', 'gap_analysis', ?, 0.5, ?, datetime('now'), datetime('now'))`).run(id, status, panel);
const review = (panel: string, specialist: string, stance: string) => db.prepare(`INSERT INTO specialist_reviews (id, panel_id, specialist_id, specialist_title, stance, confidence, findings_json, recommendations_json, evidence_refs_json, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 0.9, '[]', '[]', '[]', 'submitted', datetime('now'), datetime('now'))`).run(`${panel}-${specialist}`, panel, specialist, specialist, stance);

it('weights each vote by the smoothed track record of its juror', () => {
  // good juror: right on 3 outcomes; bad juror: wrong on 3
  for (const [i, status] of ['verified', 'verified', 'regressed'].entries()) {
    proposal(`p${i}`, `pan${i}`, status);
    review(`pan${i}`, 'good', status === 'verified' ? 'support' : 'oppose');
    review(`pan${i}`, 'bad', status === 'verified' ? 'oppose' : 'support');
  }
  const acc = specialistAccuracy(db);
  expect(acc.get('good')).toBeCloseTo(4 / 5); expect(acc.get('bad')).toBeCloseTo(1 / 5);
  // unweighted this is a tie; weighted, the reliable juror carries it
  expect(weightedDecision([{ specialist_id: 'good', stance: 'support' }, { specialist_id: 'bad', stance: 'oppose' }], acc)).toEqual({ yes: true, score: 0.6 });
});

it('records the weighted and the actual decision once per panel (default off), and the funnel scores both', () => {
  proposal('pz', 'panel-z', 'verified');
  const reviews = [{ specialist_id: 'a', stance: 'support' }, { specialist_id: 'b', stance: 'needs_evidence' }];
  recordPanelShadow(db, 'panel-z', reviews, 'needs_more_evidence');
  expect(db.prepare("SELECT COUNT(*) AS n FROM judgments").get()).toEqual({ n: 0 }); // off by default
  process.env.PANEL_WEIGHTED_SHADOW_ENABLED = 'true';
  recordPanelShadow(db, 'panel-z', reviews, 'needs_more_evidence');
  recordPanelShadow(db, 'panel-z', reviews, 'needs_more_evidence'); // once
  const rows = db.prepare("SELECT judgment, decision FROM judgments ORDER BY judgment").all();
  expect(rows).toEqual([{ judgment: 'panel_unweighted', decision: 'no' }, { judgment: 'panel_weighted', decision: 'no' }]);
  const funnel = new ImprovementFunnelService(db).compute().judgments;
  expect(funnel.find((j) => j.judgment === 'panel_unweighted')).toMatchObject({ withOutcome: 1, agreement: 0 }); // it parked a proposal that verified
});
