import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { recoverStaleOpenMythosRuns } from '../bootstrap/recovery';

describe('bootstrap recovery', () => {
  it('fails only stale running OpenMythos evaluations', () => {
    const db = new Database(':memory:');
    db.exec(schema);
    runMigrations(db);
    db.prepare(`
      INSERT INTO openmythos_eval_runs (id, agent_id, status, started_at)
      VALUES ('stale', 'agent', 'running', datetime('now', '-7 hours')),
             ('fresh', 'agent', 'running', datetime('now', '-1 hour'))
    `).run();

    expect(recoverStaleOpenMythosRuns(db as ReturnType<typeof import('../database').initializeDatabase>)).toBe(1);
    expect(db.prepare('SELECT status FROM openmythos_eval_runs WHERE id = ?').get('stale')).toMatchObject({ status: 'failed' });
    expect(db.prepare('SELECT status FROM openmythos_eval_runs WHERE id = ?').get('fresh')).toMatchObject({ status: 'running' });
    db.close();
  });
});
