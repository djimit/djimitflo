import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { ExecutionEngine } from '../execution/execution-engine';
import { MockExecutor } from '../execution/executors/mock-executor';
import type { Task } from '@djimitflo/shared';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2)}`,
    title: 'Test task',
    description: 'echo hello',
    status: 'pending',
    priority: 'medium',
    risk_level: 'low',
    execution_mode: 'local',
    agent_id: null,
    parent_task_id: null,
    repository_id: null,
    instruction_profile_id: null,
    started_at: null,
    completed_at: null,
    failed_at: null,
    execution_time_ms: null,
    token_usage: null,
    tags: [],
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function createMockWsService() {
  return {
    broadcastTaskEvent: () => {},
    broadcastTaskEventById: () => {},
    broadcast: () => {},
    close: () => {},
  } as any;
}

describe('ExecutionEngine', () => {
  let db: ReturnType<typeof createTestDb>;
  let engine: ExecutionEngine;

  beforeEach(() => {
    db = createTestDb();
    // Tables not in test-db helper but needed by ExecutionEngine services
    db.exec(`
      CREATE TABLE IF NOT EXISTS execution_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        message TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        tool_name TEXT,
        tool_input TEXT,
        tool_output TEXT,
        tool_error TEXT,
        approval_id TEXT,
        artifact_id TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS approval_policies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        action_type TEXT NOT NULL,
        decision TEXT NOT NULL DEFAULT 'require_approval',
        match_pattern TEXT,
        protected_paths TEXT NOT NULL DEFAULT '[]',
        allowed_tools TEXT NOT NULL DEFAULT '[]',
        blocked_tools TEXT NOT NULL DEFAULT '[]',
        require_reason INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS risk_assessments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        risk_score REAL NOT NULL DEFAULT 0,
        factors_json TEXT NOT NULL DEFAULT '[]',
        assessment_type TEXT NOT NULL DEFAULT 'task',
        execution_event_id TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT,
        resource_id TEXT,
        task_id TEXT,
        actor TEXT NOT NULL DEFAULT 'system',
        risk_level TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        details TEXT NOT NULL DEFAULT '{}',
        source TEXT NOT NULL DEFAULT 'system',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS policy_decisions (
        id TEXT PRIMARY KEY,
        assessment_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        explanation TEXT NOT NULL DEFAULT '',
        matching_policies_json TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    engine = new ExecutionEngine(db, createMockWsService());
  });

  it('registers default executors on construction', () => {
    expect(engine.getExecutor('mock')).toBeDefined();
    expect(engine.getExecutor('opencode')).toBeDefined();
    expect(engine.getExecutor('codex')).toBeDefined();
    expect(engine.getExecutor('claude')).toBeDefined();
    expect(engine.getExecutor('gemini')).toBeDefined();
    expect(engine.getExecutor('editor')).toBeDefined();
    expect(engine.getExecutor('pi')).toBeDefined();
  });

  it('allows registering a custom executor', () => {
    const custom = new MockExecutor();
    (custom as any).kind = 'custom';
    engine.registerExecutor(custom);
    expect(engine.getExecutor('custom')).toBe(custom);
  });

  it('executes a low-risk task with mock executor', async () => {
    const task = createTask();
    db.prepare('INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      task.id, task.title, task.description, 'pending', 'medium', 'low', 'local',
    );

    const result = await engine.executeTask(task.id, 'mock');
    expect(result.status).toBe('started');
  });

  it('throws when task not found', async () => {
    await expect(engine.executeTask('nonexistent', 'mock')).rejects.toThrow('Task not found');
  });

  it('throws when task is already running', async () => {
    const task = createTask();
    db.prepare('INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      task.id, task.title, task.description, 'pending', 'medium', 'low', 'local',
    );

    await engine.executeTask(task.id, 'mock');
    await expect(engine.executeTask(task.id, 'mock')).rejects.toThrow('Task is already running');
  });

  it('throws when executor not found', async () => {
    const task = createTask();
    db.prepare('INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      task.id, task.title, task.description, 'pending', 'medium', 'low', 'local',
    );

    await expect(engine.executeTask(task.id, 'nonexistent' as any)).rejects.toThrow('Executor not found');
  });

  it('persists risk assessment for executed tasks', async () => {
    const task = createTask();
    db.prepare('INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      task.id, task.title, task.description, 'pending', 'medium', 'low', 'local',
    );

    await engine.executeTask(task.id, 'mock');

    const assessments = db.prepare('SELECT * FROM risk_assessments WHERE task_id = ?').all(task.id);
    expect(assessments.length).toBeGreaterThan(0);
  });

  it('updates task status to running after execution starts', async () => {
    const task = createTask();
    db.prepare('INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      task.id, task.title, task.description, 'pending', 'medium', 'low', 'local',
    );

    await engine.executeTask(task.id, 'mock');

    const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as any;
    expect(['running', 'completed']).toContain(row.status);
  });
});
