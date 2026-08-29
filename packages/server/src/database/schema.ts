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

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('idle', 'active', 'paused', 'error', 'offline', 'pending_approval')),
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

-- Agent messages table
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
  version INTEGER NOT NULL DEFAULT 1,
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
  requested_by TEXT NOT NULL DEFAULT 'system',
  decided_by TEXT,
  decided_at TEXT,
  decision_reason TEXT,
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
  provider TEXT NOT NULL DEFAULT 'local' CHECK(provider IN ('local', 'github', 'gitlab')),
  status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('unknown', 'clean', 'dirty', 'syncing', 'error')),
  git_remote TEXT,
  git_branch TEXT,
  git_commit TEXT,
  detected_stacks TEXT NOT NULL DEFAULT '[]',
  package_manager TEXT NOT NULL DEFAULT 'unknown',
  test_commands TEXT NOT NULL DEFAULT '[]',
  build_commands TEXT NOT NULL DEFAULT '[]',
  lint_commands TEXT NOT NULL DEFAULT '[]',
  typecheck_commands TEXT NOT NULL DEFAULT '[]',
  has_git INTEGER NOT NULL DEFAULT 0,
  has_agents_md INTEGER NOT NULL DEFAULT 0,
  health_score INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
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

-- Discussions table (agent discussions)
CREATE TABLE IF NOT EXISTS discussions (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open', 'closed', 'archived')),
  agent_id TEXT,
  parent_discussion_id TEXT,
  metadata TEXT, -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
  FOREIGN KEY (parent_discussion_id) REFERENCES discussions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_discussions_status ON discussions(status);
CREATE INDEX IF NOT EXISTS idx_discussions_agent_id ON discussions(agent_id);
CREATE INDEX IF NOT EXISTS idx_discussions_parent_discussion_id ON discussions(parent_discussion_id);
CREATE INDEX IF NOT EXISTS idx_discussions_created_at ON discussions(created_at);

-- Discussion proposals table (agent proposals)
CREATE TABLE IF NOT EXISTS discussion_proposals (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('action', 'question', 'suggestion', 'decision')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  data TEXT, -- JSON object
  status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'rejected', 'implemented')),
  metadata TEXT, -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (discussion_id) REFERENCES discussions(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_discussion_proposals_discussion_id ON discussion_proposals(discussion_id);
CREATE INDEX IF NOT EXISTS idx_discussion_proposals_agent_id ON discussion_proposals(agent_id);
CREATE INDEX IF NOT EXISTS idx_discussion_proposals_status ON discussion_proposals(status);
CREATE INDEX IF NOT EXISTS idx_discussion_proposals_type ON discussion_proposals(type);

-- Discussion votes table (agent votes)
CREATE TABLE IF NOT EXISTS discussion_votes (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  vote TEXT NOT NULL CHECK(vote IN ('yes', 'no', 'abstain')),
  confidence INTEGER NOT NULL DEFAULT 50 CHECK(confidence >= 0 AND confidence <= 100),
  reasoning TEXT,
  metadata TEXT, -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (proposal_id) REFERENCES discussion_proposals(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  UNIQUE(proposal_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_discussion_votes_proposal_id ON discussion_votes(proposal_id);
CREATE INDEX IF NOT EXISTS idx_discussion_votes_agent_id ON discussion_votes(agent_id);
CREATE INDEX IF NOT EXISTS idx_discussion_votes_vote ON discussion_votes(vote);

-- Discussion turns table (ordered, multi-round turn protocol on top of discussions)
CREATE TABLE IF NOT EXISTS discussion_turns (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  parent_turn_id TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'committed', 'superseded')),
  metadata TEXT NOT NULL DEFAULT '{}', -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (discussion_id) REFERENCES discussions(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_turn_id) REFERENCES discussion_turns(id) ON DELETE SET NULL,
  UNIQUE(discussion_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_discussion_turns_discussion_id ON discussion_turns(discussion_id);
CREATE INDEX IF NOT EXISTS idx_discussion_turns_agent_id ON discussion_turns(agent_id);
CREATE INDEX IF NOT EXISTS idx_discussion_turns_parent_turn_id ON discussion_turns(parent_turn_id);
CREATE INDEX IF NOT EXISTS idx_discussion_turns_status ON discussion_turns(status);

-- Token usage log table
CREATE TABLE IF NOT EXISTS token_usage_log (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  discussion_id TEXT,
  agent_id TEXT,
  model TEXT,
  task_type TEXT CHECK(task_type IN ('task', 'discussion', 'proposal', 'vote', 'learning', 'other')),
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_estimate REAL,
  metadata TEXT, -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (discussion_id) REFERENCES discussions(id) ON DELETE SET NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_token_usage_log_task_id ON token_usage_log(task_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_log_discussion_id ON token_usage_log(discussion_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_log_agent_id ON token_usage_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_log_created_at ON token_usage_log(created_at);

-- Swarm learning table (lessons the swarm learns)
CREATE TABLE IF NOT EXISTS swarm_learning (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK(category IN ('pattern', 'anti_pattern', 'optimization', 'security', 'workflow', 'tool_usage', 'communication')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  source_task_id TEXT,
  source_discussion_id TEXT,
  lesson_learned TEXT NOT NULL,
  action_taken TEXT,
  effectiveness INTEGER CHECK(effectiveness >= 0 AND effectiveness <= 100),
  times_applied INTEGER NOT NULL DEFAULT 0,
  metadata TEXT, -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (source_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (source_discussion_id) REFERENCES discussions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_swarm_learning_category ON swarm_learning(category);
CREATE INDEX IF NOT EXISTS idx_swarm_learning_source_task_id ON swarm_learning(source_task_id);
CREATE INDEX IF NOT EXISTS idx_swarm_learning_source_discussion_id ON swarm_learning(source_discussion_id);
CREATE INDEX IF NOT EXISTS idx_swarm_learning_effectiveness ON swarm_learning(effectiveness);
CREATE INDEX IF NOT EXISTS idx_swarm_learning_created_at ON swarm_learning(created_at);

-- Config table (key-value store for app configuration)
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL, -- JSON value
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runtime_contract_probes (
  runtime TEXT PRIMARY KEY,
  command TEXT,
  status TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 0,
  contract_json TEXT NOT NULL DEFAULT '{}',
  probed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════════
-- Council Engine — Deliberatie systeem
-- ═══════════════════════════════════════════════════════════════

-- Council sessions
CREATE TABLE IF NOT EXISTS council_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  mode TEXT NOT NULL CHECK(mode IN ('fast', 'review', 'council')),
  status TEXT NOT NULL CHECK(status IN ('diverging', 'reviewing', 'synthesizing', 'completed', 'failed', 'escalated')),
  task_description TEXT NOT NULL,
  risk_class TEXT NOT NULL CHECK(risk_class IN ('low', 'medium', 'high', 'critical')),
  model_count INTEGER NOT NULL DEFAULT 1,
  max_reasoning_depth INTEGER DEFAULT 4,
  convergence_threshold REAL DEFAULT 0.75,
  synthesis_model TEXT,
  final_output TEXT,
  final_confidence REAL,
  token_usage INTEGER DEFAULT 0,
  cost_dollars REAL DEFAULT 0,
  duration_ms INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_council_sessions_status ON council_sessions(status);
CREATE INDEX IF NOT EXISTS idx_council_sessions_task_id ON council_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_council_sessions_mode ON council_sessions(mode);
CREATE INDEX IF NOT EXISTS idx_council_sessions_created_at ON council_sessions(created_at DESC);

-- Council model outputs (per fase)
CREATE TABLE IF NOT EXISTS council_outputs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('diverge', 'review', 'synthesize')),
  anonymous_id TEXT NOT NULL,
  content TEXT NOT NULL,
  structured_score TEXT,
  ranking_position INTEGER,
  token_count INTEGER DEFAULT 0,
  latency_ms INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_council_outputs_session_id ON council_outputs(session_id);
CREATE INDEX IF NOT EXISTS idx_council_outputs_phase ON council_outputs(phase);
CREATE INDEX IF NOT EXISTS idx_council_outputs_anon_id ON council_outputs(anonymous_id);

-- Council evaluator scores (structured)
CREATE TABLE IF NOT EXISTS council_evaluations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
  evaluator_model TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  correctness REAL NOT NULL DEFAULT 0,
  evidence_quality REAL NOT NULL DEFAULT 0,
  completeness REAL NOT NULL DEFAULT 0,
  risk_score REAL NOT NULL DEFAULT 0,
  policy_compliance REAL DEFAULT 0,
  reasoning TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_council_evaluations_session_id ON council_evaluations(session_id);
CREATE INDEX IF NOT EXISTS idx_council_evaluations_candidate_id ON council_evaluations(candidate_id);

-- Model registry (LLM capabilities)
CREATE TABLE IF NOT EXISTS council_models (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  reasoning_depth INTEGER DEFAULT 1,
  cost_per_1m_tokens REAL DEFAULT 0,
  privacy_class TEXT NOT NULL DEFAULT 'public_api' CHECK(privacy_class IN ('local', 'private_cloud', 'public_api')),
  independence_score REAL DEFAULT 0.5,
  avg_governance_score REAL DEFAULT 0,
  total_sessions INTEGER DEFAULT 0,
  total_tokens DEFAULT 0,
  avg_latency_ms INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'deprecated')),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_council_models_status ON council_models(status);
CREATE INDEX IF NOT EXISTS idx_council_models_provider ON council_models(provider);
CREATE INDEX IF NOT EXISTS idx_council_models_privacy ON council_models(privacy_class);

-- Reliability tracking
CREATE TABLE IF NOT EXISTS council_reliability (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES council_sessions(id),
  case_category TEXT,
  score_range REAL,
  pass_disagreement INTEGER DEFAULT 0,
  judge_count INTEGER DEFAULT 0,
  low_reliability INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_council_reliability_session_id ON council_reliability(session_id);
CREATE INDEX IF NOT EXISTS idx_council_reliability_low_rel ON council_reliability(low_reliability);

-- Aggregation results (Borda count, etc)
CREATE TABLE IF NOT EXISTS council_aggregations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK(method IN ('borda', 'reciprocal_rank_fusion', 'weighted_borda', 'condorcet', 'weighted_borda_with_uncertainty')),
  rankings TEXT NOT NULL,
  weights TEXT NOT NULL DEFAULT '{}',
  final_scores TEXT NOT NULL DEFAULT '{}',
  disagreement_score REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_council_aggregations_session_id ON council_aggregations(session_id);

-- Repository scans table
CREATE TABLE IF NOT EXISTS repository_scans (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  is_git_repository INTEGER NOT NULL DEFAULT 0,
  current_branch TEXT,
  default_branch TEXT,
  is_clean INTEGER NOT NULL DEFAULT 0,
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_repository_scans_repository_id ON repository_scans(repository_id);

-- Repository health findings table
CREATE TABLE IF NOT EXISTS repository_health_findings (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  scan_id TEXT,
  severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'low', 'medium', 'high', 'critical')),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  file_path TEXT,
  line_number INTEGER,
  recommendation TEXT,
  discovered_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_repository_health_findings_repository_id ON repository_health_findings(repository_id);

-- agents_md_files table
CREATE TABLE IF NOT EXISTS agents_md_files (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  applies_to_path TEXT,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content TEXT,
  discovered_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agents_md_files_repository_id ON agents_md_files(repository_id);

-- External causal events table (Paperclip and outcome ingest)
CREATE TABLE IF NOT EXISTS external_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'paperclip',
  correlation_id TEXT,
  causation_id TEXT,
  aggregate_id TEXT,
  aggregate_version INTEGER,
  dedupe_key TEXT UNIQUE,
  occurred_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_external_events_event_type ON external_events(event_type);
CREATE INDEX IF NOT EXISTS idx_external_events_occurred_at ON external_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_events_correlation_id ON external_events(correlation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_events_dedupe_key
  ON external_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_events_aggregate_version
  ON external_events(source, aggregate_id, aggregate_version)
  WHERE aggregate_id IS NOT NULL AND aggregate_version IS NOT NULL;

`;

export const explainerSchema = `-- Explainer tasks table
CREATE TABLE IF NOT EXISTS explainer_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  provider TEXT NOT NULL CHECK(provider IN ('local', 'github', 'gitlab')),
  local_path TEXT,
  remote_url TEXT,
  branch TEXT,
  repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  discovered_repository_id TEXT REFERENCES discovered_repositories(id) ON DELETE SET NULL,
  error_message TEXT,
  scan_id TEXT REFERENCES repository_scans(id) ON DELETE SET NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_explainer_tasks_status ON explainer_tasks(status);
CREATE INDEX IF NOT EXISTS idx_explainer_tasks_repository_id ON explainer_tasks(repository_id);
CREATE INDEX IF NOT EXISTS idx_explainer_tasks_discovered_repository_id ON explainer_tasks(discovered_repository_id);

-- Explainer bundles table
CREATE TABLE IF NOT EXISTS explainer_bundles (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES explainer_tasks(id) ON DELETE CASCADE,
  bundle_path TEXT NOT NULL,
  manifest_path TEXT,
  markdown_path TEXT,
  llms_txt_path TEXT,
  facts_path TEXT,
  sections_path TEXT,
  assets_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'published', 'human_review', 'unpublished')),
  content_hash TEXT,
  openmythos_score REAL,
  openmythos_rationale TEXT,
  token_count INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_explainer_bundles_task_id ON explainer_bundles(task_id);
CREATE INDEX IF NOT EXISTS idx_explainer_bundles_status ON explainer_bundles(status);

-- Explainer sections table
CREATE TABLE IF NOT EXISTS explainer_sections (
  id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL REFERENCES explainer_bundles(id) ON DELETE CASCADE,
  section_type TEXT NOT NULL CHECK(section_type IN ('overview', 'architecture', 'components', 'dependencies', 'api', 'flows', 'deployment', 'security', 'testing', 'governance', 'health')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_explainer_sections_bundle_id ON explainer_sections(bundle_id);

-- Repository scan artifacts table
CREATE TABLE IF NOT EXISTS repository_scan_artifacts (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES repository_scans(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_hash TEXT,
  size_bytes INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_repository_scan_artifacts_scan_id ON repository_scan_artifacts(scan_id);

-- Discovered repositories table (fleet-wide GitHub enumeration)
CREATE TABLE IF NOT EXISTS discovered_repositories (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL DEFAULT 'main',
  last_commit_sha TEXT,
  last_commit_at TEXT,
  repo_category TEXT NOT NULL DEFAULT 'other' CHECK(repo_category IN ('platform', 'plugin', 'tool', 'experimental', 'other')),
  language TEXT,
  license TEXT,
  stargazers_count INTEGER NOT NULL DEFAULT 0,
  open_issues_count INTEGER NOT NULL DEFAULT 0,
  priority_tier INTEGER NOT NULL DEFAULT 3 CHECK(priority_tier IN (1, 2, 3)),
  html_url TEXT NOT NULL,
  clone_url TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_discovered_repositories_full_name ON discovered_repositories(full_name);
CREATE INDEX IF NOT EXISTS idx_discovered_repositories_priority_tier ON discovered_repositories(priority_tier);
CREATE INDEX IF NOT EXISTS idx_discovered_repositories_is_active ON discovered_repositories(is_active);

-- Explainer jobs table (scheduler queue)
CREATE TABLE IF NOT EXISTS explainer_jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES explainer_tasks(id) ON DELETE CASCADE,
  scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  worker_id TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'queued', 'running', 'completed', 'failed', 'cancelled')),
  priority_score INTEGER NOT NULL DEFAULT 0,
  scheduled_reason TEXT NOT NULL DEFAULT 'manual',
  dedupe_key TEXT,
  estimated_llm_calls INTEGER NOT NULL DEFAULT 0,
  estimated_github_api_calls INTEGER NOT NULL DEFAULT 0,
  estimated_git_ops INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_explainer_jobs_task_id ON explainer_jobs(task_id);
CREATE INDEX IF NOT EXISTS idx_explainer_jobs_status ON explainer_jobs(status);
CREATE INDEX IF NOT EXISTS idx_explainer_jobs_scheduled_at ON explainer_jobs(scheduled_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_explainer_jobs_active_dedupe
  ON explainer_jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'queued', 'running');

-- Repo graph snapshots table (code-review-graph results)
CREATE TABLE IF NOT EXISTS repo_graph_snapshots (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  scan_id TEXT REFERENCES repository_scans(id) ON DELETE SET NULL,
  commit_sha TEXT,
  communities_json TEXT NOT NULL DEFAULT '[]',
  flows_json TEXT NOT NULL DEFAULT '[]',
  hub_nodes_json TEXT NOT NULL DEFAULT '[]',
  bridge_nodes_json TEXT NOT NULL DEFAULT '[]',
  surprising_connections_json TEXT NOT NULL DEFAULT '[]',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_repo_graph_snapshots_repository_id ON repo_graph_snapshots(repository_id);
CREATE INDEX IF NOT EXISTS idx_repo_graph_snapshots_scan_id ON repo_graph_snapshots(scan_id);

-- Explainer feedback table (human corrections)
CREATE TABLE IF NOT EXISTS explainer_feedback (
  id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL REFERENCES explainer_bundles(id) ON DELETE CASCADE,
  section_type TEXT,
  fact_id TEXT,
  correction TEXT NOT NULL,
  submitted_by TEXT,
  reviewed INTEGER NOT NULL DEFAULT 0,
  review_decision TEXT CHECK(review_decision IN ('accepted', 'rejected', 'pending')),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_explainer_feedback_bundle_id ON explainer_feedback(bundle_id);
CREATE INDEX IF NOT EXISTS idx_explainer_feedback_reviewed ON explainer_feedback(reviewed);

-- Human review queue table (low-confidence bundles)
CREATE TABLE IF NOT EXISTS human_review_queue (
  id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL REFERENCES explainer_bundles(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  openmythos_score REAL,
  assigned_to TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolution TEXT CHECK(resolution IN ('approved', 'rejected', 'pending')),
  resolved_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_human_review_queue_bundle_id ON human_review_queue(bundle_id);
CREATE INDEX IF NOT EXISTS idx_human_review_queue_resolved ON human_review_queue(resolved);

-- Explainer audit log table (pipeline governance)
CREATE TABLE IF NOT EXISTS explainer_audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'blocked', 'pending')),
  reason TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_explainer_audit_log_resource ON explainer_audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_explainer_audit_log_created_at ON explainer_audit_log(created_at DESC);

`;

export const fullSchema = schema + explainerSchema;
