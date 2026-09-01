-- Multi-Tenancy + Audit Trail Migratie
-- Change ID: djimitflo-multi-tenancy-audit-trail

-- 1. Voeg organization_id toe aan bestaande tabellen + indexen
ALTER TABLE agents ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE loops ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE loop_runs ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE approvals ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX idx_users_organization ON users(organization_id);
CREATE INDEX idx_agents_organization ON agents(organization_id);
CREATE INDEX idx_loops_organization ON loops(organization_id);
CREATE INDEX idx_loop_runs_organization ON loop_runs(organization_id);
CREATE INDEX idx_approvals_organization ON approvals(organization_id);

-- 2. Maak audit_logs tabel met cryptografische hashing
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_type TEXT NOT NULL, -- 'agent', 'loop', 'user', 'approval'
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL, -- 'create', 'update', 'delete', 'execute', 'approve'
  metadata JSON NOT NULL,
  log_hash TEXT NOT NULL, -- SHA-256 hash van metadata
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

-- 3. WAL mode voor onveranderlijke logs
PRAGMA journal_mode = WAL;

-- 4. Indexen voor performance
CREATE INDEX idx_audit_logs_organization ON audit_logs(organization_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX idx_audit_logs_hash ON audit_logs(log_hash);

-- 5. Maak organizations tabel voor validatie
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 6. Voeg default organization toe
INSERT OR IGNORE INTO organizations (id, name, created_at, updated_at) VALUES ('default', 'Default Organization', datetime('now'), datetime('now'));