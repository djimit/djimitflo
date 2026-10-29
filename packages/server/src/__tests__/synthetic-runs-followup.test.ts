import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SwarmStatusService } from '../services/swarm-status-service';

/**
 * Functional follow-ups to U3 (#1090): a completed synthetic PR-review run (marked, or historical: repo-maintenance-loop + a
 * 'manual' maker) is bookkeeping. Its "Automated review for PR #N" finding is no work item, and it is nothing to learn from.
 */
const now = Date.now();
const iso = (t: number) => new Date(t).toISOString();
let db: Database.Database;

function completedRun(id: string, loop: string, meta: Record<string, unknown>, makerRuntime: string, message: string, ago: number) {
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, metadata, created_at, updated_at, completed_at)
    VALUES (?, ?, 'closed', 'completed', ?, ?, ?, ?, ?)`).run(id, loop, JSON.stringify([{ id: `f-${id}`, type: 'refactor', file: 'README.md', message }]),
    JSON.stringify(meta), iso(now - ago), iso(now - ago), iso(now - ago));
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, created_at, updated_at) VALUES (?, ?, 'maker', ?, 'completed', ?, ?)`)
    .run(`${id}-maker`, id, makerRuntime, iso(now - ago), iso(now - ago));
}

beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  completedRun('r-real', 'test-gap', {}, 'opencode', 'Missing test for src/a.ts', 3_600_000);
  completedRun('r-syn', 'repo-maintenance-loop', { synthetic: true, synthetic_reason: 'pr_review' }, 'manual', 'Automated review for PR #7: add x', 60_000);
  completedRun('r-hist', 'repo-maintenance-loop', {}, 'manual', 'Automated review for PR #6: add y', 120_000);
});
afterEach(() => db.close());

describe('synthetic PR-review runs: functional follow-ups', () => {
  it('tickScheduler turns only real runs\' findings into loop_finding work items', () => {
    const result = new SwarmStatusService(db).tickScheduler();
    expect(result.created_work_items.map((w) => w.source_ref)).toEqual(['r-real:f-r-real']);
    expect((db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE source = 'loop_finding' AND description LIKE 'Automated review%'").get() as { n: number }).n).toBe(0);
  });
});
