import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { ImprovementFunnelService } from '../services/improvement-funnel-service';

describe('ImprovementFunnelService', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); });
  afterEach(() => db.close());

  const seed = (id: string, source: string, status: string) => db.prepare(
    "INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at) VALUES (?, 'feature', 't', 'd', 'r', ?, ?, 0.5, datetime('now'), datetime('now'))").run(id, source, status);

  it('reports TypeSafe judgment agreement with final outcomes, skipping open outcomes, uncertain and pre-#334 checker rows', () => {
    seed('p-good', 'gap_analysis', 'verified'); seed('p-bad', 'reflection', 'archived'); seed('p-open', 'reflection', 'scheduled');
    const j = (id: string, judgment: string, subject: string, decision: string, at = new Date().toISOString(), latency = 400) => db.prepare(
      "INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, latency_ms, created_at) VALUES (?, ?, 'x', ?, 'h', 'shadow', ?, ?, ?)").run(id, judgment, subject, decision, latency, at);
    j('1', 'proposal_prescreen', 'p-good', 'yes'); j('2', 'proposal_prescreen', 'p-bad', 'yes'); j('3', 'proposal_prescreen', 'p-open', 'no');
    j('4', 'proposal_prescreen', 'p-bad', 'uncertain');
    db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, created_at, updated_at) VALUES ('r1', 'doc-drift-and-small-fix-loop', 'closed', 'completed', datetime('now'), datetime('now'))").run();
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, created_at, updated_at) VALUES ('l1', 'r1', 'checker', 'opencode', 'completed', datetime('now'), datetime('now'))").run();
    j('5', 'checker_second_opinion', 'l1', 'yes'); j('6', 'checker_second_opinion', 'l1', 'no', '2026-09-23T18:04:00Z');
    const js = new ImprovementFunnelService(db).compute().judgments;
    expect(js.find((x) => x.judgment === 'proposal_prescreen')).toMatchObject({ total: 4, withOutcome: 2, agreement: 0.5, medianLatencyMs: 400 });
    expect(js.find((x) => x.judgment === 'checker_second_opinion')).toMatchObject({ total: 2, withOutcome: 1, agreement: 1 });
  });

  it('aggregates conversion per source and survives an empty database', () => {
    expect(new ImprovementFunnelService(db).compute().proposals.total).toBe(0);
    seed('a', 'reflection', 'needs_more_evidence'); seed('b', 'reflection', 'archived'); seed('c', 'reflection', 'needs_grounding');
    seed('d', 'feedback', 'verified'); seed('e', 'feedback', 'regressed'); seed('f', 'feedback', 'executing');
    const funnel = new ImprovementFunnelService(db).compute();
    expect(funnel.proposals).toMatchObject({ total: 6, byStatus: { verified: 1, archived: 1 } });
    expect(funnel.bySource.find((s) => s.source === 'reflection')).toMatchObject({ total: 3, parked: 1, archived: 1, needsGrounding: 1, reachedGoal: 0 });
    expect(funnel.bySource.find((s) => s.source === 'feedback')).toMatchObject({ total: 3, reachedGoal: 3, verified: 1, failed: 1 });
    expect(funnel.panel.goalRate).toBeNull();
  });

  it('reports the yield KPIs and zombie counters', () => {
    const now = new Date().toISOString();
    const stamp = (id: string) => db.prepare('UPDATE self_improvements SET updated_at = ?, created_at = ? WHERE id = ?').run(now, new Date(Date.now() - 4 * 3_600_000).toISOString(), id);
    seed('v1', 'reflection', 'verified'); seed('v2', 'reflection', 'verified'); seed('r1', 'reflection', 'regressed');
    ['v1', 'v2', 'r1'].forEach(stamp);
    db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, created_at, updated_at) VALUES ('gz', 'o', 'low', 'running', '{}', '2026-01-01', '2026-01-01')").run();
    db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at) VALUES ('rz', 'gz', 'x', 'closed', 'interrupted', '2026-01-01', '2026-01-01')").run();
    const { kpi, hygiene } = new ImprovementFunnelService(db).compute();
    expect(kpi).toMatchObject({ verified: 2, regressed: 1, medianHoursToVerified: 4 });
    expect(kpi.regressionRate).toBeCloseTo(1 / 3);
    expect(kpi).toMatchObject({ runs: 0, runSuccessRate: null, tokensPerVerified: null }); // no skill_outcomes yet
    expect(hygiene).toMatchObject({ zombieGoals: 1, staleRuns: 1 });
  });
});

it('J6: cost per verified change comes from the per-run skill outcomes', () => {
  const db2 = new Database(':memory:'); db2.exec(schema); runMigrations(db2);
  const skills = new SkillEvolutionEngine(db2);
  skills.recordOutcome('loop-maker:doc-drift-and-small-fix-loop:opencode', { success: true, tokensUsed: 30_000, durationMs: 1, domain: 'd' });
  skills.recordOutcome('loop-maker:doc-drift-and-small-fix-loop:opencode', { success: false, tokensUsed: 10_000, durationMs: 1, domain: 'd' });
  db2.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at) VALUES ('v', 'feature', 't', 'd', 'r', 'gap_analysis', 'verified', 0.5, ?, ?)`).run(new Date().toISOString(), new Date().toISOString());
  expect(new ImprovementFunnelService(db2).compute().kpi).toMatchObject({ runs: 2, runSuccessRate: 0.5, tokensPerVerified: 40_000 });
  db2.close();
});

it('E11/5: calibrates each panel specialist against what the proposal became', () => {
  const db3 = new Database(':memory:'); db3.pragma('foreign_keys = OFF'); db3.exec(schema); runMigrations(db3);
  const now = new Date().toISOString();
  const proposal = (id: string, status: string) => {
    db3.prepare(`INSERT INTO specialist_panels (id, topic, question, status, risk_class, panel_json, context_json, consensus_json, metadata, created_at, updated_at) VALUES (?, 't', 'q', 'goal_created', 'low', '[]', '{}', '{}', '{}', ?, ?)`).run(`panel-${id}`, now, now);
    db3.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, panel_id, created_at, updated_at) VALUES (?, 'feature', 't', 'd', 'r', 'gap_analysis', ?, 0.5, ?, ?, ?)`).run(id, status, `panel-${id}`, now, now);
  };
  const vote = (id: string, specialist: string, stance: string, confidence: number) => db3.prepare(`INSERT INTO specialist_reviews (id, panel_id, specialist_id, specialist_title, stance, confidence, status) VALUES (?, ?, ?, ?, ?, ?, 'submitted')`)
    .run(`${specialist}-${id}`, `panel-${id}`, specialist, specialist, stance, confidence);
  proposal('a', 'verified'); proposal('b', 'regressed'); proposal('c', 'needs_more_evidence');
  vote('a', 'architect', 'support', 0.9); vote('b', 'architect', 'support', 0.9); vote('c', 'architect', 'support', 0.5);
  vote('a', 'runtime', 'support', 0.6); vote('b', 'runtime', 'oppose', 0.7);
  expect(new ImprovementFunnelService(db3).compute().panelCalibration).toEqual([
    { specialist: 'architect', votes: 3, withOutcome: 2, accuracy: 0.5, meanConfidence: 0.9 },  // confident, half right
    { specialist: 'runtime', votes: 2, withOutcome: 2, accuracy: 1, meanConfidence: 0.65 },
  ]);
  db3.close();
});
