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
`;
