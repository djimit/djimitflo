/**
 * Shared mock factories for DjimFlo service tests.
 * Provides reusable mocks for common service dependencies.
 * 
 * Constitution v1.1.0 — Task 4.4: Mock factories for untested services
 */
import { vi } from 'vitest';
import Database from 'better-sqlite3';

/**
 * Create an in-memory test database with all required tables.
 */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY, objective TEXT, status TEXT DEFAULT 'created',
      budget_json TEXT DEFAULT '{}', constraints_json TEXT DEFAULT '[]',
      acceptance_criteria_json TEXT DEFAULT '[]', risk_class TEXT DEFAULT 'low',
      owner_user_id TEXT, metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS loop_runs (
      id TEXT PRIMARY KEY, goal_id TEXT, loop_name TEXT, mode TEXT DEFAULT 'closed',
      status TEXT DEFAULT 'created', repository_path TEXT, state_file TEXT,
      findings_json TEXT DEFAULT '[]', plan_json TEXT DEFAULT '{}',
      gates_json TEXT DEFAULT '[]', next_actions_json TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}', metadata_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS loop_events (
      id TEXT PRIMARY KEY, loop_run_id TEXT, event_type TEXT, level TEXT DEFAULT 'info',
      message TEXT, metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS worker_leases (
      id TEXT PRIMARY KEY, loop_run_id TEXT, role TEXT, runtime TEXT DEFAULT 'codex',
      status TEXT DEFAULT 'prepared', finding_id TEXT, worktree_path TEXT,
      metadata TEXT DEFAULT '{}', budget_json TEXT DEFAULT '{}',
      capability_id TEXT, parent_lease_id TEXT, spawn_tree_id TEXT,
      depth INTEGER DEFAULT 0, spawned_by_agent_id TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY, actor TEXT, action TEXT, resource_type TEXT,
      resource_id TEXT, outcome TEXT, metadata TEXT DEFAULT '{}',
      hash_chain TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS compliance_reports (
      id TEXT PRIMARY KEY, type TEXT, findings TEXT DEFAULT '[]',
      score REAL, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

/**
 * Mock the better-sqlite3 module for unit tests that don't need a real DB.
 */
export function mockDatabase() {
  const mockDb = {
    prepare: vi.fn().mockReturnThis(),
    run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
    get: vi.fn().mockReturnValue(undefined),
    all: vi.fn().mockReturnValue([]),
    exec: vi.fn(),
    pragma: vi.fn(),
    close: vi.fn(),
    transaction: vi.fn((fn) => fn),
  };
  return mockDb;
}

/**
 * Mock the swarm event bus for tests that trigger events.
 */
export function mockSwarmEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
  };
}

/**
 * Mock the lifecycle manager for graceful shutdown testing.
 */
export function mockLifecycleManager() {
  return {
    register: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    isShuttingDown: vi.fn().mockReturnValue(false),
  };
}

/**
 * Mock the logger to suppress output during tests.
 */
export function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };
}

/**
 * Mock the Ollama/LLM client for tests that call external models.
 */
export function mockLlmClient() {
  return {
    generate: vi.fn().mockResolvedValue({ response: 'mock response', tokens: 10 }),
    embed: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
    isAvailable: vi.fn().mockReturnValue(true),
  };
}

/**
 * Mock the git service for worktree operations.
 */
export function mockGitService() {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    clone: vi.fn().mockResolvedValue(undefined),
    branch: vi.fn().mockResolvedValue('test-branch'),
    commit: vi.fn().mockResolvedValue('abc123'),
    push: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({ clean: true, files: [] }),
  };
}

/**
 * Setup function that mocks all common DjimFlo dependencies.
 * Use in beforeEach for service tests.
 */
export function setupServiceMocks() {
  const mocks = {
    db: mockDatabase(),
    eventBus: mockSwarmEventBus(),
    lifecycle: mockLifecycleManager(),
    logger: mockLogger(),
    llm: mockLlmClient(),
    git: mockGitService(),
  };

  vi.mock('../config/logger', () => ({ logger: mocks.logger }));
  vi.mock('../events/swarm-event-bus', () => ({ swarmEventBus: mocks.eventBus }));
  vi.mock('../lifecycle/manager', () => ({ lifecycleManager: mocks.lifecycle }));

  return mocks;
}

/**
 * Teardown function to restore all mocks.
 * Use in afterEach.
 */
export function teardownServiceMocks() {
  vi.restoreAllMocks();
}

/**
 * Create a mock Express request for route testing.
 */
export function mockRequest(overrides: Record<string, unknown> = {}) {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    user: { id: 'test-user', role: 'admin' },
    ip: '127.0.0.1',
    ...overrides,
  } as any;
}

/**
 * Create a mock Express response for route testing.
 */
export function mockResponse() {
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
  };
  return res;
}

/**
 * Create a mock Express next function for middleware testing.
 */
export function mockNext() {
  return vi.fn();
}

/**
 * Test helper: wrap an async function with timeout.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number = 5000,
  message: string = 'Operation timed out'
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms)
    ),
  ]);
}
