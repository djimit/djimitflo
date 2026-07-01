import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SelfModelService } from '../services/self-model-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let selfModel: SelfModelService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  ensureConfidenceColumn();
  selfModel = new SelfModelService(db);
});

afterEach(() => {
  db?.close();
});

function ensureConfidenceColumn() {
  try {
    db.exec('ALTER TABLE worker_leases ADD COLUMN confidence REAL DEFAULT 0.5');
  } catch { /* column may already exist in newer schemas */ }
}

function insertCapability(id: string, status: string = 'validated') {
  db.prepare(`
    INSERT INTO swarm_capabilities (
      id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
      allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score,
      eval_threshold, cost_model_json, removal_strategy, latest_validation_report,
      metadata, created_at, updated_at
    ) VALUES (?, 'skill', 'test', '0.1', ?, 'low', 'none', 'none',
      '["spawn_runtime_worker"]', '["deploy"]', '["proof:test"]', 0, 0.5, '{}', 'demote_on_fail', null, '{}', datetime('now'), datetime('now'))
  `).run(id, status);
}

function insertWorkerLease(capabilityId: string, status: string, confidence: number = 0.5) {
  const runId = `run-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(`
    INSERT INTO loop_runs (id, loop_name, mode, status, created_at, updated_at)
    VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', 'completed', datetime('now'), datetime('now'))
  `).run(runId);
  db.prepare(`
    INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, capability_id, confidence, created_at, updated_at)
    VALUES (?, ?, 'maker', 'codex', ?, ?, ?, datetime('now'), datetime('now'))
  `).run(`lease-${Math.random().toString(36).slice(2, 10)}`, runId, status, capabilityId, confidence);
}

describe('G35: Self-Model Service', () => {
  it('calibration with perfect predictions has low error', () => {
    insertCapability('cap-perfect');
    for (let i = 0; i < 10; i++) {
      insertWorkerLease('cap-perfect', 'completed', 0.9);
    }
    const cal = selfModel.calibrate('cap-perfect');
    expect(cal.nRuns).toBe(10);
    expect(cal.observedSuccessRate).toBe(1);
    expect(cal.calibrationError).toBeLessThan(0.15);
  });

  it('calibration with overconfident predictions has high error', () => {
    insertCapability('cap-overconfident');
    for (let i = 0; i < 10; i++) {
      insertWorkerLease('cap-overconfident', 'failed', 0.9);
    }
    const cal = selfModel.calibrate('cap-overconfident');
    expect(cal.calibrationError).toBeGreaterThan(0.3);
  });

  it('calibration with insufficient data returns defaults', () => {
    insertCapability('cap-empty');
    const cal = selfModel.calibrate('cap-empty');
    expect(cal.nRuns).toBe(0);
    expect(cal.recommendedConfidence).toBe(0.5);
    expect(cal.confidenceBins).toEqual([]);
  });

  it('known unknowns detected for low nRuns', () => {
    insertCapability('cap-new');
    insertWorkerLease('cap-new', 'completed');
    const unknowns = selfModel.getKnownUnknowns();
    const found = unknowns.find(u => u.domain === 'cap-new');
    expect(found).toBeDefined();
    expect(found!.reason).toContain('insufficient_data');
  });

  it('known unknowns detected for high calibration error', () => {
    insertCapability('cap-bad');
    for (let i = 0; i < 10; i++) {
      insertWorkerLease('cap-bad', i < 3 ? 'completed' : 'failed', 0.95);
    }
    const unknowns = selfModel.getKnownUnknowns();
    const found = unknowns.find(u => u.domain === 'cap-bad');
    expect(found).toBeDefined();
  });

  it('trend detection: improving', () => {
    insertCapability('cap-improving');
    const outcomes = ['failed', 'failed', 'failed', 'failed', 'failed', 'completed', 'completed', 'completed', 'completed', 'completed'];
    for (const status of outcomes) {
      insertWorkerLease('cap-improving', status);
    }
    const trend = selfModel.detectTrend('cap-improving');
    expect(trend).toBe('improving');
  });

  it('trend detection: degrading', () => {
    insertCapability('cap-degrading');
    const outcomes = ['completed', 'completed', 'completed', 'completed', 'completed', 'failed', 'failed', 'failed', 'failed', 'failed'];
    for (const status of outcomes) {
      insertWorkerLease('cap-degrading', status);
    }
    const trend = selfModel.detectTrend('cap-degrading');
    expect(trend).toBe('degrading');
  });

  it('trend detection: stable', () => {
    insertCapability('cap-stable');
    const outcomes = ['completed', 'failed', 'completed', 'failed', 'completed', 'failed', 'completed', 'failed', 'completed', 'failed'];
    for (const status of outcomes) {
      insertWorkerLease('cap-stable', status);
    }
    const trend = selfModel.detectTrend('cap-stable');
    expect(trend).toBe('stable');
  });

  it('snapshot persistence', () => {
    insertCapability('cap-snap');
    insertWorkerLease('cap-snap', 'completed');
    selfModel.snapshot();
    const row = db.prepare('SELECT COUNT(*) as c FROM self_model_snapshots').get() as { c: number };
    expect(row.c).toBe(1);
  });

  it('getModel returns full model', () => {
    insertCapability('cap-model');
    insertWorkerLease('cap-model', 'completed');
    const model = selfModel.getModel();
    expect(model.version).toBeGreaterThan(0);
    expect(model.lastUpdated).toBeDefined();
    expect(model.capabilityCalibration['cap-model']).toBeDefined();
    expect(Array.isArray(model.knownUnknowns)).toBe(true);
  });

  it('recommended confidence is between 0 and 1', () => {
    insertCapability('cap-range');
    for (let i = 0; i < 10; i++) {
      insertWorkerLease('cap-range', i < 7 ? 'completed' : 'failed', 0.7);
    }
    const cal = selfModel.calibrate('cap-range');
    expect(cal.recommendedConfidence).toBeGreaterThanOrEqual(0);
    expect(cal.recommendedConfidence).toBeLessThanOrEqual(1);
  });

  it('empty database returns empty model', () => {
    const model = selfModel.getModel();
    expect(Object.keys(model.capabilityCalibration)).toHaveLength(0);
    expect(model.knownUnknowns).toEqual([]);
  });

  it('multiple capabilities get separate calibrations', () => {
    insertCapability('cap-a');
    insertCapability('cap-b');
    for (let i = 0; i < 5; i++) {
      insertWorkerLease('cap-a', 'completed', 0.9);
      insertWorkerLease('cap-b', 'failed', 0.9);
    }
    const model = selfModel.getModel();
    expect(model.capabilityCalibration['cap-a'].observedSuccessRate).toBe(1);
    expect(model.capabilityCalibration['cap-b'].observedSuccessRate).toBe(0);
  });

  it('confidence bins are correctly populated', () => {
    insertCapability('cap-bins');
    for (let i = 0; i < 10; i++) {
      insertWorkerLease('cap-bins', 'completed', 0.95);
    }
    const cal = selfModel.calibrate('cap-bins');
    const highBin = cal.confidenceBins.find(b => b.bin === 9);
    expect(highBin).toBeDefined();
    expect(highBin!.count).toBe(10);
    expect(highBin!.observedAccuracy).toBe(1);
  });

  it('trend is stable with fewer than 3 runs', () => {
    insertCapability('cap-few');
    insertWorkerLease('cap-few', 'completed');
    const trend = selfModel.detectTrend('cap-few');
    expect(trend).toBe('stable');
  });
});
