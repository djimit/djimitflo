-- Messages table for agent-to-agent communication via SQLite and Redis pub/sub
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY DEFAULT lower(hex(randomblob(16))),
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('task_delegation', 'status_update', 'knowledge_share', 'alert')),
  payload TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'low' CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (from_agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (to_agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_from_agent_id ON messages(from_agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_to_agent_id ON messages(to_agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_messages_priority ON messages(priority);
CREATE INDEX IF NOT EXISTS idx_messages_read_at ON messages(read_at);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
