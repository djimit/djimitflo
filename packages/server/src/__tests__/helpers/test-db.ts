/**
 * Test database helper — creates a complete, isolated SQLite database
 * for unit and integration tests. Solves the migration ordering issue
 * by creating all tables directly instead of running the migration chain.
 */

import Database from 'better-sqlite3';

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin', 'operator', 'viewer')),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    objective TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created', 'decomposed', 'running', 'blocked', 'completed', 'failed', 'cancelled')),
    budget_json TEXT NOT NULL DEFAULT '{}',
    constraints_json TEXT NOT NULL DEFAULT '[]',
    acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
    risk_class TEXT NOT NULL DEFAULT 'low' CHECK(risk_class IN ('low', 'medium', 'high', 'critical')),
    owner_user_id TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS loop_runs (
    id TEXT PRIMARY KEY,
    goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
    loop_name TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'closed' CHECK(mode IN ('closed', 'open')),
    status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created', 'planning', 'running', 'verifying', 'ready_for_human_merge', 'blocked', 'completed', 'failed', 'escalated', 'cancelled', 'interrupted')),
    repository_path TEXT,
    state_file TEXT,
    findings_json TEXT NOT NULL DEFAULT '[]',
    plan_json TEXT NOT NULL DEFAULT '{}',
    gates_json TEXT NOT NULL DEFAULT '[]',
    next_actions_json TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS worker_leases (
    id TEXT PRIMARY KEY,
    loop_run_id TEXT NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('planner', 'maker', 'checker', 'security_checker', 'memory_curator', 'governance_guard', 'orchestrator')),
    runtime TEXT NOT NULL DEFAULT 'codex' CHECK(runtime IN ('manual', 'mock', 'codex', 'opencode', 'claude', 'gemini', 'editor', 'pi', 'cline', 'goose', 'aider', 'kimi', 'continue', 'kiro', 'kilo')),
    status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared', 'running', 'completed', 'failed', 'cancelled', 'blocked', 'needs_revision', 'rejected', 'insufficient_evidence')),
    finding_id TEXT,
    worktree_path TEXT,
    branch_name TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    budget_json TEXT NOT NULL DEFAULT '{}',
    capability_id TEXT,
    parent_lease_id TEXT REFERENCES worker_leases(id) ON DELETE SET NULL,
    spawn_tree_id TEXT,
    depth INTEGER NOT NULL DEFAULT 0,
    spawned_by_agent_id TEXT,
    context_budget INTEGER DEFAULT 0,
    context_consumed INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS loop_events (
    id TEXT PRIMARY KEY,
    loop_run_id TEXT NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('debug', 'info', 'warning', 'error', 'critical')),
    message TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    level TEXT NOT NULL DEFAULT 'info',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'active', 'paused', 'error', 'offline', 'retired', 'handoff_complete')),
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    model TEXT NOT NULL DEFAULT 'workstation-litellm/coding',
    temperature REAL NOT NULL DEFAULT 0.7,
    max_tokens INTEGER NOT NULL DEFAULT 4096,
    last_seen TEXT,
    last_active_at TEXT,
    retired_at TEXT,
    retirement_reason TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_trace_spans (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    loop_run_id TEXT REFERENCES loop_runs(id) ON DELETE CASCADE,
    span_type TEXT NOT NULL CHECK(span_type IN ('worker', 'checker', 'security', 'lease', 'gate', 'event', 'evidence', 'reflection', 'checkpoint', 'eval', 'custom')),
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed', 'skipped')),
    metadata TEXT NOT NULL DEFAULT '{}',
    evidence_ref TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_checkpoints (
    id TEXT PRIMARY KEY,
    loop_run_id TEXT NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created', 'validated', 'branched', 'superseded')),
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

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

  CREATE TABLE IF NOT EXISTS agent_capability_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    capability_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'critical')),
    issued_by TEXT NOT NULL,
    evidence_refs_json TEXT NOT NULL DEFAULT '[]',
    constraints_json TEXT NOT NULL DEFAULT '{}',
    valid_until TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked', 'expired')),
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS capability_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    capability_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    issued_by TEXT NOT NULL,
    evidence_refs_json TEXT NOT NULL DEFAULT '[]',
    constraints_json TEXT NOT NULL DEFAULT '{}',
    valid_until TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS swarm_capabilities (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('skill', 'specialist_agent', 'runtime_adapter', 'deterministic_harness', 'memory_source', 'dashboard_action', 'openai_agents_sdk', 'openai_skill', 'openai_mcp_connector')),
    owner TEXT NOT NULL,
    version TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('draft', 'candidate', 'validated', 'deprecated', 'disabled')),
    risk_ceiling TEXT NOT NULL CHECK(risk_ceiling IN ('low', 'medium', 'high', 'critical')),
    input_schema_ref TEXT NOT NULL DEFAULT '',
    output_schema_ref TEXT NOT NULL DEFAULT '',
    allowed_actions_json TEXT NOT NULL DEFAULT '[]',
    forbidden_actions_json TEXT NOT NULL DEFAULT '[]',
    required_evidence_json TEXT NOT NULL DEFAULT '[]',
    eval_score REAL NOT NULL DEFAULT 0 CHECK(eval_score >= 0 AND eval_score <= 1),
    eval_threshold REAL NOT NULL DEFAULT 0.75,
    cost_model_json TEXT NOT NULL DEFAULT '{}',
    removal_strategy TEXT NOT NULL,
    latest_validation_report TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    live_route_allowed INTEGER NOT NULL DEFAULT 0,
    blocked_reasons_json TEXT NOT NULL DEFAULT '[]',
    evidence_refs_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS swarm_claims (
    id TEXT PRIMARY KEY,
    claim TEXT NOT NULL,
    predicate TEXT,
    object TEXT,
    scope TEXT,
    claim_type TEXT NOT NULL CHECK(claim_type IN ('observation', 'hypothesis', 'decision', 'memory', 'capability', 'backlog', 'policy')),
    subject_ref TEXT NOT NULL,
    evidence_refs_json TEXT NOT NULL DEFAULT '[]',
    confidence REAL NOT NULL DEFAULT 0.5,
    valid_until TEXT,
    status TEXT NOT NULL CHECK(status IN ('proposed', 'supported', 'contradicted', 'resolved', 'rejected', 'promoted', 'review_required')),
    verified_by_gate TEXT,
    invalidated_by TEXT,
    supports_ref TEXT,
    contradicts_ref TEXT,
    created_from TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS swarm_evidence_edges (
    id TEXT PRIMARY KEY,
    from_ref TEXT NOT NULL,
    to_ref TEXT NOT NULL,
    relation TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS openmythos_eval_runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    total_cases INTEGER NOT NULL DEFAULT 0,
    completed_cases INTEGER NOT NULL DEFAULT 0,
    overall_score REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),
    categories_json TEXT NOT NULL DEFAULT '[]',
    judge_model TEXT NOT NULL DEFAULT 'qwen2.5:14b-instruct-q4_K_M',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS swarm_hypotheses (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed', 'supported', 'contradicted', 'resolved', 'rejected')),
    evidence_refs_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS knowledge_claims (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    claim TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.7,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'contradicted', 'confirmed', 'superseded')),
    votes_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_subscriptions (
    agent_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 3,
    subscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (agent_id, topic)
  );

  CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('task', 'result', 'question', 'alert', 'handoff', 'knowledge')),
    priority INTEGER NOT NULL DEFAULT 3,
    payload_json TEXT NOT NULL DEFAULT '{}',
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    ttl INTEGER NOT NULL DEFAULT 300,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'read', 'expired'))
  );

  CREATE TABLE IF NOT EXISTS vector_memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    embedding_json TEXT NOT NULL DEFAULT '[]',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ttl INTEGER,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS goal_hypotheses (
    id TEXT PRIMARY KEY,
    statement TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    reasoning TEXT NOT NULL DEFAULT '',
    parent_goal_id TEXT,
    status TEXT NOT NULL DEFAULT 'hypothesis' CHECK(status IN ('hypothesis', 'validated', 'invalidated', 'in_progress', 'achieved')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS strategy_nodes (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT '',
    preconditions_json TEXT NOT NULL DEFAULT '[]',
    effects_json TEXT NOT NULL DEFAULT '[]',
    children_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
    priority INTEGER NOT NULL DEFAULT 5,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS execution_plans (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning', 'executing', 'reviewing', 'completed', 'failed')),
    subtasks_json TEXT NOT NULL DEFAULT '[]',
    stages_json TEXT NOT NULL DEFAULT '[]',
    estimated_minutes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS swarm_sessions (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planning',
    subtasks_json TEXT NOT NULL DEFAULT '[]',
    agent_pool_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS consensus_debates (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'proposing' CHECK(status IN ('proposing', 'debating', 'voting', 'resolved', 'escalated')),
    winning_proposal_id TEXT,
    consensus_score REAL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS consensus_proposals (
    id TEXT PRIMARY KEY,
    debate_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    content TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    confidence REAL NOT NULL DEFAULT 0.7,
    score REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS consensus_votes (
    id TEXT PRIMARY KEY,
    debate_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('strong_agree', 'agree', 'neutral', 'disagree', 'strong_disagree')),
    reason TEXT NOT NULL DEFAULT '',
    weight REAL NOT NULL DEFAULT 1.0,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS skill_genomes (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1,
    parents_json TEXT NOT NULL DEFAULT '[]',
    traits_json TEXT NOT NULL DEFAULT '{}',
    fitness REAL NOT NULL DEFAULT 0,
    mutations_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS skill_outcomes (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    domain TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS improvement_opportunities (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('test_gap', 'todo', 'complexity', 'documentation', 'performance')),
    severity TEXT NOT NULL DEFAULT 'medium' CHECK(severity IN ('low', 'medium', 'high')),
    file_path TEXT NOT NULL,
    line_number INTEGER,
    description TEXT NOT NULL DEFAULT '',
    suggestion TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'identified' CHECK(status IN ('identified', 'planned', 'implemented', 'validated')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS code_patches (
    id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    original TEXT NOT NULL DEFAULT '',
    replacement TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'applied', 'tested', 'rejected')),
    test_result_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS governance_feedback (
    id TEXT PRIMARY KEY,
    ecli TEXT NOT NULL,
    original_decision TEXT NOT NULL,
    corrected_decision TEXT NOT NULL,
    reason TEXT NOT NULL,
    corrected_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    applied INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS self_healing_log (
    id TEXT PRIMARY KEY,
    check_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('healthy', 'degraded', 'critical')),
    details TEXT NOT NULL DEFAULT '',
    auto_fixed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS plugins (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '0.1.0',
    description TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT 'unknown',
    license TEXT NOT NULL DEFAULT 'MIT',
    enabled INTEGER NOT NULL DEFAULT 1,
    manifest_json TEXT NOT NULL DEFAULT '{}',
    installed_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_archives (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    archived_at TEXT NOT NULL DEFAULT (datetime('now')),
    evidence_json TEXT NOT NULL DEFAULT '{}',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (agent_id, skill_id)
  );

  CREATE TABLE IF NOT EXISTS model_capabilities (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL UNIQUE,
    model_name TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT 'workstation-litellm',
    cost_per_mtok REAL NOT NULL DEFAULT 2.0,
    avg_latency_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'degraded', 'offline')),
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS llm_provider_metrics (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    task_type TEXT NOT NULL,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 1,
    cost_dollars REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS worker_results (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    output TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS context_cache (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    original TEXT NOT NULL,
    compressed TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'text',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS proactive_memory_relations (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation_type TEXT NOT NULL DEFAULT 'related',
    strength REAL NOT NULL DEFAULT 0.5,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sub_agent_tool_outputs (
    id TEXT PRIMARY KEY,
    lease_id TEXT NOT NULL,
    tool_name TEXT NOT NULL DEFAULT '',
    original_size INTEGER NOT NULL DEFAULT 0,
    file_path TEXT,
    summary TEXT NOT NULL DEFAULT '',
    offloaded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sub_agent_scratch (
    id TEXT PRIMARY KEY,
    lease_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(lease_id, key)
  );

  CREATE TABLE IF NOT EXISTS spawn_trees (
    id TEXT PRIMARY KEY,
    depth_budget INTEGER NOT NULL DEFAULT 0,
    total_token_budget INTEGER NOT NULL DEFAULT 0,
    consumed_tokens INTEGER NOT NULL DEFAULT 0,
    total_wall_budget_ms INTEGER NOT NULL DEFAULT 0,
    consumed_wall_ms INTEGER NOT NULL DEFAULT 0,
    max_concurrent_children INTEGER NOT NULL DEFAULT 0,
    risk_class TEXT NOT NULL DEFAULT 'medium',
    context_budget INTEGER DEFAULT 0,
    context_consumed INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed', 'exhausted')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS memory_candidates (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    memory_type TEXT NOT NULL CHECK(memory_type IN ('operational_memory', 'engineering_rule', 'policy_rule')),
    store TEXT NOT NULL DEFAULT 'episodic' CHECK(store IN ('episodic', 'procedural', 'semantic', 'working')),
    source_ref TEXT,
    status TEXT NOT NULL CHECK(status IN ('candidate', 'review_required', 'rejected', 'promoted')),
    promotion_status TEXT NOT NULL CHECK(promotion_status IN ('proposed', 'blocked_pending_review', 'blocked_pending_human', 'rejected', 'promoted')),
    human_required INTEGER NOT NULL DEFAULT 0,
    sensitivity TEXT NOT NULL CHECK(sensitivity IN ('normal', 'security_sensitive', 'secret_detected')),
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

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
    metadata TEXT,
    added_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

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

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied')),
    risk_level TEXT NOT NULL DEFAULT 'low' CHECK(risk_level IN ('low', 'medium', 'high', 'critical')),
    request_type TEXT NOT NULL DEFAULT '',
    request_message TEXT NOT NULL DEFAULT '',
    request_data TEXT NOT NULL DEFAULT '{}',
    requested_by TEXT,
    approved_at TEXT,
    denied_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

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
    tags TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
    FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE SET NULL
  );

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

  CREATE TABLE IF NOT EXISTS compliance_audit_log (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'denied')),
    evidence_json TEXT NOT NULL DEFAULT '{}',
    previous_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL DEFAULT 'system',
    action TEXT NOT NULL,
    resource TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL DEFAULT 'success' CHECK(outcome IN ('success', 'failure', 'denied')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS evidence_items (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL DEFAULT 0.5,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Performance indexes
  CREATE INDEX IF NOT EXISTS idx_loop_runs_status ON loop_runs(status);
  CREATE INDEX IF NOT EXISTS idx_loop_runs_goal_id ON loop_runs(goal_id);
  CREATE INDEX IF NOT EXISTS idx_worker_leases_loop_run_id ON worker_leases(loop_run_id);
  CREATE INDEX IF NOT EXISTS idx_worker_leases_status_role ON worker_leases(status, role);
  CREATE INDEX IF NOT EXISTS idx_loop_events_loop_run_id_created_at ON loop_events(loop_run_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_openmythos_eval_agent_status ON openmythos_eval_runs(agent_id, status);
  CREATE INDEX IF NOT EXISTS idx_knowledge_claims_topic_status ON knowledge_claims(topic, status);
  CREATE INDEX IF NOT EXISTS idx_strategy_nodes_goal_status ON strategy_nodes(goal_id, status);
  CREATE INDEX IF NOT EXISTS idx_consensus_proposals_debate_score ON consensus_proposals(debate_id, score DESC);
  CREATE INDEX IF NOT EXISTS idx_vector_memories_created_at ON vector_memories(created_at);
  CREATE INDEX IF NOT EXISTS idx_swarm_sessions_status ON swarm_sessions(status);
  CREATE INDEX IF NOT EXISTS idx_agent_messages_to_agent ON agent_messages(to_agent);
  CREATE INDEX IF NOT EXISTS idx_agent_messages_status ON agent_messages(status);
  CREATE INDEX IF NOT EXISTS idx_improvement_opportunities_status ON improvement_opportunities(status);
  CREATE INDEX IF NOT EXISTS idx_self_healing_log_check_type ON self_healing_log(check_type);
  CREATE INDEX IF NOT EXISTS idx_audit_log_actor_action ON audit_log(actor, action);
  CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);
`;
