/**
 * Lightweight SQLite migrations for schema evolution.
 */

import BetterSqlite3 from 'better-sqlite3';
import { join } from 'path';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';

type ColumnSpec = {
  name: string;
  definition: string;
};

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

export function runMigrations(db: BetterSqlite3Database) {
  addMissingColumns(db, 'approvals', approvalColumns);
  addMissingColumns(db, 'approval_policies', approvalPolicyColumns);
  createPhase42Tables(db);
  seedDefaultPolicies(db);
  createPhase43Tables(db);
  createPhase44Tables(db);
  createPhase52Tables(db);
  createPhase55Tables(db);
}

if (require.main === module) {
  const dbPath = process.env.DB_PATH || join(process.cwd(), '../../.data/djimitflo.sqlite');
  const db = new BetterSqlite3(dbPath);
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.close();
}
