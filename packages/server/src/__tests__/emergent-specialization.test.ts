import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { EmergentSpecializationService } from '../services/emergent-specialization-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { WorkerLeaseRepo } from '../services/loop-worker-lease-repo';

let db: Database.Database;
let service: EmergentSpecializationService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  service = new EmergentSpecializationService(db);
});

afterEach(() => {
  db?.close();
});

describe('G104: Emergent Specialization', () => {
  it('records performance', () => {
    service.recordPerformance('agent-1', 'physics', 'quantum', true);
    const specs = service.getSpecializations('agent-1');
    expect(specs.length).toBe(1);
    expect(specs[0].nRuns).toBe(1);
  });

  it('calculates success rate', () => {
    service.recordPerformance('agent-1', 'physics', 'quantum', true);
    service.recordPerformance('agent-1', 'physics', 'quantum', false);
    service.recordPerformance('agent-1', 'physics', 'quantum', true);

    const specs = service.getSpecializations('agent-1');
    expect(specs[0].successRate).toBeCloseTo(0.67, 1);
  });

  it('promotes to established after threshold', () => {
    for (let i = 0; i < 5; i++) {
      service.recordPerformance('agent-1', 'physics', 'quantum', true);
    }

    const specs = service.getSpecializations('agent-1', 'established');
    expect(specs.length).toBe(1);
  });

  it('prunes low performance', () => {
    for (let i = 0; i < 10; i++) {
      service.recordPerformance('agent-1', 'physics', 'quantum', false);
    }

    const specs = service.getSpecializations('agent-1', 'pruned');
    expect(specs.length).toBe(1);
  });

  it('gets established specializations', () => {
    for (let i = 0; i < 5; i++) {
      service.recordPerformance('agent-1', 'physics', 'quantum', true);
    }

    const established = service.getEstablishedSpecializations();
    expect(established.length).toBe(1);
  });

  it('detects cross-domain transfer', () => {
    for (let i = 0; i < 5; i++) {
      service.recordPerformance('agent-1', 'physics', 'quantum', true);
      service.recordPerformance('agent-1', 'math', 'algebra', true);
    }

    const transfers = service.detectCrossDomainTransfer();
    expect(transfers.length).toBeGreaterThan(0);
  });

  it('recommends agent for domain', () => {
    for (let i = 0; i < 5; i++) {
      service.recordPerformance('agent-1', 'physics', 'quantum', true);
    }

    const rec = service.getRecommendation('agent-1', 'physics');
    expect(rec).toContain('agent-1');
    expect(rec).toContain('physics');
  });

  it('returns no specialization for unknown agent', () => {
    const specs = service.getSpecializations('unknown-agent');
    expect(specs).toEqual([]);
  });

  it('updates existing specialization', () => {
    service.recordPerformance('agent-1', 'physics', 'quantum', true);
    service.recordPerformance('agent-1', 'physics', 'quantum', true);

    const specs = service.getSpecializations('agent-1');
    expect(specs.length).toBe(1);
    expect(specs[0].nRuns).toBe(2);
  });

  it('learns once when a worker lease reaches a terminal result', () => {
    db.prepare(`INSERT INTO loop_runs
      (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata)
      VALUES ('run-specialist', 'doc_drift', 'closed', 'running', '[]', '{}', '[]', '[]', '{}')`).run();
    db.prepare(`INSERT INTO worker_leases
      (id, loop_run_id, role, runtime, status, capability_id, metadata, created_at, updated_at)
      VALUES ('lease-specialist', 'run-specialist', 'maker', 'codex', 'running', 'debugging', '{"agent_id":"agent-codex"}', datetime('now'), datetime('now'))`).run();
    const leases = new WorkerLeaseRepo(db);
    leases.updateStatus('lease-specialist', 'completed');
    leases.updateStatus('lease-specialist', 'completed');
    expect(service.getSpecializations('agent-codex')).toEqual([
      expect.objectContaining({ domain: 'debugging', subDomain: 'maker', nRuns: 1, successRate: 1 }),
    ]);
  });
});
