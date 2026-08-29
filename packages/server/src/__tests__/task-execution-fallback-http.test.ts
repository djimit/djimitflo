import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { UserRole } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { ExecutionEngine } from '../execution/execution-engine';
import { ExecutionFailureError, type TaskExecutor } from '../execution/types';
import { createTaskRoutes } from '../routes/tasks';
import { errorHandler } from '../middleware/error-handler';

describe('task execution provider fallback HTTP chain', () => {
  let db: ReturnType<typeof createTestDb>;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    db = createTestDb();
    db.exec('ALTER TABLE tasks ADD COLUMN updated_by TEXT;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS execution_events (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')), message TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info', tool_name TEXT, tool_input TEXT,
        tool_output TEXT, tool_error TEXT, approval_id TEXT, artifact_id TEXT,
        metadata TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS approval_policies (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
        action_type TEXT NOT NULL, decision TEXT NOT NULL DEFAULT 'require_approval',
        match_pattern TEXT, protected_paths TEXT NOT NULL DEFAULT '[]',
        allowed_tools TEXT NOT NULL DEFAULT '[]', blocked_tools TEXT NOT NULL DEFAULT '[]',
        require_reason INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS risk_assessments (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, risk_level TEXT NOT NULL,
        risk_score REAL NOT NULL DEFAULT 0, factors_json TEXT NOT NULL DEFAULT '[]',
        assessment_type TEXT NOT NULL DEFAULT 'task', execution_event_id TEXT,
        metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, event_type TEXT NOT NULL, action TEXT NOT NULL,
        resource_type TEXT, resource_id TEXT, task_id TEXT, actor TEXT NOT NULL DEFAULT 'system',
        risk_level TEXT, metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, evidence_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info', title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '{}',
        source TEXT NOT NULL DEFAULT 'system', metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS policy_decisions (
        id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL, decision TEXT NOT NULL,
        explanation TEXT NOT NULL DEFAULT '', matching_policies_json TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const engine = new ExecutionEngine(db, {
      broadcastTaskEvent: () => {},
      broadcastTaskEventById: () => {},
    } as any);
    const attempts: string[] = [];
    const executor = (kind: 'claude' | 'codex', result: Record<string, unknown>): TaskExecutor => ({
      kind,
      canExecute: () => true,
      start: async (task) => {
        attempts.push(kind);
        return {
          id: `session-${kind}`,
          taskId: task.id,
          executorKind: kind,
          status: 'running',
          startedAt: new Date(),
          events: (async function* () {})(),
          result: Promise.resolve(result as any),
          cancel: async () => {},
        };
      },
    });
    engine.registerExecutor({
      kind: 'claude',
      canExecute: () => true,
      start: async () => {
        attempts.push('claude');
        throw new ExecutionFailureError({
          code: 'PROVIDER_UNAVAILABLE',
          message: '503 provider unavailable',
          retryable: true,
          sideEffectsPossible: false,
          failureDomain: 'claude',
        });
      },
    });
    engine.registerExecutor(executor('codex', { status: 'completed', message: 'done' }));

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { sub: 'admin', email: 'admin@example.invalid', role: UserRole.ADMIN };
      next();
    });
    app.use('/api/tasks', createTaskRoutes(db, engine));
    app.use(errorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    (server as any).attempts = attempts;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  it('creates an execution attempt, falls back, and persists the successful result', async () => {
    db.prepare(`
      INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, metadata)
      VALUES ('task-http-fallback', 'Fallback task', 'Exercise provider fallback', 'pending', 'medium', 'low', 'local', ?)
    `).run(JSON.stringify({ executionMode: 'standard' }));

    const response = await fetch(`${baseUrl}/api/tasks/task-http-fallback/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor: 'claude' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'started', task_id: 'task-http-fallback' });

    for (let i = 0; i < 20; i++) {
      const task = db.prepare("SELECT status FROM tasks WHERE id = 'task-http-fallback'").get() as { status: string };
      if (task.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect((server as any).attempts).toEqual(['claude', 'codex']);
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'task-http-fallback'").get()).toEqual({ status: 'completed' });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM execution_events
      WHERE task_id = 'task-http-fallback' AND message = 'Retrying with fallback executor codex'
    `).get()).toEqual({ count: 1 });
    expect((db.prepare("SELECT COUNT(*) AS count FROM execution_evidence WHERE task_id = 'task-http-fallback'").get() as { count: number }).count).toBeGreaterThan(0);
  });

  it('preserves server-owned Deep Agent assurance metadata on task updates', async () => {
    db.prepare(`
      INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, metadata)
      VALUES ('task-assurance-hold', 'Held task', '', 'awaiting_approval', 'medium', 'low', 'local', ?)
    `).run(JSON.stringify({ deep_agent_assurance_hold: true, deep_agent_assurance_reason: 'EVE_V_ADAPTER_REQUIRED' }));

    const response = await fetch(`${baseUrl}/api/tasks/task-assurance-hold`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { client_note: 'preserved', deep_agent_assurance_hold: false } }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).metadata).toEqual({
      client_note: 'preserved',
      deep_agent_assurance_hold: true,
      deep_agent_assurance_reason: 'EVE_V_ADAPTER_REQUIRED',
    });

    const promotion = await fetch(`${baseUrl}/api/tasks/task-assurance-hold`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed', completed_at: new Date().toISOString() }),
    });
    expect(promotion.status).toBe(409);
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'task-assurance-hold'").get()).toEqual({ status: 'awaiting_approval' });
  });
});
