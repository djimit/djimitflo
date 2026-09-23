import { afterEach, beforeEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { RepoExplainerScheduler } from '../services/repo-explainer-scheduler';

// Prod 2026-09-24: "Recent failed jobs" kept showing the 2026-09-12 missing-corpus ENOENT for repos with published bundles.
let db: Database.Database;
const now = new Date('2026-09-24T12:00:00Z');
const task = (id: string, status: string) => db.prepare(`INSERT INTO explainer_tasks (id, title, provider, remote_url, status, error_message) VALUES (?, ?, 'github', ?, ?, 'ENOENT: corpus')`)
  .run(id, `Explain djimit/${id}`, `https://github.com/djimit/${id}`, status);
const failedJob = (id: string, taskId: string, at: string) => db.prepare(`INSERT INTO explainer_jobs (id, task_id, status, finished_at, updated_at) VALUES (?, ?, 'failed', ?, ?)`).run(id, taskId, at, at);
beforeEach(() => {
  db = createTestDb();
  task('fixed-since', 'completed'); failedJob('j1', 'fixed-since', '2026-09-23T10:00:00Z');
  task('old-failure', 'failed'); failedJob('j2', 'old-failure', '2026-09-12T19:00:00Z');
  task('still-broken', 'failed'); failedJob('j3', 'still-broken', '2026-09-23T11:00:00Z');
});
afterEach(() => db.close());

it('lists only recent failures of tasks that have not completed since', () => {
  const failures = new RepoExplainerScheduler(db).getStatus({ now }).recent_failures;
  expect(failures.map((f) => f.full_name)).toEqual(['djimit/still-broken']);
});
