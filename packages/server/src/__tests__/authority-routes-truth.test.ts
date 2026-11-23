import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createAuthorityRoutes } from '../routes/authority';
import { recordAuthorityEvent } from '../services/authority-ledger-service';

// Dashboard truth audit 2026-11-12 (/authority): "HOLD 677" in amber while every HOLD had a later ALLOW/DENY on the same
// correlation id, and rows had no subject.
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(schema);
  runMigrations(db);
  db.prepare(`INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode) VALUES ('task-1', 'Fix the parser', 'd', 'completed', 'low', 'high', 'local')`).run();
  db.prepare(`INSERT INTO goals (id, objective, risk_class, status) VALUES ('goal-1', 'Remove dead code', 'low', 'completed')`).run();
  const emit = (correlationId: string, requestedState: string, decision: 'ALLOW' | 'DENY' | 'HOLD') =>
    recordAuthorityEvent(db, { correlationId, artifactId: `${correlationId}-a`, actorSubject: 'system', actorType: 'service', requestedState, decision });
  emit('task-1', 'EXECUTION_APPROVAL_REQUESTED', 'HOLD');
  emit('task-1', 'EXECUTION_APPROVED', 'ALLOW');
  emit('task-2', 'EXECUTION_APPROVAL_REQUESTED', 'HOLD');
  emit('task-2', 'EXECUTION_APPROVAL_EXPIRED', 'DENY');
  emit('task-open', 'EXECUTION_APPROVAL_REQUESTED', 'HOLD');
  emit('goal-1', 'PLAN_APPROVED', 'ALLOW');
});
afterEach(() => db.close());

const app = () => express().use('/authority', createAuthorityRoutes(db));

it('reports open holds (no later ALLOW/DENY on the same correlation id) apart from the HOLD total', async () => {
  const { body } = await request(app()).get('/authority/stats');
  expect(body.by_decision).toEqual(expect.arrayContaining([{ policy_decision: 'HOLD', n: 3 }]));
  expect(body.open_holds).toBe(1);
});

it('attaches the subject an event is about when its correlation id names a task or goal', async () => {
  const { body } = await request(app()).get('/authority/events');
  const subjectOf = (correlationId: string) => body.events.find((e: any) => e.correlation_id === correlationId).subject;
  expect(subjectOf('task-1')).toEqual({ kind: 'task', id: 'task-1', title: 'Fix the parser' });
  expect(subjectOf('goal-1')).toEqual({ kind: 'goal', id: 'goal-1', title: 'Remove dead code' });
  expect(subjectOf('task-open')).toBeNull();
});
