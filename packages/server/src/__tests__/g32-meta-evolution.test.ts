import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { MetaEvolutionService } from '../services/meta-evolution-service';
import { swarmEventBus } from '../services/swarm-event-bus';

let db: Database.Database;
let intel: SwarmIntelligenceService;
let meta: MetaEvolutionService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  intel = new SwarmIntelligenceService(db);
  meta = new MetaEvolutionService(db, intel, { intervalMs: 100 });
});

afterEach(() => { meta.stop(); db?.close(); swarmEventBus.removeAllListeners(); });

function insertCapability(id: string, status: string) {
  db.prepare('INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref, allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score, eval_threshold, cost_model_json, removal_strategy, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'skill', 'test', '0.1', status, 'low', 'none', 'none', '["spawn_runtime_worker"]', '["deploy"]', '["proof:test"]', 0, 0.5, '{}', 'demote_on_fail', '{}', new Date(Date.now() - 35 * 86400000).toISOString(), new Date().toISOString());
}

describe('G32: Meta-evolution loop', () => {
  it('evaluates planner accuracy', () => {
    db.prepare('INSERT INTO loop_runs (id, loop_name, mode, status) VALUES (?, ?, ?, ?)').run('run-1', 'test', 'closed', 'completed');
    db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status) VALUES (?, ?, ?, ?, ?)').run('l1', 'run-1', 'maker', 'codex', 'completed');
    db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status) VALUES (?, ?, ?, ?, ?)').run('l2', 'run-1', 'maker', 'codex', 'failed');
    const report = meta.evaluate();
    expect(report.planner_accuracy).toBe(0.5);
  });

  it('flags dormant capabilities without treating non-use as demotion evidence', () => {
    insertCapability('cap-dormant', 'validated');
    const report = meta.evaluate();
    expect(report.dormant_capabilities).toBe(1);
    expect(report.pruned).toBe(0);
    const cap = db.prepare('SELECT status, metadata FROM swarm_capabilities WHERE id = ?').get('cap-dormant') as { status: string; metadata: string };
    expect(cap.status).toBe('validated');
    expect(JSON.parse(cap.metadata).dormancy.status).toBe('review_required');
  });

  it('emits a meta_evolution event', () => {
    const events: any[] = [];
    swarmEventBus.subscribe((e) => events.push(e));
    meta.evaluate();
    const metaEvent = events.find((e) => e.data?.meta_evolution === 'evaluation_complete');
    expect(metaEvent).toBeDefined();
  });

  it('demotes repeatedly contradicted memory once with evidence lineage', () => {
    db.prepare(`INSERT INTO swarm_claims
      (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, metadata, created_at, updated_at)
      VALUES ('memory-1', 'stale rule', 'memory', 'routing', 'rule', 'contradicted', 0.8, '[]', 'test', '{}', datetime('now'), datetime('now'))`).run();
    for (let index = 1; index <= 3; index += 1) {
      db.prepare(`INSERT INTO swarm_claims
        (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, contradicts_ref, metadata, created_at, updated_at)
        VALUES (?, 'counter evidence', 'observation', 'routing', 'contradiction', 'supported', 0.9, ?, 'independent-checker', 'memory-1', '{}', datetime('now'), datetime('now'))`)
        .run(`counter-${index}`, JSON.stringify([`evidence:${index}`]));
    }

    expect(meta.evaluate().demoted_rules).toBe(1);
    expect(meta.evaluate().demoted_rules).toBe(0);
    const metadata = JSON.parse((db.prepare("SELECT metadata FROM swarm_claims WHERE id = 'memory-1'").get() as any).metadata);
    expect(metadata).toMatchObject({ demoted: true, trust: 0.3, demoted_reason: '3 contradictions' });
    expect(metadata.demotion_evidence_refs).toEqual(expect.arrayContaining(['counter-1', 'evidence:1', 'counter-3', 'evidence:3']));
  });

  it('start/stop controls the timer', () => {
    meta.start();
    meta.stop();
    // Just verify it doesn't throw.
    expect(true).toBe(true);
  });
});
