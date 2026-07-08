import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createGoalRoutes } from '../routes/goals';
import { createLoopRoutes } from '../routes/loops';
import { createDiscussionRoutes } from '../routes/discussions';
import { createTaskRoutes } from '../routes/tasks';
import { createAgentRoutes } from '../routes/agents';
import { createOpenMythosRoutes } from '../routes/openmythos';
import { createGymRoutes } from '../routes/gym';
import { createCognitiveRoutes } from '../routes/cognitive';

/**
 * Integration tests: all route factories mount without import errors.
 * Catches: missing route modules, broken imports, middleware chain errors.
 */

describe('Route factory mounting', () => {
  let db: Database.Database;
  let auth: ReturnType<typeof createAuthMiddleware>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, objective TEXT, status TEXT DEFAULT 'created', budget_json TEXT DEFAULT '{}', constraints_json TEXT DEFAULT '[]', acceptance_criteria_json TEXT DEFAULT '[]', risk_class TEXT DEFAULT 'low', owner_user_id TEXT, metadata TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS loop_runs (id TEXT PRIMARY KEY, goal_id TEXT, loop_name TEXT, mode TEXT DEFAULT 'closed', status TEXT DEFAULT 'created', repository_path TEXT, state_file TEXT, findings_json TEXT DEFAULT '[]', plan_json TEXT DEFAULT '{}', gates_json TEXT DEFAULT '[]', next_actions_json TEXT DEFAULT '[]', metadata_json TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT, completed_at TEXT);
      CREATE TABLE IF NOT EXISTS worker_leases (id TEXT PRIMARY KEY, loop_run_id TEXT, role TEXT, runtime TEXT DEFAULT 'codex', status TEXT DEFAULT 'prepared', finding_id TEXT, worktree_path TEXT, metadata TEXT DEFAULT '{}', budget_json TEXT DEFAULT '{}', capability_id TEXT, parent_lease_id TEXT, spawn_tree_id TEXT, depth INTEGER DEFAULT 0, spawned_by_agent_id TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'idle', capabilities_json TEXT DEFAULT '[]', model TEXT, temperature REAL DEFAULT 0.7, max_tokens INTEGER DEFAULT 4096, last_seen TEXT, metadata TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT DEFAULT 'pending', metadata TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS openmythos_eval_runs (id TEXT PRIMARY KEY, agent_id TEXT, started_at TEXT, finished_at TEXT, total_cases INTEGER DEFAULT 0, completed_cases INTEGER DEFAULT 0, overall_score REAL DEFAULT 0, status TEXT DEFAULT 'pending', categories_json TEXT DEFAULT '[]', judge_model TEXT DEFAULT 'qwen2.5:14b', metadata TEXT DEFAULT '{}', created_at TEXT);
      CREATE TABLE IF NOT EXISTS openmythos_case_results (id TEXT PRIMARY KEY, run_id TEXT, case_id TEXT, category TEXT, difficulty INTEGER DEFAULT 1, response TEXT, judge_score REAL DEFAULT 0, judge_rationale TEXT, latency_ms INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', created_at TEXT);
      CREATE TABLE IF NOT EXISTS agent_eval_runs (id TEXT PRIMARY KEY, suite_name TEXT, target_type TEXT, target_ref TEXT, status TEXT, score REAL, scorecard_json TEXT DEFAULT '{}', findings_json TEXT DEFAULT '[]', source TEXT DEFAULT 'internal', benchmark_version TEXT, judge_model TEXT, metadata TEXT DEFAULT '{}', created_at TEXT);
      CREATE TABLE IF NOT EXISTS gym_evaluations (id TEXT PRIMARY KEY, skill_id TEXT, score REAL, metrics_json TEXT, eval_type TEXT DEFAULT 'functional', created_at TEXT);
    `);

    const authService = new AuthService(db);
    auth = createAuthMiddleware(authService);
  });

  it('createGoalRoutes mounts without throwing', () => {
    expect(() => createGoalRoutes(db, auth)).not.toThrow();
  });

  it('createLoopRoutes mounts without throwing', () => {
    expect(() => createLoopRoutes(db, auth)).not.toThrow();
  });

  it('createDiscussionRoutes mounts without throwing', () => {
    expect(() => createDiscussionRoutes(db, auth)).not.toThrow();
  });

  it('createTaskRoutes mounts without throwing', () => {
    expect(() => createTaskRoutes(db)).not.toThrow();
  });

  it('createOpenMythosRoutes mounts without throwing', () => {
    expect(() => createOpenMythosRoutes(db, auth)).not.toThrow();
  });

  it('createGymRoutes mounts without throwing', () => {
    expect(() => createGymRoutes(db, auth)).not.toThrow();
  });

  it('createAgentRoutes mounts without throwing', () => {
    expect(() => createAgentRoutes(db, auth)).not.toThrow();
  });

  it('createCognitiveRoutes mounts without throwing', () => {
    expect(() => createCognitiveRoutes(db, auth)).not.toThrow();
  });
});
