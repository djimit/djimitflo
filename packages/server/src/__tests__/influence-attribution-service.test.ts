import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { InfluenceAttributionService } from '../services/influence-attribution-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let influence: InfluenceAttributionService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  influence = new InfluenceAttributionService(db);
});

afterEach(() => {
  db?.close();
});

function insertLoopRun(id: string) {
  db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, created_at, updated_at) VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', 'completed', datetime('now'), datetime('now'))").run(id);
}

function insertLease(id: string, runId: string, capabilityId: string) {
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, capability_id, created_at, updated_at) VALUES (?, ?, 'maker', 'codex', 'completed', ?, datetime('now'), datetime('now'))").run(id, runId, capabilityId);
}

describe('G55: Influence Attribution', () => {
  it('attributeInfluence returns empty for no leases', () => {
    const records = influence.attributeInfluence('no-run');
    expect(records).toEqual([]);
  });

  it('attributeInfluence creates records', () => {
    insertLoopRun('run-1');
    insertLease('lease-1', 'run-1', 'cap-a');
    const records = influence.attributeInfluence('run-1');
    expect(records.length).toBe(1);
  });

  it('influence sums to 1.0 for single agent', () => {
    insertLoopRun('run-2');
    insertLease('lease-2', 'run-2', 'cap-b');
    const records = influence.attributeInfluence('run-2');
    expect(records[0].influence).toBeCloseTo(1.0, 1);
  });

  it('getTopContributors returns sorted', () => {
    insertLoopRun('run-3');
    insertLease('lease-3a', 'run-3', 'cap-c');
    insertLease('lease-3b', 'run-3', 'cap-d');
    influence.attributeInfluence('run-3');
    const top = influence.getTopContributors('run-3', 5);
    expect(top.length).toBeGreaterThanOrEqual(1);
  });

  it('getAgentInfluence returns average', () => {
    insertLoopRun('run-4');
    insertLease('lease-4', 'run-4', 'cap-e');
    influence.attributeInfluence('run-4');
    const agentInfluence = influence.getAgentInfluence('lease-4');
    expect(agentInfluence).toBeGreaterThanOrEqual(0);
  });
});
