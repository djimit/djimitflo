import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { LoopPlanningService } from '../services/loop-planning-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { SelfModelService } from '../services/self-model-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let planning: LoopPlanningService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  const intelligence = new SwarmIntelligenceService(db);
  const selfModel = new SelfModelService(db);
  planning = new LoopPlanningService(db, intelligence, selfModel);
});

afterEach(() => {
  db?.close();
});

describe('G108: LoopPlanningService', () => {
  it('selects runtime for capability', () => {
    const runtime = planning.selectRuntimeForCapability('unknown-cap');
    expect(['codex', 'opencode']).toContain(runtime);
  });

  it('discovers findings', () => {
    const findings = planning.discoverFindings('doc-drift-and-small-fix-loop', '.', 5);
    expect(Array.isArray(findings)).toBe(true);
  });

  it('gets loop contract', () => {
    const contract = planning.getLoopContract('doc-drift-and-small-fix-loop');
    expect(contract.name).toBe('doc-drift-and-small-fix-loop');
    expect(contract.trigger.length).toBeGreaterThan(0);
  });

  it('returns unknown contract for unknown loop', () => {
    const contract = planning.getLoopContract('unknown-loop');
    expect(contract.trigger).toEqual([]);
  });

  it('gets available runtimes', () => {
    const runtimes = planning.getAvailableRuntimes();
    expect(runtimes).toContain('codex');
    expect(runtimes).toContain('mock');
  });

  it('gets capability coverage', () => {
    const coverage = planning.getCapabilityCoverage();
    expect(typeof coverage).toBe('object');
  });
});
