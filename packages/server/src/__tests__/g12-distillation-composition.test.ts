import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { MemoryCandidateService } from '../services/memory-candidate-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';

let db: Database.Database;
let memory: MemoryCandidateService;
let intelligence: SwarmIntelligenceService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  memory = new MemoryCandidateService(db);
  intelligence = new SwarmIntelligenceService(db);
});

afterEach(() => { db?.close(); });

function insertCapability(id: string, status: string, metadata: Record<string, unknown> = {}) {
  db.prepare(`
    INSERT INTO swarm_capabilities (
      id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
      allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score,
      eval_threshold, cost_model_json, removal_strategy, latest_validation_report,
      metadata, created_at, updated_at
    ) VALUES (?, 'skill', 'test', '0.1', ?, 'low', 'none', 'none',
      '["spawn_runtime_worker"]', '["deploy"]', '["proof:test"]', 0, 0.5, '{}', 'demote_on_fail', null, ?, datetime('now'), datetime('now'))
  `).run(id, status, JSON.stringify(metadata));
}

function insertLoopRun() {
  db.prepare(
    `INSERT INTO loop_runs (id, loop_name, mode, status) VALUES ('run-g12', 'doc-drift-and-small-fix-loop', 'closed', 'running')`
  ).run();
}
function insertLease(id: string, capabilityId: string, status: string, tokens: number = 1000) {
  db.prepare(`
    INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, worktree_path, metadata, capability_id)
    VALUES (?, 'run-g12', 'maker', 'codex', ?, 'finding-1', '/tmp/wt', ?, ?)
  `).run(id, status, JSON.stringify({ runtime_usage: { total_tokens: tokens } }), capabilityId);
}

describe('G12: Memory distillation', () => {
  it('creates a procedural memory from a successful run', () => {
    const c = memory.distillFromRun({
      loopRunId: 'run-1',
      capabilityId: 'cap-debug',
      runtime: 'codex',
      outcome: 'success',
      makerLeaseId: 'lease-1',
      checkerLeaseId: 'lease-2',
      keyLearning: 'When debugging TypeScript null errors in loop-service, check metadata parsing first.',
    });

    expect(c.store).toBe('procedural');
    expect(c.memory_type).toBe('engineering_rule');
    expect(c.content).toContain('check metadata parsing first');
    expect((c.metadata as any).distilled).toBe(true);
    expect((c.metadata as any).rule_structure.capability).toBe('cap-debug');
    expect((c.metadata as any).rule_structure.outcome).toBe('success');
  });

  it('creates a procedural memory from a failed run with default rule', () => {
    const c = memory.distillFromRun({
      loopRunId: 'run-2',
      capabilityId: 'cap-fix',
      runtime: 'opencode',
      outcome: 'failure',
    });

    expect(c.store).toBe('procedural');
    expect(c.content).toContain('failed');
    expect(c.content).toContain('opencode');
  });
});

describe('G12: Skill composition', () => {
  it('creates a composed skill with a chain of atomic skills', () => {
    insertCapability('skill-diagnose', 'validated');
    insertCapability('skill-fix', 'validated');

    const composed = intelligence.createComposedSkill({
      id: 'composed-diagnose-fix',
      name: 'Diagnose → Fix',
      chain: ['skill-diagnose', 'skill-fix'],
    });

    expect(composed.status).toBe('candidate');
    expect((composed.metadata as any).composed).toBe(true);
    expect((composed.metadata as any).chain).toEqual(['skill-diagnose', 'skill-fix']);
  });

  it('rejects a composed skill with fewer than 2 atomic skills', () => {
    insertCapability('skill-single', 'validated');

    expect(() => intelligence.createComposedSkill({
      id: 'composed-single',
      name: 'Single',
      chain: ['skill-single'],
    })).toThrow('COMPOSED_SKILL_CHAIN_MIN_2');
  });

  it('rejects a composed skill with non-existent atomic skills', () => {
    expect(() => intelligence.createComposedSkill({
      id: 'composed-bad',
      name: 'Bad',
      chain: ['non-existent-1', 'non-existent-2'],
    })).toThrow('SWARM_CAPABILITY_NOT_FOUND');
  });

  it('does not promote when not all atomic skills are validated', () => {
    insertCapability('skill-a', 'validated');
    insertCapability('skill-b', 'candidate'); // not validated yet

    intelligence.createComposedSkill({
      id: 'composed-ab',
      name: 'A → B',
      chain: ['skill-a', 'skill-b'],
    });

    const result = intelligence.promoteComposedSkill('composed-ab');
    expect(result.promoted).toBe(false);
    expect(result.allAtomicValidated).toBe(false);
  });

  it('does not promote when the chain has insufficient runs', () => {
    insertCapability('skill-x', 'validated');
    insertCapability('skill-y', 'validated');

    intelligence.createComposedSkill({
      id: 'composed-xy',
      name: 'X → Y',
      chain: ['skill-x', 'skill-y'],
    });

    // Only 1 completed run — not enough (min 3).
    insertLoopRun();
    insertLease('lease-xy-1', 'composed-xy', 'completed');

    const result = intelligence.promoteComposedSkill('composed-xy');
    expect(result.promoted).toBe(false);
    expect(result.allAtomicValidated).toBe(true);
    expect(result.chainRuns).toBe(1);
  });

  it('promotes when all atomic skills are validated AND the chain has enough runs', () => {
    insertCapability('skill-p', 'validated');
    insertCapability('skill-q', 'validated');

    intelligence.createComposedSkill({
      id: 'composed-pq',
      name: 'P → Q',
      chain: ['skill-p', 'skill-q'],
    });

    // 3 completed runs — enough.
    insertLoopRun();
    insertLease('lease-pq-1', 'composed-pq', 'completed');
    insertLease('lease-pq-2', 'composed-pq', 'completed');
    insertLease('lease-pq-3', 'composed-pq', 'completed');

    const result = intelligence.promoteComposedSkill('composed-pq');
    expect(result.promoted).toBe(true);
    expect(result.allAtomicValidated).toBe(true);
    expect(result.chainRuns).toBe(3);

    const cap = intelligence.getCapability('composed-pq');
    expect(cap.status).toBe('validated');
  });
});
