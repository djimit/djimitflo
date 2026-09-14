import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { runReferenceScenario } from '../services/expert-e2e-scenario';

describe('reference end-to-end scenario (§59, §60)', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); });
  afterEach(() => db.close());

  it('satisfies every §59 requirement on the frontier path with a scripted evidence-bound model', async () => {
    const report = await runReferenceScenario(db);
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.passed).toBe(true);
    const council = report.result.council!;
    // The impersonating perspective is surfaced, not hidden (§40), and produced no claims (I09).
    expect(council.rejected_perspectives).toHaveLength(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM expert_claims WHERE expert_id = ?').get(council.rejected_perspectives[0].expert_id) as { n: number }).n).toBe(0);
    // Historical record of the run is stored with the council result (§50).
    expect((db.prepare('SELECT COUNT(*) AS n FROM expert_swarm_history').get() as { n: number }).n).toBe(1);
  });
});
