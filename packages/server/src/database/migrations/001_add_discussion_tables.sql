-- Migration 001: Add discussion tables, token usage log, and swarm learning
-- SQLite schema migration for Djimitflo

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
