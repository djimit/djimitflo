/**
 * SQLite database schema for Djimitflo
 */

export const schema = `
-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'queued', 'running', 'paused', 'awaiting_approval', 'completed', 'failed', 'cancelled')),
  priority TEXT NOT NULL CHECK(priority IN ('low', 'medium', 'high', 'critical')),
  risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'critical')),
  execution_mode TEXT NOT NULL CHECK(execution_mode IN ('local', 'dry_run', 'review_only', 'cloud_planned')),
  agent_id TEXT,
  parent_task_id TEXT,
  repository_id TEXT,
  instruction_profile_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  execution_time_ms INTEGER,
  token_usage INTEGER,
  tags TEXT, -- JSON array
  metadata TEXT, -- JSON object
  session_id TEXT, -- OpenCode session ID for continuity
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE SET NULL,
  FOREIGN KEY (instruction_profile_id) REFERENCES instruction_profiles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_id ON tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('idle', 'active', 'paused', 'error', 'offline')),
  capabilities TEXT NOT NULL, -- JSON array
  instruction_profile_id TEXT,
  model TEXT,
  temperature REAL,
  max_tokens INTEGER,
  total_tasks INTEGER NOT NULL DEFAULT 0,
  completed_tasks INTEGER NOT NULL DEFAULT 0,
  failed_tasks INTEGER NOT NULL DEFAULT 0,
  total_execution_time_ms INTEGER NOT NULL DEFAULT 0,
  total_token_usage INTEGER NOT NULL DEFAULT 0,
  current_task_id TEXT,
  last_active_at TEXT,
  metadata TEXT, -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (instruction_profile_id) REFERENCES instruction_profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (current_task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);

-- Execution events table
CREATE TABLE IF NOT EXISTS execution_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  message TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('debug', 'info', 'warning', 'error', 'critical')),
  tool_name TEXT,
  tool_input TEXT, -- JSON object
  tool_output TEXT, -- JSON (any type)
  tool_error TEXT,
  approval_id TEXT,
  artifact_id TEXT,
  metadata TEXT, -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (approval_id) REFERENCES approvals(id) ON DELETE SET NULL,
  FOREIGN KEY (artifact_id) REFERENCES task_artifacts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_execution_events_task_id ON execution_events(task_id);
CREATE INDEX IF NOT EXISTS idx_execution_events_timestamp ON execution_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_execution_events_event_type ON execution_events(event_type);

-- Task artifacts table
CREATE TABLE IF NOT EXISTS task_artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('file', 'diff', 'log', 'screenshot', 'output', 'error')),
  path TEXT NOT NULL,
  content TEXT,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  metadata TEXT, -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_artifacts_task_id ON task_artifacts(task_id);
CREATE INDEX IF NOT EXISTS idx_task_artifacts_type ON task_artifacts(type);

-- MCP servers table
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'stopped', 'error', 'unknown')),
  command TEXT NOT NULL,
  args TEXT NOT NULL, -- JSON array
  env TEXT NOT NULL, -- JSON object
  version TEXT,
  author TEXT,
  url TEXT,
  last_ping_at TEXT,
  error_message TEXT,
  metadata TEXT, -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_status ON mcp_servers(status);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers(name);

-- MCP tools table
CREATE TABLE IF NOT EXISTS mcp_tools (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('allowed', 'denied', 'requires_approval')),
  risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'critical')),
  input_schema TEXT NOT NULL, -- JSON object
  total_calls INTEGER NOT NULL DEFAULT 0,
  successful_calls INTEGER NOT NULL DEFAULT 0,
  failed_calls INTEGER NOT NULL DEFAULT 0,
  last_called_at TEXT,
  metadata TEXT, -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE,
  UNIQUE(server_id, name)
);

CREATE INDEX IF NOT EXISTS idx_mcp_tools_server_id ON mcp_tools(server_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tools_permission ON mcp_tools(permission);
CREATE INDEX IF NOT EXISTS idx_mcp_tools_risk_level ON mcp_tools(risk_level);

-- Sandbox policies table
CREATE TABLE IF NOT EXISTS sandbox_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  allow_filesystem_write INTEGER NOT NULL DEFAULT 0,
  allowed_paths TEXT NOT NULL, -- JSON array
  blocked_paths TEXT NOT NULL, -- JSON array
  allow_network INTEGER NOT NULL DEFAULT 0,
  allowed_domains TEXT NOT NULL, -- JSON array
  blocked_domains TEXT NOT NULL, -- JSON array
  allow_shell_commands INTEGER NOT NULL DEFAULT 0,
  allowed_commands TEXT NOT NULL, -- JSON array
  blocked_commands TEXT NOT NULL, -- JSON array
  allow_env_vars INTEGER NOT NULL DEFAULT 1,
  allowed_env_vars TEXT NOT NULL, -- JSON array
  blocked_env_vars TEXT NOT NULL, -- JSON array
  max_file_size_bytes INTEGER,
  max_execution_time_ms INTEGER,
  max_token_usage INTEGER,
  metadata TEXT, -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sandbox_policies_enabled ON sandbox_policies(enabled);
CREATE INDEX IF NOT EXISTS idx_sandbox_policies_priority ON sandbox_policies(priority DESC);

-- Approval policies table
CREATE TABLE IF NOT EXISTS approval_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  risk_levels TEXT NOT NULL, -- JSON array
  tool_patterns TEXT NOT NULL, -- JSON array (glob patterns)
  file_patterns TEXT NOT NULL, -- JSON array (glob patterns)
  requires_approval INTEGER NOT NULL DEFAULT 1,
  auto_approve INTEGER NOT NULL DEFAULT 0,
  approval_timeout_ms INTEGER,
  metadata TEXT, -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approval_policies_enabled ON approval_policies(enabled);
CREATE INDEX IF NOT EXISTS idx_approval_policies_priority ON approval_policies(priority DESC);

-- Approvals table
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  execution_event_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied', 'expired')),
  risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'critical')),
  request_type TEXT NOT NULL CHECK(request_type IN ('tool_call', 'file_write', 'shell_command', 'network_request', 'high_risk_action')),
  request_message TEXT NOT NULL,
  request_data TEXT NOT NULL, -- JSON object
  approved_by TEXT,
  approved_at TEXT,
  denied_at TEXT,
  denial_reason TEXT,
  expires_at TEXT,
  metadata TEXT, -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (execution_event_id) REFERENCES execution_events(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_approvals_task_id ON approvals(task_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_risk_level ON approvals(risk_level);

-- Instruction profiles table
CREATE TABLE IF NOT EXISTS instruction_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  agents_md_content TEXT NOT NULL,
  is_valid INTEGER NOT NULL DEFAULT 1,
  validation_errors TEXT NOT NULL, -- JSON array
  last_validated_at TEXT,
  active_tasks INTEGER NOT NULL DEFAULT 0,
  total_tasks INTEGER NOT NULL DEFAULT 0,
  metadata TEXT, -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_instruction_profiles_name ON instruction_profiles(name);
CREATE INDEX IF NOT EXISTS idx_instruction_profiles_is_valid ON instruction_profiles(is_valid);

-- Repositories table
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  path TEXT NOT NULL,
  git_remote TEXT,
  git_branch TEXT,
  git_commit TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  metadata TEXT, -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_repositories_name ON repositories(name);
CREATE INDEX IF NOT EXISTS idx_repositories_is_active ON repositories(is_active);

-- Audit events table
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
  risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'critical')),
  before TEXT, -- JSON object
  after TEXT, -- JSON object
  ip_address TEXT,
  user_agent TEXT,
  metadata TEXT, -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (execution_event_id) REFERENCES execution_events(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_events_event_type ON audit_events(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_events_user_id ON audit_events(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_agent_id ON audit_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_task_id ON audit_events(task_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_risk_level ON audit_events(risk_level);

-- Config table (key-value store for app configuration)
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL, -- JSON value
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
