import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestDb } from './helpers/test-db';
import { ExecutionEngine } from '../execution/execution-engine';
import { MockExecutor } from '../execution/executors/mock-executor';
import type { Task } from '@djimitflo/shared';
import type { TaskExecutor } from '../execution/types';

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

function writeTestSkill(skillsDir: string, skillId: string): void {
  const skillDir = join(skillsDir, skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), [
    '---',
    `name: ${skillId}`,
    `description: ${skillId} for execution attribution`,
    'version: 1.0.0',
    'author: test',
    'allowed-tools: read_file',
    '---',
    '<disallowed_tools>shell</disallowed_tools>',
    `Use read_file only for ${skillId}.`,
  ].join('\n'));
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

  it('records an admitted skill outcome when a task completes', async () => {
    const skillsDir = join(tmpdir(), `djimitflo-skills-${Date.now()}`);
    writeTestSkill(skillsDir, 'test-skill');

    try {
      const localEngine = new ExecutionEngine(db, createMockWsService(), skillsDir);
      const instantExecutor: TaskExecutor = {
        kind: 'custom',
        canExecute: () => true,
        start: async (task) => ({
          id: 'session-1',
          taskId: task.id,
          executorKind: 'custom',
          status: 'running',
          startedAt: new Date(),
          events: (async function* () {})(),
          result: Promise.resolve({
            status: 'completed',
            message: 'done',
            metrics: { executionTimeMs: 1, tokenUsage: 7 },
          }),
          cancel: async () => {},
        }),
      };
      localEngine.registerExecutor(instantExecutor);
      const task = createTask({ metadata: { skillId: 'test-skill' } });
      db.prepare(`
        INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(task.id, task.title, task.description, 'pending', 'medium', 'low', 'local', JSON.stringify(task.metadata));

      await localEngine.executeTask(task.id, 'custom');
      for (let i = 0; i < 10; i++) {
        const row = db.prepare('SELECT skill_id FROM skill_outcomes WHERE task_id = ?').get(task.id) as any;
        if (row) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const outcome = db.prepare(`
        SELECT skill_id, task_id, skill_version, skill_content_hash, model, success, tokens_used
        FROM skill_outcomes WHERE task_id = ?
      `).get(task.id) as any;
      expect(outcome).toMatchObject({
        skill_id: 'test-skill',
        task_id: task.id,
        skill_version: '1.0.0',
        model: 'custom',
        success: 1,
        tokens_used: 7,
      });
      expect(outcome.skill_content_hash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(skillsDir, { recursive: true, force: true });
    }
  });

  it('blocks multi-skill tasks without explicit skill attribution before execution', async () => {
    const skillsDir = join(tmpdir(), `djimitflo-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    for (const skillId of ['test-skill-a', 'test-skill-b']) {
      writeTestSkill(skillsDir, skillId);
    }

    try {
      const localEngine = new ExecutionEngine(db, createMockWsService(), skillsDir);
      let started = false;
      const instantExecutor: TaskExecutor = {
        kind: 'custom',
        canExecute: () => true,
        start: async (task) => {
          started = true;
          return {
            id: 'session-1',
            taskId: task.id,
            executorKind: 'custom',
            status: 'running',
            startedAt: new Date(),
            events: (async function* () {})(),
            result: Promise.resolve({
              status: 'completed',
              message: 'done',
              metrics: { executionTimeMs: 1, tokenUsage: 11 },
            }),
            cancel: async () => {},
          };
        },
      };
      localEngine.registerExecutor(instantExecutor);
      db.prepare("INSERT INTO agents (id, name, description, status) VALUES ('agent-1', 'agent 1', 'test agent', 'idle')").run();
      db.prepare("INSERT INTO agent_skills (agent_id, skill_id, enabled, assigned_at) VALUES ('agent-1', 'test-skill-a', 1, datetime('now'))").run();
      db.prepare("INSERT INTO agent_skills (agent_id, skill_id, enabled, assigned_at) VALUES ('agent-1', 'test-skill-b', 1, datetime('now'))").run();

      const task = createTask({ agent_id: 'agent-1' });
      db.prepare(`
        INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, agent_id, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(task.id, task.title, task.description, 'pending', 'medium', 'low', 'local', task.agent_id, JSON.stringify(task.metadata));

      const result = await localEngine.executeTask(task.id, 'custom');

      expect(result.status).toBe('denied');
      expect(started).toBe(false);
      expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id)).toEqual({ status: 'cancelled' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM skill_outcomes WHERE task_id = ?').get(task.id)).toEqual({ count: 0 });
      const warning = db.prepare(`
        SELECT severity, summary, details, metadata
        FROM execution_evidence
        WHERE task_id = ? AND title = 'Execution blocked: invalid skill attribution'
      `).get(task.id) as any;
      expect(warning.severity).toBe('error');
      expect(warning.summary).toContain('metadata.skillId');
      expect(JSON.parse(warning.details).assignedSkillIds.sort()).toEqual(['test-skill-a', 'test-skill-b']);
      expect(JSON.parse(warning.metadata)).toEqual({ reason: 'ambiguous_skill_attribution' });
    } finally {
      rmSync(skillsDir, { recursive: true, force: true });
    }
  });

  it('blocks unknown explicit skill attribution before execution', async () => {
    const localEngine = new ExecutionEngine(db, createMockWsService());
    let started = false;
    localEngine.registerExecutor({
      kind: 'custom',
      canExecute: () => true,
      start: async (task) => {
        started = true;
        return {
          id: 'session-1',
          taskId: task.id,
          executorKind: 'custom',
          status: 'running',
          startedAt: new Date(),
          events: (async function* () {})(),
          result: Promise.resolve({ status: 'completed', message: 'done' }),
          cancel: async () => {},
        };
      },
    });

    const task = createTask({ metadata: { skillId: 'missing-skill' } });
    db.prepare(`
      INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.title, task.description, 'pending', 'medium', 'low', 'local', JSON.stringify(task.metadata));

    const result = await localEngine.executeTask(task.id, 'custom');

    expect(result.status).toBe('denied');
    expect(started).toBe(false);
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id)).toEqual({ status: 'cancelled' });
    expect(db.prepare(`
      SELECT metadata FROM execution_evidence
      WHERE task_id = ? AND title = 'Execution blocked: invalid skill attribution'
    `).get(task.id)).toEqual({ metadata: JSON.stringify({ reason: 'invalid_skill_attribution' }) });
  });

  it('blocks explicit skill attribution not assigned to the task agent', async () => {
    const skillsDir = join(tmpdir(), `djimitflo-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    writeTestSkill(skillsDir, 'test-skill-a');
    writeTestSkill(skillsDir, 'test-skill-b');

    try {
      const localEngine = new ExecutionEngine(db, createMockWsService(), skillsDir);
      let started = false;
      localEngine.registerExecutor({
        kind: 'custom',
        canExecute: () => true,
        start: async (task) => {
          started = true;
          return {
            id: 'session-1',
            taskId: task.id,
            executorKind: 'custom',
            status: 'running',
            startedAt: new Date(),
            events: (async function* () {})(),
            result: Promise.resolve({ status: 'completed', message: 'done' }),
            cancel: async () => {},
          };
        },
      });
      db.prepare("INSERT INTO agents (id, name, description, status) VALUES ('agent-1', 'agent 1', 'test agent', 'idle')").run();
      db.prepare("INSERT INTO agent_skills (agent_id, skill_id, enabled, assigned_at) VALUES ('agent-1', 'test-skill-a', 1, datetime('now'))").run();
      const task = createTask({ agent_id: 'agent-1', metadata: { skillId: 'test-skill-b' } });
      db.prepare(`
        INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, agent_id, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(task.id, task.title, task.description, 'pending', 'medium', 'low', 'local', task.agent_id, JSON.stringify(task.metadata));

      const result = await localEngine.executeTask(task.id, 'custom');

      expect(result.status).toBe('denied');
      expect(started).toBe(false);
      const warning = db.prepare(`
        SELECT details, metadata FROM execution_evidence
        WHERE task_id = ? AND title = 'Execution blocked: invalid skill attribution'
      `).get(task.id) as any;
      expect(JSON.parse(warning.details)).toEqual({ assignedSkillIds: ['test-skill-a'] });
      expect(JSON.parse(warning.metadata)).toEqual({ reason: 'unassigned_skill_attribution' });
    } finally {
      rmSync(skillsDir, { recursive: true, force: true });
    }
  });
});
