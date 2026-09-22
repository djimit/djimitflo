import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ImprovementFunnelService } from '../services/improvement-funnel-service';

describe('ImprovementFunnelService', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); });
  afterEach(() => db.close());

  const seed = (id: string, source: string, status: string) => db.prepare(
    "INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at) VALUES (?, 'feature', 't', 'd', 'r', ?, ?, 0.5, datetime('now'), datetime('now'))").run(id, source, status);

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
    expect(hygiene).toMatchObject({ zombieGoals: 1, staleRuns: 1 });
  });
});
