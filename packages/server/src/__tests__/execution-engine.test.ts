import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        user_id TEXT,
        agent_id TEXT,
        task_id TEXT,
        execution_event_id TEXT,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        actor TEXT,
        risk_level TEXT NOT NULL DEFAULT 'low' CHECK(risk_level IN ('low', 'medium', 'high', 'critical')),
        before TEXT,
        after TEXT,
        ip_address TEXT,
        user_agent TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

  it('queues execution when the shared runtime concurrency cap is full', async () => {
    const previousLimit = process.env.RUNTIME_MAX_CONCURRENCY;
    process.env.RUNTIME_MAX_CONCURRENCY = '1';
    const starts: string[] = [];
    const finish = new Map<string, (result: any) => void>();
    engine.registerExecutor({
      kind: 'mock',
      canExecute: () => true,
      start: async (task: Task) => ({
        id: `session-${task.id}`,
        taskId: task.id,
        executorKind: 'mock',
        status: 'running',
        startedAt: new Date(),
        events: (async function* () {})(),
        result: new Promise((resolve) => {
          starts.push(task.id);
          finish.set(task.id, resolve);
        }),
        cancel: async () => {},
      }),
    } as any);
    const first = createTask({ id: 'concurrency-first' });
    const second = createTask({ id: 'concurrency-second' });
    for (const task of [first, second]) {
      db.prepare('INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        task.id, task.title, task.description, 'pending', 'medium', 'low', 'local',
      );
    }

    try {
      const firstExecution = await engine.executeTask(first.id, 'mock');
      const secondExecutionPromise = engine.executeTask(second.id, 'mock');
      await Promise.resolve();
      expect(starts).toEqual([first.id]);
      await expect(engine.executeTask(second.id, 'mock')).rejects.toThrow('Task is already running');

      finish.get(first.id)!({ status: 'completed', message: 'done', metrics: { executionTimeMs: 1 } });
      await firstExecution.completion;
      const secondExecution = await secondExecutionPromise;
      expect(starts).toEqual([first.id, second.id]);

      finish.get(second.id)!({ status: 'completed', message: 'done', metrics: { executionTimeMs: 1 } });
      await secondExecution.completion;
    } finally {
      if (previousLimit === undefined) delete process.env.RUNTIME_MAX_CONCURRENCY;
      else process.env.RUNTIME_MAX_CONCURRENCY = previousLimit;
    }
  });

  it('persists a stream-truncated event when the event deadline is reached', async () => {
    const previousTimeout = process.env.EXECUTION_EVENT_STREAM_TIMEOUT_MS;
    process.env.EXECUTION_EVENT_STREAM_TIMEOUT_MS = '-1';
    const session = {
      taskId: 'stream-timeout-task',
      executorKind: 'mock',
      events: (async function* () {
        yield { task_id: 'stream-timeout-task', event_type: 'log', message: 'too late', level: 'info' };
      })(),
    };

    try {
      await (engine as any).processEventStream(session);
      const events = db.prepare('SELECT event_type, message, metadata FROM execution_events WHERE task_id = ?').all(session.taskId) as any[];
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('stream.truncated');
      expect(events[0].message).toContain('truncated');
      expect(JSON.parse(events[0].metadata)).toMatchObject({ stream_timeout_ms: -1, executor_kind: 'mock' });
    } finally {
      if (previousTimeout === undefined) delete process.env.EXECUTION_EVENT_STREAM_TIMEOUT_MS;
      else process.env.EXECUTION_EVENT_STREAM_TIMEOUT_MS = previousTimeout;
    }
  });

  it('attributes a completed task to the exact admitted manifest skill version and hash', async () => {
    const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-attribution-'));
    try {
      const skillDir = path.join(skillsDir, 'running-tests');
      fs.mkdirSync(skillDir);
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
        '---', 'name: running-tests', 'description: Run bounded tests.', '---',
        'Plan the scoped test, execute it, verify output, and stop.', '',
      ].join('\n'));
      fs.writeFileSync(path.join(skillDir, 'skill.manifest.yaml'), [
        'skill_id: .opencode.skills.running-tests',
        'version: 0.1.0',
        'owner: djimit',
        'allowed_tools: [Read, Grep, Glob, Bash]',
        'disallowed_tools: [ProductionWrite]',
        '',
      ].join('\n'));

      const attributedEngine = new ExecutionEngine(db, createMockWsService(), skillsDir);
      attributedEngine.registerExecutor({
        kind: 'mock',
        canExecute: () => true,
        start: async (task: Task) => ({
          id: 'immediate-session', taskId: task.id, executorKind: 'mock', status: 'running', startedAt: new Date(),
          events: (async function* () {})(),
          result: Promise.resolve({ status: 'completed', message: 'ok', stdout: 'worker output', stderr: '', metrics: { executionTimeMs: 1, tokenUsage: 100, toolCalls: 0 } }),
          cancel: async () => {},
        }),
      } as any);
      db.prepare("INSERT INTO agents (id, name) VALUES ('agent-skill', 'Skill Agent')").run();
      db.prepare("INSERT INTO agent_skills (agent_id, skill_id) VALUES ('agent-skill', '.opencode.skills.running-tests')").run();
      db.prepare(`
        INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, agent_id, metadata)
        VALUES ('task-skill', 'Run tests', 'Run the bounded test', 'pending', 'medium', 'low', 'local', 'agent-skill', ?)
      `).run(JSON.stringify({ skillId: '.opencode.skills.running-tests' }));

      const execution = await attributedEngine.executeTask('task-skill', 'mock');
      await expect(execution.completion).resolves.toMatchObject({ status: 'completed', stdout: 'worker output' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const row = db.prepare(`
        SELECT skill_id, skill_version, skill_content_hash, task_id, agent_id, success, tokens_used
        FROM skill_outcomes WHERE task_id = 'task-skill'
      `).get() as any;
      expect(row).toMatchObject({
        skill_id: '.opencode.skills.running-tests', skill_version: '0.1.0', task_id: 'task-skill',
        agent_id: 'agent-skill', success: 1, tokens_used: 100,
      });
      expect(row.skill_content_hash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      fs.rmSync(skillsDir, { recursive: true, force: true });
    }
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

  describe('governance gate integration', () => {
    const GATE_KEYS = ['GOVERNANCE_GATE_ENABLED', 'GOVERNANCE_GATE_FLOOR', 'GOVERNANCE_GATE_MODEL_MAP'];
    const previousEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of GATE_KEYS) { previousEnv[key] = process.env[key]; delete process.env[key]; }
    });

    afterEach(() => {
      for (const key of GATE_KEYS) {
        if (previousEnv[key] === undefined) delete process.env[key];
        else process.env[key] = previousEnv[key];
      }
    });

    function insertLowScoreRun(agentId: string, score: number) {
      db.prepare(`
        INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, completed_cases, overall_score, started_at, finished_at, metadata)
        VALUES (?, ?, 'completed', 78, 78, ?, '2026-07-15T10:00:00Z', '2026-07-15T10:05:00Z', '{}')
      `).run(`run-${Math.random().toString(36).slice(2)}`, agentId, score);
    }

    it('tightens allow to awaiting_approval when the benchmarked model is below the floor', async () => {
      process.env.GOVERNANCE_GATE_ENABLED = 'true';
      process.env.GOVERNANCE_GATE_MODEL_MAP = 'mock=weak-model';
      insertLowScoreRun('nightly:weak-model', 1.9);

      const task = createTask();
      db.prepare('INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        task.id, task.title, task.description, 'pending', 'medium', 'low', 'local',
      );

      const result = await engine.executeTask(task.id, 'mock');

      expect(result.status).toBe('awaiting_approval');
      expect(result.reason).toContain('Governance gate');

      const evidence = db.prepare("SELECT * FROM execution_evidence WHERE task_id = ? AND source = 'governance-gate'").all(task.id);
      expect(evidence.length).toBe(1);
    });

    it('does not fire when the benchmarked model clears the floor', async () => {
      process.env.GOVERNANCE_GATE_ENABLED = 'true';
      process.env.GOVERNANCE_GATE_MODEL_MAP = 'mock=strong-model';
      insertLowScoreRun('nightly:strong-model', 4.2);

      const task = createTask();
      db.prepare('INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        task.id, task.title, task.description, 'pending', 'medium', 'low', 'local',
      );

      const result = await engine.executeTask(task.id, 'mock');
      expect(result.status).toBe('started');
    });
  });
});
