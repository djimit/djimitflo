import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SelfHealingService } from '../services/self-healing-service';

describe('SelfHealingService', () => {
  let db: Database.Database;
  let service: SelfHealingService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE loop_runs (
        id TEXT PRIMARY KEY, goal_id TEXT, loop_name TEXT, mode TEXT DEFAULT 'closed',
        status TEXT DEFAULT 'created', repository_path TEXT, state_file TEXT,
        findings_json TEXT DEFAULT '[]', plan_json TEXT DEFAULT '{}',
        gates_json TEXT DEFAULT '[]', next_actions_json TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE TABLE worker_leases (
        id TEXT PRIMARY KEY, loop_run_id TEXT, role TEXT, runtime TEXT DEFAULT 'codex',
        status TEXT DEFAULT 'prepared', finding_id TEXT, worktree_path TEXT,
        metadata TEXT DEFAULT '{}', budget_json TEXT DEFAULT '{}',
        capability_id TEXT, parent_lease_id TEXT, spawn_tree_id TEXT,
        depth INTEGER DEFAULT 0, spawned_by_agent_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'idle');
      CREATE TABLE goals (id TEXT PRIMARY KEY, objective TEXT, status TEXT DEFAULT 'created');
      CREATE TABLE openmythos_eval_runs (
        id TEXT PRIMARY KEY, agent_id TEXT, started_at TEXT, finished_at TEXT,
        total_cases INTEGER DEFAULT 0, completed_cases INTEGER DEFAULT 0,
        overall_score REAL DEFAULT 0, status TEXT DEFAULT 'pending',
        categories_json TEXT DEFAULT '[]', judge_model TEXT DEFAULT 'qwen2.5:14b',
        metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    service = new SelfHealingService(db);
  });

  it('runs health checks', () => {
    const checks = service.checkHealth();
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[0].name).toBeDefined();
    expect(checks[0].status).toMatch(/healthy|degraded|critical/);
  });

  it('detects stale leases', () => {
    // Insert a stale prepared lease
    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, created_at, updated_at)
      VALUES ('lease-1', 'run-1', 'maker', 'mock', 'prepared', datetime('now', '-48 hours'), datetime('now', '-48 hours'))
    `).run();

    const checks = service.checkHealth();
    const staleCheck = checks.find(c => c.name === 'stale_leases');
    expect(staleCheck).toBeDefined();
    expect(staleCheck?.status).not.toBe('healthy');
  });

  it('detects high loop failure rate', () => {
    // Insert failed loops
    for (let i = 0; i < 10; i++) {
      db.prepare(`
        INSERT INTO loop_runs (id, loop_name, status, created_at)
        VALUES (?, 'test-loop', 'failed', datetime('now', '-1 hour'))
      `).run(`run-${i}`);
    }

    const checks = service.checkHealth();
    const failureCheck = checks.find(c => c.name === 'loop_failure_rate');
    expect(failureCheck).toBeDefined();
    expect(failureCheck?.status).toBe('critical');
  });

  it('detects high memory usage', () => {
    const checks = service.checkHealth();
    const memCheck = checks.find(c => c.name === 'memory_usage');
    expect(memCheck).toBeDefined();
    expect(memCheck?.message).toContain('Memory usage');
  });

  it('heal() returns incidents for unhealthy checks', () => {
    // Insert problematic data
    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, created_at, updated_at)
      VALUES ('lease-1', 'run-1', 'maker', 'mock', 'prepared', datetime('now', '-48 hours'), datetime('now', '-48 hours'))
    `).run();

    const result = service.heal();
    expect(result.incidents).toBeDefined();
    expect(result.actions).toBeDefined();
  });

  it('provides stats', () => {
    const stats = service.getStats();
    expect(stats.totalChecks).toBe(5);
    expect(stats.healthyChecks).toBeGreaterThanOrEqual(0);
  });
});
