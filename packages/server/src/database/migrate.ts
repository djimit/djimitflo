/**
 * Lightweight SQLite migrations for schema evolution.
 */

import BetterSqlite3 from 'better-sqlite3';
import { join } from 'path';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { createPhase56Tables } from './migrate-phase56';
import { seedMCPServers } from './seed-mcp-servers';

type ColumnSpec = {
  name: string;
  definition: string;
};

const LOOP_RUN_STATUSES = "'created', 'planning', 'running', 'verifying', 'ready_for_human_merge', 'blocked', 'completed', 'failed', 'escalated', 'cancelled', 'interrupted'";

const approvalColumns: ColumnSpec[] = [
  { name: 'action_type', definition: "TEXT" },
  { name: 'title', definition: "TEXT" },
  { name: 'description', definition: "TEXT" },
  { name: 'command', definition: "TEXT" },
  { name: 'tool_name', definition: "TEXT" },
  { name: 'target_path', definition: "TEXT" },
  { name: 'policy_id', definition: "TEXT" },
  { name: 'decided_at', definition: "TEXT" },
  { name: 'decided_by', definition: "TEXT" },
  { name: 'decision_reason', definition: "TEXT" },
];

const approvalPolicyColumns: ColumnSpec[] = [
  { name: 'action_type', definition: "TEXT" },
  { name: 'decision', definition: "TEXT NOT NULL DEFAULT 'require_approval'" },
  { name: 'match_pattern', definition: "TEXT" },
  { name: 'protected_paths', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { name: 'allowed_tools', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { name: 'blocked_tools', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { name: 'require_reason', definition: "INTEGER NOT NULL DEFAULT 0" },
];

const swarmClaimColumns: ColumnSpec[] = [
  { name: 'predicate', definition: 'TEXT' },
  { name: 'object', definition: 'TEXT' },
  { name: 'scope', definition: 'TEXT' },
  { name: 'contradicts_ref', definition: 'TEXT' },
  { name: 'supports_ref', definition: 'TEXT' },
  { name: 'valid_until', definition: 'TEXT' },
];

function getColumns(db: BetterSqlite3Database, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function addMissingColumns(db: BetterSqlite3Database, tableName: string, columns: ColumnSpec[]) {
  const existing = getColumns(db, tableName);

  for (const column of columns) {
    if (!existing.has(column.name)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${column.name} ${column.definition}`);
    }
  }
}

function tableSql(db: BetterSqlite3Database, tableName: string): string | null {
  const row = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName) as { sql?: string } | undefined;
  return row?.sql || null;
}

function insertRows(db: BetterSqlite3Database, tableName: string, rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) {
    return;
  }
  const columns = Object.keys(rows[0]);
  const placeholders = columns.map(() => '?').join(', ');
  const insert = db.prepare(`
    INSERT INTO ${tableName} (${columns.join(', ')})
    VALUES (${placeholders})
  `);
  for (const row of rows) {
    insert.run(...columns.map((column) => row[column]));
  }
}

function createPhase42Tables(db: BetterSqlite3Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS risk_assessments (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      execution_event_id TEXT,
      action_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      recommended_decision TEXT NOT NULL,
      matched_rules TEXT NOT NULL,
      explanation TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
      FOREIGN KEY (execution_event_id) REFERENCES execution_events(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_risk_assessments_task_id ON risk_assessments(task_id);
    CREATE INDEX IF NOT EXISTS idx_risk_assessments_risk_level ON risk_assessments(risk_level);

    CREATE TABLE IF NOT EXISTS policy_violations (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      execution_event_id TEXT,
      policy_id TEXT,
      action_type TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      status TEXT NOT NULL,
      description TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
      FOREIGN KEY (execution_event_id) REFERENCES execution_events(id) ON DELETE SET NULL,
      FOREIGN KEY (policy_id) REFERENCES approval_policies(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_policy_violations_task_id ON policy_violations(task_id);

    CREATE TABLE IF NOT EXISTS mcp_tool_permissions (
      id TEXT PRIMARY KEY,
      tool_id TEXT NOT NULL,
      policy_id TEXT,
      decision TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      reason TEXT,
      last_seen_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tool_id) REFERENCES mcp_tools(id) ON DELETE CASCADE,
      FOREIGN KEY (policy_id) REFERENCES approval_policies(id) ON DELETE SET NULL,
      UNIQUE(tool_id)
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_tool_permissions_decision ON mcp_tool_permissions(decision);
  `);
}

function seedDefaultPolicies(db: BetterSqlite3Database) {
  const existingCount = db.prepare('SELECT COUNT(*) as count FROM approval_policies').get() as { count: number };
  if (existingCount.count > 0) {
    return;
  }

  const insert = db.prepare(`
    INSERT INTO approval_policies (
      id, name, description, enabled, priority, action_type, decision,
      risk_levels, tool_patterns, file_patterns, requires_approval, auto_approve,
      approval_timeout_ms, match_pattern, protected_paths, allowed_tools,
      blocked_tools, require_reason, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  const rows = [
    [
      'policy-low-task-allow',
      'Allow low-risk task execution',
      'Low-risk task starts are allowed by default.',
      1,
      100,
      'task_execution',
      'allow',
      JSON.stringify(['low']),
      JSON.stringify([]),
      JSON.stringify([]),
      0,
      0,
      null,
      null,
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      0,
      JSON.stringify({ seeded: true }),
      now,
      now,
    ],
    [
      'policy-medium-task-approval',
      'Require approval for medium+ task execution',
      'Task execution with medium or higher risk requires approval.',
      1,
      90,
      'task_execution',
      'require_approval',
      JSON.stringify(['medium', 'high', 'critical']),
      JSON.stringify([]),
      JSON.stringify([]),
      1,
      0,
      3600000,
      null,
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      1,
      JSON.stringify({ seeded: true }),
      now,
      now,
    ],
    [
      'policy-critical-secrets-deny',
      'Deny sensitive path access',
      'Sensitive local configuration and secret stores are denied by default.',
      1,
      110,
      'command',
      'deny',
      JSON.stringify(['critical']),
      JSON.stringify([]),
      JSON.stringify([]),
      0,
      0,
      null,
      '(~/.ssh|~/.aws|~/.config)',
      JSON.stringify(['~/.ssh', '~/.aws', '~/.config']),
      JSON.stringify([]),
      JSON.stringify([]),
      1,
      JSON.stringify({ seeded: true }),
      now,
      now,
    ],
    [
      'policy-critical-task-deny',
      'Deny critical-risk task execution',
      'Critical-risk task execution (destructive commands, path traversal) is always denied.',
      1,
      115,
      'task_execution',
      'deny',
      JSON.stringify(['critical']),
      JSON.stringify([]),
      JSON.stringify([]),
      0,
      0,
      null,
      null,
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      1,
      JSON.stringify({ seeded: true }),
      now,
      now,
    ],
  ];

  for (const row of rows) {
    const existing = db.prepare('SELECT id FROM approval_policies WHERE id = ?').get(row[0]);
    if (!existing) {
      insert.run(...row);
    }
  }
}

function createPhase43Tables(db: BetterSqlite3Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_evidence (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      execution_event_id TEXT,
      approval_id TEXT,
      evidence_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      details TEXT,
      source TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (execution_event_id) REFERENCES execution_events(id) ON DELETE SET NULL,
      FOREIGN KEY (approval_id) REFERENCES approvals(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_evidence_task_id ON execution_evidence(task_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_type ON execution_evidence(evidence_type);
    CREATE INDEX IF NOT EXISTS idx_evidence_severity ON execution_evidence(severity);

    CREATE TABLE IF NOT EXISTS execution_summaries (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE,
      executor_kind TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      duration_ms INTEGER,
      final_status TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      policy_decision TEXT NOT NULL,
      approval_required INTEGER NOT NULL DEFAULT 0,
      approval_granted INTEGER,
      event_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      warning_count INTEGER DEFAULT 0,
      evidence_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      files_changed TEXT NOT NULL DEFAULT '[]',
      commands_executed TEXT NOT NULL DEFAULT '[]',
      artifacts_created TEXT NOT NULL DEFAULT '[]',
      token_usage INTEGER,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_summary_task_id ON execution_summaries(task_id);
    CREATE INDEX IF NOT EXISTS idx_summary_status ON execution_summaries(final_status);

    CREATE TABLE IF NOT EXISTS file_changes (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      execution_event_id TEXT,
      file_path TEXT NOT NULL,
      change_type TEXT NOT NULL,
      before_hash TEXT,
      after_hash TEXT,
      before_size INTEGER,
      after_size INTEGER,
      diff TEXT,
      risk_level TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (execution_event_id) REFERENCES execution_events(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_file_changes_task_id ON file_changes(task_id);
    CREATE INDEX IF NOT EXISTS idx_file_changes_path ON file_changes(file_path);
  `);
}

function createPhase44Tables(db: BetterSqlite3Database) {
  const repositoryColumns: ColumnSpec[] = [
    { name: 'provider', definition: "TEXT NOT NULL DEFAULT 'local'" },
    { name: 'status', definition: "TEXT NOT NULL DEFAULT 'unknown'" },
    { name: 'detected_stacks', definition: "TEXT NOT NULL DEFAULT '[]'" },
    { name: 'package_manager', definition: "TEXT NOT NULL DEFAULT 'unknown'" },
    { name: 'test_commands', definition: "TEXT NOT NULL DEFAULT '[]'" },
    { name: 'build_commands', definition: "TEXT NOT NULL DEFAULT '[]'" },
    { name: 'lint_commands', definition: "TEXT NOT NULL DEFAULT '[]'" },
    { name: 'typecheck_commands', definition: "TEXT NOT NULL DEFAULT '[]'" },
    { name: 'has_git', definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: 'has_agents_md', definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: 'health_score', definition: "INTEGER" },
  ];
  addMissingColumns(db, 'repositories', repositoryColumns);

  db.exec(`
    CREATE TABLE IF NOT EXISTS repository_scans (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      is_git_repository INTEGER NOT NULL DEFAULT 0,
      current_branch TEXT,
      default_branch TEXT,
      is_clean INTEGER NOT NULL DEFAULT 1,
      staged_files INTEGER NOT NULL DEFAULT 0,
      modified_files INTEGER NOT NULL DEFAULT 0,
      untracked_files INTEGER NOT NULL DEFAULT 0,
      head_commit TEXT,
      head_commit_message TEXT,
      detected_stacks TEXT NOT NULL DEFAULT '[]',
      package_manager TEXT NOT NULL DEFAULT 'unknown',
      test_commands TEXT NOT NULL DEFAULT '[]',
      build_commands TEXT NOT NULL DEFAULT '[]',
      lint_commands TEXT NOT NULL DEFAULT '[]',
      typecheck_commands TEXT NOT NULL DEFAULT '[]',
      has_type_script INTEGER NOT NULL DEFAULT 0,
      has_tests INTEGER NOT NULL DEFAULT 0,
      has_lint INTEGER NOT NULL DEFAULT 0,
      has_ci INTEGER NOT NULL DEFAULT 0,
      has_docker INTEGER NOT NULL DEFAULT 0,
      health_score INTEGER,
      scan_duration_ms INTEGER,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_scans_repository ON repository_scans(repository_id);

    CREATE TABLE IF NOT EXISTS repository_health_findings (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      recommendation TEXT,
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_findings_repository ON repository_health_findings(repository_id);
    CREATE INDEX IF NOT EXISTS idx_findings_severity ON repository_health_findings(severity);

    CREATE TABLE IF NOT EXISTS agents_md_files (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      path TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      applies_to_path TEXT NOT NULL DEFAULT '/',
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      content TEXT,
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agentsmd_repository ON agents_md_files(repository_id);

    CREATE TABLE IF NOT EXISTS agents_md_issues (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      recommendation TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (file_id) REFERENCES agents_md_files(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agentsmd_issues_file ON agents_md_issues(file_id);

    CREATE TABLE IF NOT EXISTS task_repository_snapshots (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      task_id TEXT,
      snapshot_type TEXT NOT NULL,
      head_commit TEXT,
      branch TEXT,
      is_clean INTEGER NOT NULL DEFAULT 1,
      staged_files INTEGER NOT NULL DEFAULT 0,
      modified_files INTEGER NOT NULL DEFAULT 0,
      untracked_files INTEGER NOT NULL DEFAULT 0,
      diff_summary TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_repository ON task_repository_snapshots(repository_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_task ON task_repository_snapshots(task_id);
  `);

  const fileChangeColumns: ColumnSpec[] = [
    { name: 'repository_id', definition: "TEXT" },
    { name: 'additions', definition: "INTEGER" },
    { name: 'deletions', definition: "INTEGER" },
    { name: 'diff_truncated', definition: "INTEGER NOT NULL DEFAULT 0" },
  ];
  addMissingColumns(db, 'file_changes', fileChangeColumns);
}

function createPhase52Tables(db: BetterSqlite3Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'viewer')),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
  `);
}

function createPhase55Tables(db: BetterSqlite3Database) {
  const taskOwnerColumns: ColumnSpec[] = [
    { name: 'created_by', definition: 'TEXT' },
    { name: 'owner_user_id', definition: 'TEXT' },
    { name: 'updated_by', definition: 'TEXT' },
  ];
  addMissingColumns(db, 'tasks', taskOwnerColumns);

  const repoColumns: ColumnSpec[] = [
    { name: 'added_by', definition: 'TEXT' },
  ];
  addMissingColumns(db, 'repositories', repoColumns);

  const approvalColumns55: ColumnSpec[] = [
    { name: 'requested_by', definition: 'TEXT' },
  ];
  addMissingColumns(db, 'approvals', approvalColumns55);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by);
    CREATE INDEX IF NOT EXISTS idx_tasks_owner_user_id ON tasks(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_repositories_added_by ON repositories(added_by);
    CREATE INDEX IF NOT EXISTS idx_approvals_requested_by ON approvals(requested_by);
  `);
}

function createMessageTables(db: BetterSqlite3Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('task_delegation', 'status_update', 'knowledge_share', 'alert')),
      payload TEXT NOT NULL DEFAULT '{}',
      priority TEXT NOT NULL DEFAULT 'low' CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (from_agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (to_agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_from_agent_id ON messages(from_agent_id);
    CREATE INDEX IF NOT EXISTS idx_messages_to_agent_id ON messages(to_agent_id);
    CREATE INDEX IF NOT EXISTS idx_messages_read_at ON messages(read_at);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  `);
}

// Nested swarm spawning (P1): worker_leases gain a parent/tree/depth lineage so a
// spawned child lease can itself spawn children. Additive — the role CHECK stays;
// nested leases reuse the existing WorkerRole (a spawned maker is still a `maker`).
const nestedWorkerLeaseColumns: ColumnSpec[] = [
  { name: 'parent_lease_id', definition: 'TEXT' },          // FK self-ref worker_leases(id); null for roots
  { name: 'spawn_tree_id', definition: 'TEXT' },           // shared by every lease in one spawn tree (== root id)
  { name: 'depth', definition: 'INTEGER NOT NULL DEFAULT 0 CHECK(depth >= 0)' },
  { name: 'spawned_by_agent_id', definition: 'TEXT' },     // audit: which sub-agent process requested the spawn
];

function createNestedSpawnTables(db: BetterSqlite3Database) {
  // Additive lineage columns on the existing worker_leases table.
  addMissingColumns(db, 'worker_leases', nestedWorkerLeaseColumns);

  db.exec(`
    -- Audit + budget ledger for nested spawns. Normalized out of lease metadata so
    -- it is queryable and so the cycle guard (prompt_digest + ancestry) is durable.
    CREATE TABLE IF NOT EXISTS sub_agent_spawns (
      id TEXT PRIMARY KEY,
      spawn_tree_id TEXT NOT NULL,
      parent_lease_id TEXT,                  -- nullable: the root has no parent
      child_lease_id TEXT,                   -- nullable: a gated_out spawn created no child lease
      requested_by_lease_id TEXT NOT NULL,  -- the lease whose runtime asked to spawn
      depth INTEGER NOT NULL CHECK(depth >= 0),
      runtime TEXT NOT NULL,
      requested_role TEXT NOT NULL,
      prompt_digest TEXT NOT NULL,          -- sha256(role|prompt|capability_ids) — dedup + cycle guard
      status TEXT NOT NULL CHECK(status IN ('requested', 'gated_out', 'prepared', 'running', 'completed', 'failed', 'cancelled')),
      reject_reason TEXT,                   -- 'depth_budget_exceeded' | 'cycle_detected' | 'capability_not_live' | 'token_budget_exceeded' | 'wall_budget_exceeded' | 'concurrency_exceeded'
      token_budget_grant INTEGER,
      wall_budget_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (parent_lease_id) REFERENCES worker_leases(id) ON DELETE CASCADE,
      FOREIGN KEY (child_lease_id) REFERENCES worker_leases(id) ON DELETE CASCADE,
      FOREIGN KEY (requested_by_lease_id) REFERENCES worker_leases(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sub_agent_spawns_tree ON sub_agent_spawns(spawn_tree_id);
    CREATE INDEX IF NOT EXISTS idx_sub_agent_spawns_parent ON sub_agent_spawns(parent_lease_id);
    CREATE INDEX IF NOT EXISTS idx_sub_agent_spawns_status ON sub_agent_spawns(status);

    -- Cumulative per-tree budget. The root lease id == spawn_trees.id. Operator-
    -- armed (SPAWN_DEPTH_BUDGET env, default 0 = nested spawning off, default-deny).
    CREATE TABLE IF NOT EXISTS spawn_trees (
      id TEXT PRIMARY KEY,                  -- == root lease id
      depth_budget INTEGER NOT NULL,        -- operator cap; default SPAWN_DEPTH_BUDGET env (0 = off)
      total_token_budget INTEGER NOT NULL,
      consumed_tokens INTEGER NOT NULL DEFAULT 0,
      total_wall_budget_ms INTEGER NOT NULL,
      consumed_wall_ms INTEGER NOT NULL DEFAULT 0,
      max_concurrent_children INTEGER NOT NULL,  -- per-tree in-flight cap (default min(recommended_concurrency, 4))
      risk_class TEXT NOT NULL CHECK(risk_class IN ('low', 'medium', 'high', 'critical')),
      status TEXT NOT NULL DEFAULT 'open',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_spawn_trees_status ON spawn_trees(status);
  `);
}

// Added in telegram-swarm: extend agents with machine/telegram/okf fields
const agentColumnsTelegramSwarm: ColumnSpec[] = [
  { name: 'telegram_bot_id', definition: 'TEXT' },
  { name: 'telegram_bot_name', definition: 'TEXT' },
  { name: 'machine_ip', definition: 'TEXT' },
  { name: 'agent_type', definition: 'TEXT' }, // 'hermes' | 'openclaw' | 'deerflow'
  { name: 'host_machine_id', definition: 'TEXT' },
  { name: 'okf_concept_path', definition: 'TEXT' },
  { name: 'last_heartbeat_at', definition: 'TEXT' },
];

function createAgenticLoopTables(db: BetterSqlite3Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      objective TEXT NOT NULL,
      constraints_json TEXT NOT NULL DEFAULT '[]',
      acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
      risk_class TEXT NOT NULL CHECK(risk_class IN ('low', 'medium', 'high', 'critical')),
      budget_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK(status IN ('created', 'decomposed', 'running', 'blocked', 'completed', 'failed', 'cancelled')),
      owner_user_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
    CREATE INDEX IF NOT EXISTS idx_goals_owner_user_id ON goals(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_goals_created_at ON goals(created_at);

    CREATE TABLE IF NOT EXISTS loop_runs (
      id TEXT PRIMARY KEY,
      goal_id TEXT,
      loop_name TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('closed', 'open')),
      status TEXT NOT NULL CHECK(status IN (${LOOP_RUN_STATUSES})),
      repository_path TEXT,
      state_file TEXT,
      findings_json TEXT NOT NULL DEFAULT '[]',
      plan_json TEXT NOT NULL DEFAULT '{}',
      gates_json TEXT NOT NULL DEFAULT '[]',
      next_actions_json TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_loop_runs_goal_id ON loop_runs(goal_id);
    CREATE INDEX IF NOT EXISTS idx_loop_runs_loop_name ON loop_runs(loop_name);
    CREATE INDEX IF NOT EXISTS idx_loop_runs_status ON loop_runs(status);
    CREATE INDEX IF NOT EXISTS idx_loop_runs_created_at ON loop_runs(created_at);

    CREATE TABLE IF NOT EXISTS loop_events (
      id TEXT PRIMARY KEY,
      loop_run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      level TEXT NOT NULL CHECK(level IN ('debug', 'info', 'warning', 'error', 'critical')),
      message TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (loop_run_id) REFERENCES loop_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_loop_events_loop_run_id ON loop_events(loop_run_id);
    CREATE INDEX IF NOT EXISTS idx_loop_events_event_type ON loop_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_loop_events_created_at ON loop_events(created_at);

    CREATE TABLE IF NOT EXISTS worker_leases (
      id TEXT PRIMARY KEY,
      loop_run_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('planner', 'maker', 'checker', 'security_checker', 'memory_curator', 'governance_guard')),
      runtime TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('prepared', 'running', 'completed', 'failed', 'cancelled')),
      finding_id TEXT,
      worktree_path TEXT,
      branch_name TEXT,
      budget_json TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (loop_run_id) REFERENCES loop_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_worker_leases_loop_run_id ON worker_leases(loop_run_id);
    CREATE INDEX IF NOT EXISTS idx_worker_leases_role ON worker_leases(role);
    CREATE INDEX IF NOT EXISTS idx_worker_leases_status ON worker_leases(status);

    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT,
      risk_class TEXT NOT NULL CHECK(risk_class IN ('low', 'medium', 'high', 'critical')),
      value_score INTEGER NOT NULL DEFAULT 50 CHECK(value_score >= 0 AND value_score <= 100),
      confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence >= 0 AND confidence <= 1),
      status TEXT NOT NULL CHECK(status IN ('candidate', 'triaged', 'planned', 'leased', 'blocked', 'done', 'discarded')),
      recommended_loop TEXT,
      assigned_agent_id TEXT,
      assigned_runtime TEXT,
      parent_goal_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL,
      FOREIGN KEY (parent_goal_id) REFERENCES goals(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
    CREATE INDEX IF NOT EXISTS idx_work_items_source_ref ON work_items(source, source_ref);
    CREATE INDEX IF NOT EXISTS idx_work_items_recommended_loop ON work_items(recommended_loop);
    CREATE INDEX IF NOT EXISTS idx_work_items_created_at ON work_items(created_at);

    CREATE TABLE IF NOT EXISTS memory_candidates (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      memory_type TEXT NOT NULL CHECK(memory_type IN ('operational_memory', 'engineering_rule', 'policy_rule')),
      source_ref TEXT,
      status TEXT NOT NULL CHECK(status IN ('candidate', 'review_required', 'rejected', 'promoted')),
      promotion_status TEXT NOT NULL CHECK(promotion_status IN ('proposed', 'blocked_pending_review', 'blocked_pending_human', 'rejected', 'promoted')),
      human_required INTEGER NOT NULL DEFAULT 0,
      sensitivity TEXT NOT NULL CHECK(sensitivity IN ('normal', 'security_sensitive', 'secret_detected')),
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_memory_candidates_status ON memory_candidates(status);
    CREATE INDEX IF NOT EXISTS idx_memory_candidates_source_ref ON memory_candidates(source_ref);
    CREATE INDEX IF NOT EXISTS idx_memory_candidates_created_at ON memory_candidates(created_at);

    CREATE TABLE IF NOT EXISTS specialist_panels (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      question TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('planned', 'reviewing', 'consensus_ready', 'backlog_created', 'goal_created', 'cancelled')),
      risk_class TEXT NOT NULL CHECK(risk_class IN ('low', 'medium', 'high', 'critical')),
      panel_json TEXT NOT NULL DEFAULT '[]',
      context_json TEXT NOT NULL DEFAULT '{}',
      consensus_json TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_specialist_panels_status ON specialist_panels(status);
    CREATE INDEX IF NOT EXISTS idx_specialist_panels_risk_class ON specialist_panels(risk_class);
    CREATE INDEX IF NOT EXISTS idx_specialist_panels_created_at ON specialist_panels(created_at);

    CREATE TABLE IF NOT EXISTS specialist_reviews (
      id TEXT PRIMARY KEY,
      panel_id TEXT NOT NULL,
      specialist_id TEXT NOT NULL,
      specialist_title TEXT NOT NULL,
      stance TEXT NOT NULL CHECK(stance IN ('support', 'oppose', 'uncertain', 'needs_evidence')),
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      findings_json TEXT NOT NULL DEFAULT '[]',
      recommendations_json TEXT NOT NULL DEFAULT '[]',
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      limitations TEXT,
      status TEXT NOT NULL CHECK(status IN ('draft', 'submitted', 'rejected')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (panel_id) REFERENCES specialist_panels(id) ON DELETE CASCADE,
      UNIQUE(panel_id, specialist_id)
    );

    CREATE INDEX IF NOT EXISTS idx_specialist_reviews_panel_id ON specialist_reviews(panel_id);
    CREATE INDEX IF NOT EXISTS idx_specialist_reviews_specialist_id ON specialist_reviews(specialist_id);
    CREATE INDEX IF NOT EXISTS idx_specialist_reviews_stance ON specialist_reviews(stance);

    CREATE TABLE IF NOT EXISTS agent_trace_spans (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      parent_span_id TEXT,
      loop_run_id TEXT,
      work_item_id TEXT,
      span_type TEXT NOT NULL CHECK(span_type IN ('goal', 'loop', 'worker', 'tool', 'memory', 'eval', 'capability', 'checkpoint', 'reflection')),
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ok', 'error', 'running', 'skipped', 'blocked')),
      evidence_ref TEXT,
      started_at TEXT,
      ended_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (parent_span_id) REFERENCES agent_trace_spans(id) ON DELETE SET NULL,
      FOREIGN KEY (loop_run_id) REFERENCES loop_runs(id) ON DELETE SET NULL,
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_trace_id ON agent_trace_spans(trace_id);
    CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_parent_span_id ON agent_trace_spans(parent_span_id);
    CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_loop_run_id ON agent_trace_spans(loop_run_id);
    CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_span_type ON agent_trace_spans(span_type);
    CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_status ON agent_trace_spans(status);
    CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_created_at ON agent_trace_spans(created_at);

    CREATE TABLE IF NOT EXISTS loop_checkpoints (
      id TEXT PRIMARY KEY,
      loop_run_id TEXT NOT NULL,
      label TEXT NOT NULL,
      state_json TEXT NOT NULL,
      gates_json TEXT NOT NULL DEFAULT '[]',
      findings_json TEXT NOT NULL DEFAULT '[]',
      leases_json TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (loop_run_id) REFERENCES loop_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_loop_checkpoints_loop_run_id ON loop_checkpoints(loop_run_id);
    CREATE INDEX IF NOT EXISTS idx_loop_checkpoints_created_at ON loop_checkpoints(created_at);

    CREATE TABLE IF NOT EXISTS agent_eval_runs (
      id TEXT PRIMARY KEY,
      suite_name TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK(target_type IN ('memory', 'skill', 'swarm', 'loop', 'capability')),
      target_ref TEXT,
      status TEXT NOT NULL CHECK(status IN ('passed', 'failed', 'needs_review')),
      score REAL NOT NULL CHECK(score >= 0 AND score <= 1),
      scorecard_json TEXT NOT NULL DEFAULT '{}',
      findings_json TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_agent_eval_runs_suite_name ON agent_eval_runs(suite_name);
    CREATE INDEX IF NOT EXISTS idx_agent_eval_runs_target_type ON agent_eval_runs(target_type);
    CREATE INDEX IF NOT EXISTS idx_agent_eval_runs_status ON agent_eval_runs(status);
    CREATE INDEX IF NOT EXISTS idx_agent_eval_runs_created_at ON agent_eval_runs(created_at);

    CREATE TABLE IF NOT EXISTS capability_tokens (
      id TEXT PRIMARY KEY,
      token_ref TEXT NOT NULL UNIQUE,
      subject_agent_id TEXT,
      scopes_json TEXT NOT NULL DEFAULT '[]',
      allowed_actions_json TEXT NOT NULL DEFAULT '[]',
      denied_actions_json TEXT NOT NULL DEFAULT '[]',
      risk_class TEXT NOT NULL CHECK(risk_class IN ('low', 'medium', 'high', 'critical')),
      status TEXT NOT NULL CHECK(status IN ('active', 'pending_approval', 'revoked', 'expired')),
      approved_by TEXT,
      expires_at TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_capability_tokens_subject_agent_id ON capability_tokens(subject_agent_id);
    CREATE INDEX IF NOT EXISTS idx_capability_tokens_status ON capability_tokens(status);
    CREATE INDEX IF NOT EXISTS idx_capability_tokens_risk_class ON capability_tokens(risk_class);
    CREATE INDEX IF NOT EXISTS idx_capability_tokens_expires_at ON capability_tokens(expires_at);

    CREATE TABLE IF NOT EXISTS reflection_candidates (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL CHECK(source_type IN ('trace', 'eval', 'loop', 'memory', 'skill', 'panel')),
      source_ref TEXT NOT NULL,
      lesson TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('candidate', 'review_required', 'rejected', 'promoted')),
      sensitivity TEXT NOT NULL CHECK(sensitivity IN ('normal', 'security_sensitive')),
      human_required INTEGER NOT NULL DEFAULT 0,
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_reflection_candidates_source ON reflection_candidates(source_type, source_ref);
    CREATE INDEX IF NOT EXISTS idx_reflection_candidates_status ON reflection_candidates(status);
    CREATE INDEX IF NOT EXISTS idx_reflection_candidates_sensitivity ON reflection_candidates(sensitivity);
    CREATE INDEX IF NOT EXISTS idx_reflection_candidates_created_at ON reflection_candidates(created_at);
  `);
}

function createSwarmIntelligenceTables(db: BetterSqlite3Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS swarm_capabilities (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('skill', 'specialist_agent', 'runtime_adapter', 'deterministic_harness', 'memory_source', 'dashboard_action')),
      owner TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft', 'candidate', 'validated', 'deprecated', 'disabled')),
      risk_ceiling TEXT NOT NULL CHECK(risk_ceiling IN ('low', 'medium', 'high', 'critical')),
      input_schema_ref TEXT NOT NULL,
      output_schema_ref TEXT NOT NULL,
      allowed_actions_json TEXT NOT NULL DEFAULT '[]',
      forbidden_actions_json TEXT NOT NULL DEFAULT '[]',
      required_evidence_json TEXT NOT NULL DEFAULT '[]',
      eval_score REAL NOT NULL DEFAULT 0 CHECK(eval_score >= 0 AND eval_score <= 1),
      eval_threshold REAL NOT NULL DEFAULT 0.75 CHECK(eval_threshold >= 0 AND eval_threshold <= 1),
      cost_model_json TEXT NOT NULL DEFAULT '{}',
      removal_strategy TEXT NOT NULL,
      latest_validation_report TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_swarm_capabilities_kind ON swarm_capabilities(kind);
    CREATE INDEX IF NOT EXISTS idx_swarm_capabilities_status ON swarm_capabilities(status);
    CREATE INDEX IF NOT EXISTS idx_swarm_capabilities_risk ON swarm_capabilities(risk_ceiling);

    CREATE TABLE IF NOT EXISTS swarm_claims (
      id TEXT PRIMARY KEY,
      claim TEXT NOT NULL,
      claim_type TEXT NOT NULL CHECK(claim_type IN ('observation', 'hypothesis', 'decision', 'memory', 'capability', 'backlog', 'policy')),
      subject_ref TEXT NOT NULL,
      predicate TEXT,
      object TEXT,
      scope TEXT,
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0 CHECK(confidence >= 0 AND confidence <= 1),
      valid_until TEXT,
      status TEXT NOT NULL CHECK(status IN ('proposed', 'supported', 'contradicted', 'resolved', 'rejected', 'promoted', 'review_required')),
      supports_ref TEXT,
      contradicts_ref TEXT,
      verified_by_gate TEXT,
      invalidated_by TEXT,
      created_from TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (invalidated_by) REFERENCES swarm_claims(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_swarm_claims_subject_ref ON swarm_claims(subject_ref);
    CREATE INDEX IF NOT EXISTS idx_swarm_claims_status ON swarm_claims(status);
    CREATE INDEX IF NOT EXISTS idx_swarm_claims_claim_type ON swarm_claims(claim_type);
    CREATE INDEX IF NOT EXISTS idx_swarm_claims_scope ON swarm_claims(scope);
    CREATE INDEX IF NOT EXISTS idx_swarm_claims_predicate ON swarm_claims(predicate);
    CREATE INDEX IF NOT EXISTS idx_swarm_claims_object ON swarm_claims(object);

    CREATE TABLE IF NOT EXISTS swarm_evidence_edges (
      id TEXT PRIMARY KEY,
      from_ref TEXT NOT NULL,
      to_ref TEXT NOT NULL,
      relation TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_swarm_evidence_edges_from ON swarm_evidence_edges(from_ref);
    CREATE INDEX IF NOT EXISTS idx_swarm_evidence_edges_to ON swarm_evidence_edges(to_ref);

    CREATE TABLE IF NOT EXISTS swarm_runner_manifests (
      id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL UNIQUE,
      lease_id TEXT,
      loop_run_id TEXT,
      action TEXT NOT NULL CHECK(action IN ('plan', 'start', 'skip', 'fail', 'stop', 'kill', 'complete')),
      policy_version TEXT NOT NULL,
      runtime_contract_json TEXT NOT NULL DEFAULT '{}',
      capacity_snapshot_json TEXT NOT NULL DEFAULT '{}',
      budget_snapshot_json TEXT NOT NULL DEFAULT '{}',
      gate_refs_json TEXT NOT NULL DEFAULT '[]',
      blocked_reasons_json TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_swarm_runner_manifests_lease ON swarm_runner_manifests(lease_id);
    CREATE INDEX IF NOT EXISTS idx_swarm_runner_manifests_loop ON swarm_runner_manifests(loop_run_id);
    CREATE INDEX IF NOT EXISTS idx_swarm_runner_manifests_action ON swarm_runner_manifests(action);

    -- G14.1: Swarm Intelligence Kernel — mission/task/decision state machine
    CREATE TABLE IF NOT EXISTS swarm_missions (
      id TEXT PRIMARY KEY,
      goal_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      risk_class TEXT NOT NULL CHECK(risk_class IN ('low', 'medium', 'high', 'critical')),
      status TEXT NOT NULL CHECK(status IN ('observed', 'hypothesized', 'planned', 'queued', 'prepared', 'running', 'checking', 'ready_for_human_merge', 'completed', 'blocked', 'rejected', 'escalated')),
      panel_id TEXT,
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_swarm_missions_status ON swarm_missions(status);
    CREATE INDEX IF NOT EXISTS idx_swarm_missions_goal_id ON swarm_missions(goal_id);
    CREATE INDEX IF NOT EXISTS idx_swarm_missions_risk_class ON swarm_missions(risk_class);

    CREATE TABLE IF NOT EXISTS swarm_tasks (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('observed', 'hypothesized', 'planned', 'queued', 'prepared', 'running', 'checking', 'ready_for_human_merge', 'completed', 'blocked', 'rejected', 'escalated')),
      assigned_lease_id TEXT,
      capability_id TEXT,
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (mission_id) REFERENCES swarm_missions(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_lease_id) REFERENCES worker_leases(id) ON DELETE SET NULL,
      FOREIGN KEY (capability_id) REFERENCES swarm_capabilities(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_swarm_tasks_mission_id ON swarm_tasks(mission_id);
    CREATE INDEX IF NOT EXISTS idx_swarm_tasks_status ON swarm_tasks(status);

    CREATE TABLE IF NOT EXISTS swarm_decisions (
      id TEXT PRIMARY KEY,
      mission_id TEXT,
      task_id TEXT,
      decision_type TEXT NOT NULL CHECK(decision_type IN ('state_transition', 'route', 'gate', 'quorum', 'split', 'kill', 'escalate', 'review')),
      decision TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT 'system',
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      gate_refs_json TEXT NOT NULL DEFAULT '[]',
      blocked_reasons_json TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (mission_id) REFERENCES swarm_missions(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES swarm_tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_swarm_decisions_mission_id ON swarm_decisions(mission_id);
    CREATE INDEX IF NOT EXISTS idx_swarm_decisions_task_id ON swarm_decisions(task_id);
    CREATE INDEX IF NOT EXISTS idx_swarm_decisions_type ON swarm_decisions(decision_type);
  `);
}

function createRuntimeContractProbeTables(db: BetterSqlite3Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_contract_probes (
      runtime TEXT PRIMARY KEY,
      command TEXT,
      status TEXT NOT NULL,
      available INTEGER NOT NULL DEFAULT 0,
      contract_json TEXT NOT NULL DEFAULT '{}',
      probed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function ensureLoopRunsReadyStatus(db: BetterSqlite3Database) {
  const sql = tableSql(db, 'loop_runs');
  if (!sql || sql.includes('ready_for_human_merge')) {
    return;
  }
  rebuildLoopTables(db);
}

// Add the 'interrupted' loop-run status (set by recoverInterruptedRuns on restart)
// to the CHECK constraint on existing databases. Fresh databases already get it
// via LOOP_RUN_STATUSES in createAgenticLoopTables.
function ensureLoopRunsInterruptedStatus(db: BetterSqlite3Database) {
  const sql = tableSql(db, 'loop_runs');
  if (!sql || sql.includes("'interrupted'")) {
    return;
  }
  rebuildLoopTables(db);
}

function rebuildLoopTables(db: BetterSqlite3Database) {
  const loopRuns = db.prepare('SELECT * FROM loop_runs').all() as Array<Record<string, unknown>>;
  const loopEvents = tableSql(db, 'loop_events') ? db.prepare('SELECT * FROM loop_events').all() as Array<Record<string, unknown>> : [];
  const workerLeases = tableSql(db, 'worker_leases') ? db.prepare('SELECT * FROM worker_leases').all() as Array<Record<string, unknown>> : [];
  const traceSpans = tableSql(db, 'agent_trace_spans') ? db.prepare('SELECT * FROM agent_trace_spans').all() as Array<Record<string, unknown>> : [];
  const checkpoints = tableSql(db, 'loop_checkpoints') ? db.prepare('SELECT * FROM loop_checkpoints').all() as Array<Record<string, unknown>> : [];

  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      DROP TABLE IF EXISTS loop_checkpoints;
      DROP TABLE IF EXISTS agent_trace_spans;
      DROP TABLE IF EXISTS worker_leases;
      DROP TABLE IF EXISTS loop_events;
      DROP TABLE IF EXISTS loop_runs;

      CREATE TABLE loop_runs (
        id TEXT PRIMARY KEY,
        goal_id TEXT,
        loop_name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('closed', 'open')),
        status TEXT NOT NULL CHECK(status IN (${LOOP_RUN_STATUSES})),
        repository_path TEXT,
        state_file TEXT,
        findings_json TEXT NOT NULL DEFAULT '[]',
        plan_json TEXT NOT NULL DEFAULT '{}',
        gates_json TEXT NOT NULL DEFAULT '[]',
        next_actions_json TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_loop_runs_goal_id ON loop_runs(goal_id);
      CREATE INDEX IF NOT EXISTS idx_loop_runs_loop_name ON loop_runs(loop_name);
      CREATE INDEX IF NOT EXISTS idx_loop_runs_status ON loop_runs(status);
      CREATE INDEX IF NOT EXISTS idx_loop_runs_created_at ON loop_runs(created_at);

      CREATE TABLE loop_events (
        id TEXT PRIMARY KEY,
        loop_run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        level TEXT NOT NULL CHECK(level IN ('debug', 'info', 'warning', 'error', 'critical')),
        message TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (loop_run_id) REFERENCES loop_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_loop_events_loop_run_id ON loop_events(loop_run_id);
      CREATE INDEX IF NOT EXISTS idx_loop_events_event_type ON loop_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_loop_events_created_at ON loop_events(created_at);

      CREATE TABLE worker_leases (
        id TEXT PRIMARY KEY,
        loop_run_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('planner', 'maker', 'checker', 'security_checker', 'memory_curator', 'governance_guard')),
        runtime TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('prepared', 'running', 'completed', 'failed', 'cancelled')),
        finding_id TEXT,
        worktree_path TEXT,
        branch_name TEXT,
        budget_json TEXT NOT NULL DEFAULT '{}',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        FOREIGN KEY (loop_run_id) REFERENCES loop_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_worker_leases_loop_run_id ON worker_leases(loop_run_id);
      CREATE INDEX IF NOT EXISTS idx_worker_leases_status ON worker_leases(status);
      CREATE INDEX IF NOT EXISTS idx_worker_leases_role ON worker_leases(role);

      CREATE TABLE agent_trace_spans (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        parent_span_id TEXT,
        loop_run_id TEXT,
        work_item_id TEXT,
        span_type TEXT NOT NULL CHECK(span_type IN ('goal', 'loop', 'worker', 'tool', 'memory', 'eval', 'capability', 'checkpoint', 'reflection')),
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ok', 'error', 'running', 'skipped', 'blocked')),
        evidence_ref TEXT,
        started_at TEXT,
        ended_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (parent_span_id) REFERENCES agent_trace_spans(id) ON DELETE SET NULL,
        FOREIGN KEY (loop_run_id) REFERENCES loop_runs(id) ON DELETE SET NULL,
        FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_trace_id ON agent_trace_spans(trace_id);
      CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_parent_span_id ON agent_trace_spans(parent_span_id);
      CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_loop_run_id ON agent_trace_spans(loop_run_id);
      CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_span_type ON agent_trace_spans(span_type);
      CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_status ON agent_trace_spans(status);
      CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_created_at ON agent_trace_spans(created_at);

      CREATE TABLE loop_checkpoints (
        id TEXT PRIMARY KEY,
        loop_run_id TEXT NOT NULL,
        label TEXT NOT NULL,
        state_json TEXT NOT NULL,
        gates_json TEXT NOT NULL DEFAULT '[]',
        findings_json TEXT NOT NULL DEFAULT '[]',
        leases_json TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (loop_run_id) REFERENCES loop_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_loop_checkpoints_loop_run_id ON loop_checkpoints(loop_run_id);
      CREATE INDEX IF NOT EXISTS idx_loop_checkpoints_created_at ON loop_checkpoints(created_at);
    `);

    // The recreated worker_leases uses the base schema; re-add the nested
    // spawn lineage columns (parent_lease_id, spawn_tree_id, depth,
    // spawned_by_agent_id) that createNestedSpawnTables added, otherwise
    // re-inserting leases that carry those columns fails on stale DBs.
    addMissingColumns(db, 'worker_leases', nestedWorkerLeaseColumns);
    insertRows(db, 'loop_runs', loopRuns);
    insertRows(db, 'loop_events', loopEvents);
    insertRows(db, 'worker_leases', workerLeases);
    insertRows(db, 'agent_trace_spans', traceSpans);
    insertRows(db, 'loop_checkpoints', checkpoints);
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

// Columns added to token_usage_log by the newer schema. On stale dev databases
// the table predates these columns, and CREATE INDEX statements in schema.ts
// (idx_token_usage_log_discussion_id, idx_token_usage_log_created_at) reference
// them — so they must exist BEFORE db.exec(schema) runs, otherwise server start
// fails with "no such column: discussion_id". Idempotent: only adds missing cols.
const tokenUsageLogColumns: ColumnSpec[] = [
  { name: 'discussion_id', definition: 'TEXT' },
  { name: 'task_type', definition: 'TEXT' },
  { name: 'total_tokens', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'cost_estimate', definition: 'REAL' },
  { name: 'metadata', definition: 'TEXT' },
  { name: 'created_at', definition: "TEXT NOT NULL DEFAULT (datetime('now'))" },
  { name: 'updated_at', definition: "TEXT NOT NULL DEFAULT (datetime('now'))" },
];

// Migrations that MUST run before the schema string is exec'd, because the
// schema contains CREATE INDEX statements referencing columns that may be
// absent on pre-existing (stale) tables (CREATE TABLE IF NOT EXISTS does not
// add columns to an existing table).
export function runPreSchemaMigrations(db: BetterSqlite3Database) {
  addMissingColumns(db, 'token_usage_log', tokenUsageLogColumns);
}

export function runMigrations(db: BetterSqlite3Database) {
  addMissingColumns(db, 'approvals', approvalColumns);
  addMissingColumns(db, 'approval_policies', approvalPolicyColumns);
  createPhase42Tables(db);
  seedDefaultPolicies(db);
  createPhase43Tables(db);
  createPhase44Tables(db);
  createPhase52Tables(db);
  createPhase55Tables(db);
  createPhase56Tables(db);
  createMessageTables(db);
  seedMCPServers(db);
  // Ensure agents table has telegram/machine/okf columns
  addMissingColumns(db, 'agents', agentColumnsTelegramSwarm);
  createAgenticLoopTables(db);
  createSwarmIntelligenceTables(db);
  createNestedSpawnTables(db);
  createRuntimeContractProbeTables(db);
  addMissingColumns(db, 'swarm_claims', swarmClaimColumns);
  ensureLoopRunsReadyStatus(db);
  ensureLoopRunsInterruptedStatus(db);
}

if (require.main === module) {
  const dbPath = process.env.DB_PATH || join(process.cwd(), '../../.data/djimitflo.sqlite');
  const db = new BetterSqlite3(dbPath);
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.close();
}
