import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { OperatorInterventionService } from '../services/operator-intervention';
import { CapabilityAcquisitionService } from '../services/capability-acquisition';
import { ResourceScheduler } from '../services/resource-scheduler';
import { knowledgeBus } from '../services/knowledge-bus';
import { swarmEventBus } from '../services/swarm-event-bus';

let db: Database.Database;
let loops: LoopService;
let intelligence: SwarmIntelligenceService;
let intervention: OperatorInterventionService;
let acquisition: CapabilityAcquisitionService;
let scheduler: ResourceScheduler;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  loops = new LoopService(db, '/tmp/djimitflo-test');
  intelligence = new SwarmIntelligenceService(db);
  intervention = new OperatorInterventionService(db, loops, intelligence);
  acquisition = new CapabilityAcquisitionService(db, intelligence);
  scheduler = new ResourceScheduler();
});

afterEach(() => {
  acquisition.stop();
  db?.close();
  knowledgeBus.removeAllListeners();
  (knowledgeBus as any).subscribers.clear();
  (knowledgeBus as any).globalSubscribers.clear();
  swarmEventBus.removeAllListeners();
});

describe('G22: Operator intervention', () => {
  it('injects knowledge into the semantic store', () => {
    const goal = loops.createGoal({
      objective: 'Test goal',
      acceptance_criteria: [{metric: 'test_passes', target: 'all'}],
      risk_class: 'low',
    });
    const result = intervention.injectKnowledge(goal.id, {
      predicate: 'recommends',
      subject_ref: 'test:1',
      confidence: 0.9,
      evidence: 'Use null guards for metadata objects',
    });
    expect(result.injected).toBe(true);
  });

  it('overrides a gate decision', () => {
    const goal = loops.createGoal({
      objective: 'Test goal',
      acceptance_criteria: [{metric: 'test_passes', target: 'all'}],
      risk_class: 'low',
    });
    // Create a loop run with gates.
    db.prepare('INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, repository_path, findings_json, plan_json, gates_json, next_actions_json, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('run-1', goal.id, 'test', 'closed', 'running', '/tmp', '[]', '[]', JSON.stringify([{name:'test_gate', status:'fail', evidence:'failed'}]), '[]', '{}');
    const result = intervention.overrideGate(goal.id, 'test_gate', 'proceed', 'operator override');
    expect(result.overridden).toBe(true);
  });
});

describe('G23: Autonomous capability acquisition', () => {
  it('creates a candidate capability from a capability_gap claim', () => {
    acquisition.start();
    CapabilityAcquisitionService.emitCapabilityGap('lease-1', 'run-1', 'novel-cap', 'No matching capability for this problem');
    // Check the capability was created.
    const cap = db.prepare('SELECT id, status FROM swarm_capabilities WHERE id = ?').get('novel-cap') as {id: string; status: string} | undefined;
    expect(cap).toBeDefined();
    expect(cap!.status).toBe('candidate');
  });

  it('does not duplicate an existing capability', () => {
    acquisition.start();
    // Create the capability manually first.
    db.prepare('INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref, allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score, eval_threshold, cost_model_json, removal_strategy, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('existing-cap', 'skill', 'test', '0.1', 'validated', 'low', 'none', 'none', '["spawn_runtime_worker"]', '["deploy"]', '["proof:test"]', 0, 0.5, '{}', 'demote_on_fail', '{}', new Date().toISOString(), new Date().toISOString());
    // Emit a gap claim for the same capability.
    CapabilityAcquisitionService.emitCapabilityGap('lease-1', 'run-1', 'existing-cap', 'Already exists');
    // Should not create a duplicate — still only 1 row.
    const count = db.prepare('SELECT COUNT(*) as c FROM swarm_capabilities WHERE id = ?').get('existing-cap') as {c: number};
    expect(count.c).toBe(1);
  });
});

describe('G24: Resource-aware scheduling', () => {
  it('allows a CPU-only goal when CPU is available', () => {
    const result = scheduler.canSchedule({});
    expect(result.canSchedule).toBe(true);
  });

  it('defers a GPU-bound goal when no GPU is available', () => {
    const result = scheduler.canSchedule({ requires_gpu: true });
    // FLEET_HAS_GPU is not set in test env, so GPU is not available.
    expect(result.canSchedule).toBe(false);
    expect(result.reason).toContain('gpu');
  });

  it('allows a GPU-bound goal when GPU is available', () => {
    process.env.FLEET_HAS_GPU = 'true';
    const result = scheduler.canSchedule({ requires_gpu: true });
    expect(result.canSchedule).toBe(true);
    delete process.env.FLEET_HAS_GPU;
  });
});
