import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MetacognitiveObserver } from '../services/metacognitive-observer';
import { SelfModelService } from '../services/self-model-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let observer: MetacognitiveObserver;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  const selfModel = new SelfModelService(db);
  observer = new MetacognitiveObserver(db, selfModel);
});

afterEach(() => {
  db?.close();
});

describe('G112: MetacognitiveObserver', () => {
  it('observes a run', () => {
    const obs = observer.observeRun('run-1');
    expect(obs.id).toBeDefined();
    expect(obs.runId).toBe('run-1');
    expect(obs.confidence).toBeGreaterThanOrEqual(0);
  });

  it('detects no anomalies for unknown run', () => {
    const anomalies = observer.detectAnomalies('unknown-run');
    expect(Array.isArray(anomalies)).toBe(true);
  });

  it('calibrates confidence', () => {
    const result = observer.calibrateConfidence('test-domain');
    expect(result.domain).toBe('test-domain');
    expect(result.trend).toMatch(/improving|stable|degrading/);
  });

  it('gets reasoning quality', () => {
    const quality = observer.getReasoningQuality('run-1');
    expect(quality.score).toBeGreaterThanOrEqual(0);
    expect(quality.score).toBeLessThanOrEqual(1);
  });

  it('gets observations by type', () => {
    observer.observeRun('run-2');
    const obs = observer.getObservationsByType('run_quality');
    expect(obs.length).toBe(1);
  });
});
