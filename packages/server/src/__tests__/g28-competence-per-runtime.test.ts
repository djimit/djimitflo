import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';

let db: Database.Database;
let intel: SwarmIntelligenceService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  intel = new SwarmIntelligenceService(db);
  db.prepare('INSERT INTO loop_runs (id, loop_name, mode, status) VALUES (?, ?, ?, ?)').run('run-test', 'test', 'closed', 'completed');
});

afterEach(() => { db?.close(); });

function insertCapability(id: string) {
  db.prepare(`
    INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref, allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score, eval_threshold, cost_model_json, removal_strategy, metadata, created_at, updated_at)
    VALUES (?, 'skill', 'test', '0.1', 'validated', 'low', 'none', 'none', '["spawn_runtime_worker"]', '["deploy"]', '["proof:test"]', 0, 0.5, '{}', 'demote_on_fail', '{}', datetime('now'), datetime('now'))
  `).run(id);
}

function insertLease(id: string, capId: string, runtime: string, status: string, tokens: number = 1000) {
  db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, worktree_path, metadata, capability_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'run-test', 'maker', runtime, status, 'f1', '/tmp', JSON.stringify({ runtime_usage: { total_tokens: tokens } }), capId);
}

describe('G28: Competence-per-runtime tracking', () => {
  it('tracks competence per (capability, runtime)', () => {
    insertCapability('cap-ts');
    insertLease('l1', 'cap-ts', 'codex', 'completed', 5000);
    insertLease('l2', 'cap-ts', 'codex', 'failed', 6000);
    insertLease('l3', 'cap-ts', 'codex', 'failed', 4000);
    insertLease('l4', 'cap-ts', 'opencode', 'completed', 2000);
    insertLease('l5', 'cap-ts', 'opencode', 'completed', 3000);

    const result = intel.measureCompetencePerRuntime('cap-ts');
    expect(result.codex).toBeDefined();
    expect(result.codex.n_runs).toBe(3);
    expect(result.codex.n_completed).toBe(1);
    expect(result.codex.success_rate).toBeCloseTo(0.33, 1);
    expect(result.opencode).toBeDefined();
    expect(result.opencode.n_runs).toBe(2);
    expect(result.opencode.success_rate).toBe(1.0);
  });

  it('stores per-runtime competence in cost_model_json', () => {
    insertCapability('cap-store');
    insertLease('l1', 'cap-store', 'codex', 'completed', 5000);
    insertLease('l2', 'cap-store', 'opencode', 'completed', 2000);

    intel.measureCompetencePerRuntime('cap-store');
    const row = db.prepare('SELECT cost_model_json FROM swarm_capabilities WHERE id = ?').get('cap-store') as { cost_model_json: string };
    const costModel = JSON.parse(row.cost_model_json);
    expect(costModel.runtime_competence).toBeDefined();
    expect(costModel.runtime_competence.codex).toBeDefined();
    expect(costModel.runtime_competence.opencode).toBeDefined();
  });

  it('returns empty when no leases exist', () => {
    insertCapability('cap-empty');
    const result = intel.measureCompetencePerRuntime('cap-empty');
    expect(Object.keys(result).length).toBe(0);
  });
});
