import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ImprovementFunnelService } from '../services/improvement-funnel-service';

/** Forensic audit 2026-10-26 UX-002/003/004: every funnel number keeps its population, window and availability. */
describe('ImprovementFunnelService metric truth', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); });
  afterEach(() => db.close());

  const workItem = (id: string, loop: string, status = 'candidate') => db.prepare(
    "INSERT INTO work_items (id, title, description, source, risk_class, status, recommended_loop) VALUES (?, 't', 'd', 'test', 'low', ?, ?)").run(id, status, loop);
  const proposal = (id: string, status: string, createdAgoH: number, updatedAgoH: number) => db.prepare(
    "INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at) VALUES (?, 'feature', 't', 'd', 'r', 'test', ?, 0.5, ?, ?)")
    .run(id, status, new Date(Date.now() - createdAgoH * 3_600_000).toISOString(), new Date(Date.now() - updatedAgoH * 3_600_000).toISOString());

  it('UX-002: the open-work total counts every eligible row, not the top-12 breakdown', () => {
    for (let n = 0; n < 13; n++) workItem(`w${n}`, `loop-${String(n).padStart(2, '0')}`);
    workItem('done', 'loop-00', 'done'); // not open
    const { queues } = new ImprovementFunnelService(db).compute();
    const oracle = (db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE status IN ('candidate','triaged','planned','leased','blocked')").get() as { n: number }).n;
    expect(oracle).toBe(13);
    expect(queues.openWorkItems).toBe(oracle);
    expect(queues.workItemsByLoop).toHaveLength(12);
    expect(queues.workItemsByLoopLimit).toBe(12);
    expect(queues.workItemGroups).toBe(13);
  });

  it('UX-003: the latency median states its 30-day current-status cohort and size, and is a true median', () => {
    proposal('a', 'verified', 24 * 20, 24 * 10); // updated 10 d ago: outside the 7-day yield window, inside the 30-day median window
    proposal('b', 'applied', 8, 6); // 2 h
    proposal('c', 'scheduled', 100, 1); // not a positive status
    const { kpi } = new ImprovementFunnelService(db).compute();
    expect(kpi.verified).toBe(1); // only b inside 7 d
    expect(kpi.medianHoursWindowDays).toBe(30);
    expect(kpi.medianHoursN).toBe(2);
    expect(kpi.medianHoursToVerified).toBe(Math.round(((240 + 2) / 2) * 10) / 10); // mean of the two middle values, not the upper one
  });

  it('UX-004: an empty table is a measured zero', () => {
    const funnel = new ImprovementFunnelService(db).compute();
    expect(funnel.hygiene).toMatchObject({ zombieGoals: 0, staleRuns: 0, blockedBoardItems: 0 });
    expect(funnel.queues.openWorkItems).toBe(0);
    for (const key of ['zombieGoals', 'staleRuns', 'blockedBoardItems', 'openWorkItems', 'verified']) expect(funnel.unavailable).not.toHaveProperty(key);
  });

  it('UX-004: a missing optional table is unavailable, not zero', () => {
    db.exec('DROP TABLE IF EXISTS cognitive_episodes'); // created lazily by the cognitive loop; absent on older instances
    const funnel = new ImprovementFunnelService(db).compute();
    expect(funnel.learning.cognitiveEpisodes).toBeNull();
    expect(funnel.unavailable.cognitiveEpisodes).toMatch(/^missing_schema:/);
    expect(funnel.hygiene.staleRuns).toBe(0); // other reads unaffected
  });

  it('UX-004: an operational query error (locked database) is unavailable, distinct from missing schema', () => {
    const locked = new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') return (sql: string) => {
          if (/FROM loop_runs WHERE \(status = 'interrupted'/.test(sql) || /FROM work_items WHERE status IN/.test(sql)) throw new Error('database is locked');
          return target.prepare(sql);
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const funnel = new ImprovementFunnelService(locked).compute();
    expect(funnel.hygiene.staleRuns).toBeNull();
    expect(funnel.unavailable.staleRuns).toBe('query_failed: database is locked');
    expect(funnel.queues.openWorkItems).toBeNull();
    expect(funnel.unavailable.openWorkItems).toBe('query_failed: database is locked');
    expect(funnel.hygiene.zombieGoals).toBe(0);
  });
});
