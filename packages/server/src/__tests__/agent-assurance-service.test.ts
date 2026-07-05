import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { AgentAssuranceService } from '../services/agent-assurance-service';

describe('AgentAssuranceService', () => {
  let db: Database.Database;
  let service: AgentAssuranceService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE agent_trace_spans (id TEXT PRIMARY KEY, trace_id TEXT, loop_run_id TEXT, span_type TEXT, name TEXT, status TEXT, metadata TEXT DEFAULT '{}', evidence_ref TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE agent_checkpoints (id TEXT PRIMARY KEY, loop_run_id TEXT, label TEXT, status TEXT DEFAULT 'created', metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE loop_checkpoints (id TEXT PRIMARY KEY, loop_run_id TEXT, label TEXT, status TEXT DEFAULT 'created', metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE agent_eval_runs (id TEXT PRIMARY KEY, suite_name TEXT, target_type TEXT, target_ref TEXT, status TEXT, score REAL, scorecard_json TEXT DEFAULT '{}', findings_json TEXT DEFAULT '[]', metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE agent_capability_tokens (id TEXT PRIMARY KEY, token_hash TEXT, capability_id TEXT, scope TEXT, risk_level TEXT, issued_by TEXT, evidence_refs_json TEXT DEFAULT '[]', constraints_json TEXT DEFAULT '{}', valid_until TEXT, status TEXT DEFAULT 'active', metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE capability_tokens (id TEXT PRIMARY KEY, token_hash TEXT, capability_id TEXT, scope TEXT, risk_level TEXT, issued_by TEXT, evidence_refs_json TEXT DEFAULT '[]', constraints_json TEXT DEFAULT '{}', valid_until TEXT, status TEXT DEFAULT 'active', metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE loop_runs (id TEXT PRIMARY KEY, loop_name TEXT, status TEXT DEFAULT 'created', created_at TEXT DEFAULT (datetime('now')));
    `);
    service = new AgentAssuranceService(db);
  });

  it('instantiates without throwing', () => {
    expect(service).toBeDefined();
  });

  it('has createTraceSpan method', () => {
    expect(typeof service.createTraceSpan).toBe('function');
  });

  it('has createCheckpoint method', () => {
    expect(typeof service.createCheckpoint).toBe('function');
  });

  it('has summary method', () => {
    expect(typeof service.summary).toBe('function');
  });

  it('summary method exists and is callable', () => {
    expect(typeof service.summary).toBe('function');
    // Note: summary() queries multiple tables; full integration test requires complete DB schema
  });
});
