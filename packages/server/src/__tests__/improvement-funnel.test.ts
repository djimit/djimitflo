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
});
