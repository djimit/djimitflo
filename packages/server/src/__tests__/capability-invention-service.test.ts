import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CapabilityInventionService } from '../services/capability-invention-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let invention: CapabilityInventionService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  invention = new CapabilityInventionService(db);
});

afterEach(() => {
  db?.close();
});

function insertLease(runId: string, capId: string, status: string, runtime: string = 'codex') {
  try { db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, created_at, updated_at) VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', 'completed', datetime('now'), datetime('now'))").run(runId); } catch { /* exists */ }
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, capability_id, created_at, updated_at) VALUES (?, ?, 'maker', ?, ?, ?, datetime('now'), datetime('now'))").run(`lease-${runId}-${capId}`, runId, runtime, status, capId);
}

describe('G64: Capability Invention', () => {
  it('returns empty when no trajectories', () => {
    const proposals = invention.analyzeTrajectories();
    expect(proposals).toEqual([]);
  });

  it('detects successful capability combinations', () => {
    for (let i = 0; i < 5; i++) {
      insertLease(`run-${i}`, 'ts-fix', 'completed');
      insertLease(`run-${i}`, 'lint-fix', 'completed');
    }
    const proposals = invention.analyzeTrajectories();
    expect(proposals.length).toBeGreaterThan(0);
  });

  it('filters low success rate combinations', () => {
    for (let i = 0; i < 5; i++) {
      insertLease(`run-fail-${i}`, 'ts-fix', 'failed');
      insertLease(`run-fail-${i}`, 'lint-fix', 'failed');
    }
    const proposals = invention.analyzeTrajectories();
    expect(proposals.length).toBe(0);
  });

  it('getProposedInventions returns only proposed', () => {
    for (let i = 0; i < 5; i++) {
      insertLease(`run-${i}`, 'ts-fix', 'completed');
      insertLease(`run-${i}`, 'lint-fix', 'completed');
    }
    invention.analyzeTrajectories();
    const proposed = invention.getProposedInventions();
    expect(proposed.length).toBeGreaterThan(0);
    for (const p of proposed) {
      expect(p.status).toBe('proposed');
    }
  });

  it('acceptInvention creates capability', () => {
    for (let i = 0; i < 5; i++) {
      insertLease(`run-${i}`, 'ts-fix', 'completed');
      insertLease(`run-${i}`, 'lint-fix', 'completed');
    }
    const proposals = invention.analyzeTrajectories();
    if (proposals.length > 0) {
      invention.acceptInvention(proposals[0].id);
      const cap = db.prepare('SELECT id FROM swarm_capabilities WHERE id = ?').get(proposals[0].name);
      expect(cap).toBeDefined();
    }
  });

  it('rejectInvention updates status', () => {
    for (let i = 0; i < 5; i++) {
      insertLease(`run-${i}`, 'ts-fix', 'completed');
      insertLease(`run-${i}`, 'lint-fix', 'completed');
    }
    const proposals = invention.analyzeTrajectories();
    if (proposals.length > 0) {
      invention.rejectInvention(proposals[0].id);
      const proposed = invention.getProposedInventions();
      expect(proposed.find(p => p.id === proposals[0].id)).toBeUndefined();
    }
  });

  it('requires minimum evidence', () => {
    insertLease('run-1', 'ts-fix', 'completed');
    insertLease('run-1', 'lint-fix', 'completed');
    const proposals = invention.analyzeTrajectories();
    expect(proposals.length).toBe(0);
  });

  it('proposal has component capabilities', () => {
    for (let i = 0; i < 5; i++) {
      insertLease(`run-${i}`, 'ts-fix', 'completed');
      insertLease(`run-${i}`, 'lint-fix', 'completed');
    }
    const proposals = invention.analyzeTrajectories();
    if (proposals.length > 0) {
      expect(proposals[0].componentCapabilities.length).toBeGreaterThanOrEqual(2);
    }
  });
});
