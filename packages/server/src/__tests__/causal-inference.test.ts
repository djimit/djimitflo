import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CausalInferenceService } from '../services/causal-inference-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let causal: CausalInferenceService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  causal = new CausalInferenceService(db);
});

afterEach(() => {
  db?.close();
});

describe('G43: Causal Inference', () => {
  it('records observations', () => {
    causal.recordObservation({ runtime: 'codex', capability_type: 'ts-fix' }, 1);
    causal.recordObservation({ runtime: 'codex', capability_type: 'ts-fix' }, 0);
    const pred = causal.predictIntervention({ runtime: 'codex' });
    expect(pred.evidence).toBe(2);
  });

  it('predicts with insufficient data returns default', () => {
    const pred = causal.predictIntervention({ runtime: 'codex' });
    expect(pred.predictedSuccessRate).toBe(0.5);
    expect(pred.confidence).toBeLessThan(0.2);
  });

  it('compares two runtimes', () => {
    for (let i = 0; i < 5; i++) causal.recordObservation({ runtime: 'codex', capability_type: 'ts-fix' }, 1);
    for (let i = 0; i < 5; i++) causal.recordObservation({ runtime: 'opencode', capability_type: 'ts-fix' }, 0);
    const comp = causal.compareRuntimes('ts-fix', 'codex', 'opencode');
    expect(comp.recommendation).toBe('codex');
    expect(comp.a.successRate).toBe(1);
    expect(comp.b.successRate).toBe(0);
  });

  it('comparison with no data returns defaults', () => {
    const comp = causal.compareRuntimes('unknown', 'codex', 'opencode');
    expect(comp.a.nRuns).toBe(0);
    expect(comp.b.nRuns).toBe(0);
  });

  it('prediction confidence increases with more data', () => {
    for (let i = 0; i < 3; i++) causal.recordObservation({ runtime: 'codex' }, 1);
    const low = causal.predictIntervention({ runtime: 'codex' });
    for (let i = 0; i < 10; i++) causal.recordObservation({ runtime: 'codex' }, 1);
    const high = causal.predictIntervention({ runtime: 'codex' });
    expect(high.evidence).toBeGreaterThan(low.evidence);
  });

  it('creates causal_observations table on construction', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='causal_observations'").all();
    expect(tables.length).toBe(1);
  });

  describe('G106: Intervention Logging', () => {
    it('logs an intervention', () => {
      const id = causal.logIntervention('Test change', { runtime: 'codex' }, 'Improve success rate');
      expect(id).toBeDefined();
    });

    it('records intervention outcome', () => {
      const id = causal.logIntervention('Test change', { runtime: 'codex' }, 'Improve success rate');
      causal.recordInterventionOutcome(id, 'Success rate improved', true);

      const history = causal.getInterventionHistory(10);
      expect(history.length).toBe(1);
      expect(history[0].success).toBe(true);
    });

    it('gets intervention history', () => {
      causal.logIntervention('Change A', { x: 1 }, 'Outcome A');
      causal.logIntervention('Change B', { x: 2 }, 'Outcome B');

      const history = causal.getInterventionHistory(10);
      expect(history.length).toBe(2);
    });

    it('calculates intervention accuracy', () => {
      const id1 = causal.logIntervention('Change 1', {}, 'Expected');
      const id2 = causal.logIntervention('Change 2', {}, 'Expected');
      causal.recordInterventionOutcome(id1, 'Actual', true);
      causal.recordInterventionOutcome(id2, 'Actual', false);

      const accuracy = causal.getInterventionAccuracy();
      expect(accuracy).toBe(0.5);
    });

    it('returns 0 accuracy when no outcomes recorded', () => {
      causal.logIntervention('Change', {}, 'Expected');
      const accuracy = causal.getInterventionAccuracy();
      expect(accuracy).toBe(0);
    });

    it('intervention has correct structure', () => {
      const id = causal.logIntervention('Test', { key: 'value' }, 'Expected outcome');
      const history = causal.getInterventionHistory(1);
      const record = history[0];

      expect(record.id).toBe(id);
      expect(record.description).toBe('Test');
      expect(record.changes).toEqual({ key: 'value' });
      expect(record.expectedOutcome).toBe('Expected outcome');
      expect(record.timestamp).toBeDefined();
    });
  });
});
