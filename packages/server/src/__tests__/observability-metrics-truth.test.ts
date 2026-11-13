import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createObservabilityRoutes } from '../routes/observability';
import { errorHandler } from '../middleware/error-handler';
import { EvidenceService } from '../services/evidence-service';

// Dashboard truth audit 2026-11-12 (/observability): the "Policy Decisions" card counted risk_assessments.recommended_decision,
// not decisions; every card was all-time; "Recent errors" showed one 7,377-char blob ten times.
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
let db: Database.Database;
const auth = {
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
} as any;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(schema);
  runMigrations(db);
  const task = db.prepare(`INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, created_at, updated_at)
    VALUES (?, 't', 'd', ?, 'low', 'high', 'local', ?, ?)`);
  task.run('t-old', 'completed', ago(30), ago(30));
  task.run('t-new', 'completed', ago(1), ago(1));
  task.run('t-run', 'running', ago(1), ago(1));
  const risk = db.prepare(`INSERT INTO risk_assessments (id, task_id, action_type, subject, risk_level, recommended_decision, matched_rules, explanation, created_at)
    VALUES (?, 't-new', 'shell_command', 's', ?, ?, '[]', 'x', ?)`);
  risk.run('r-old', 'low', 'allow', ago(20));
  for (const id of ['r1', 'r2', 'r3']) risk.run(id, 'high', 'require_approval', ago(2));
  const approval = db.prepare(`INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, decided_at, created_at, updated_at)
    VALUES (?, 't-new', ?, 'high', 'high_risk_action', 'm', '{}', ?, ?, ?)`);
  approval.run('a-approved', 'approved', ago(1), ago(1), ago(1));
  approval.run('a-denied', 'denied', ago(2), ago(2), ago(2));
  approval.run('a-expired', 'expired', null, ago(3), ago(3)); // expiry has no decided_at: updated_at is when it was processed
  approval.run('a-old', 'approved', ago(30), ago(30), ago(30));
  approval.run('a-pending', 'pending', null, ago(1), ago(1));
  const event = db.prepare(`INSERT INTO execution_events (id, task_id, event_type, message, level, created_at) VALUES (?, 't-new', 'x', ?, 'error', ?)`);
  const blob = `The user has specified a rule which prevents you from using this specific tool call. ${'x'.repeat(7_300)}`;
  for (let i = 0; i < 10; i++) event.run(`e${i}`, blob, ago(1 + i / 100));
  event.run('e-other', 'Different failure', ago(2));
  event.run('e-old', 'Old failure', ago(30));
});
afterEach(() => db.close());

const app = () => express().use('/observability', createObservabilityRoutes(db, auth)).use(errorHandler);

it('scopes the metrics to a labelled window (default 7 days) and keeps live state current', async () => {
  const { body, status } = await request(app()).get('/observability/metrics');
  expect(status).toBe(200);
  expect(body.window_days).toBe(7);
  expect(body).toMatchObject({ total_tasks: 2, completed_tasks: 1, active_tasks: 1, pending_approvals: 1 });
  expect(body.risk_distribution).toMatchObject({ low: 0, high: 3 });
  // risk-engine recommendations, kept apart from what approvers actually decided
  expect(body.policy_decisions).toMatchObject({ allow: 0, require_approval: 3 });
  expect(body.approval_outcomes).toEqual({ approved: 1, denied: 1, expired: 1 });

  const month = (await request(app()).get('/observability/metrics?days=60')).body;
  expect(month).toMatchObject({ window_days: 60, total_tasks: 3, approval_outcomes: { approved: 2, denied: 1, expired: 1 } });
  expect(month.policy_decisions).toMatchObject({ allow: 1, require_approval: 3 });

  expect((await request(app()).get('/observability/metrics?days=abc')).status).toBe(400);
});

it('groups identical recent errors with a count instead of repeating them', async () => {
  const { body } = await request(app()).get('/observability/metrics');
  expect(body.recent_errors).toHaveLength(2);
  expect(body.recent_errors[0]).toMatchObject({ count: 10, task_id: 't-new' });
  expect(body.recent_errors[0].message).toMatch(/^The user has specified a rule/);
  expect(body.recent_errors[1]).toMatchObject({ message: 'Different failure', count: 1 });
});

it('keeps the all-time projection for callers that pass no window (summary export)', () => {
  const metrics = new EvidenceService(db).getObservabilityMetrics();
  expect(metrics.window_days).toBeNull();
  expect(metrics.total_tasks).toBe(3);
  expect(metrics.approval_outcomes).toEqual({ approved: 2, denied: 1, expired: 1 });
});
