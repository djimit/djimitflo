import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';

let db: Database.Database;
let svc: SwarmIntelligenceService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  svc = new SwarmIntelligenceService(db);
});

afterEach(() => { db?.close(); });

describe('G15.8 hypothesis workbench', () => {
  it('creates a hypothesis with evidence plan and stop condition', () => {
    const hyp = svc.createHypothesis({
      question: 'Is token bucket rate limiting sufficient for our API?',
      evidence_plan: ['benchmark:token_bucket', 'benchmark:sliding_window'],
      falsification_signal: 'sliding_window_outperforms_by_2x',
      stop_condition: 'benchmark_complete',
    });

    expect(hyp.id).toBeDefined();
    expect(hyp.question).toContain('token bucket');
    expect(hyp.projection_state).toBe('draft');
  });

  it('transitions hypothesis through testing to supported', () => {
    const hyp = svc.createHypothesis({
      question: 'Test hypothesis transitions',
      evidence_plan: ['test:evidence1'],
    });

    const testing = svc.transitionHypothesis(hyp.id, 'testing', ['test:evidence1']);
    expect(testing.projection_state).toBe('testing');

    const supported = svc.transitionHypothesis(hyp.id, 'supported', ['test:evidence1', 'test:evidence2']);
    expect(supported.projection_state).toBe('supported');
  });

  it('transitions hypothesis to falsified', () => {
    const hyp = svc.createHypothesis({
      question: 'Test falsification',
      falsification_signal: 'counterexample_found',
    });

    const falsified = svc.transitionHypothesis(hyp.id, 'falsified', ['counterexample:1']);
    expect(falsified.projection_state).toBe('falsified');
  });

  it('rejects invalid hypothesis state', () => {
    const hyp = svc.createHypothesis({ question: 'Test invalid state' });
    expect(() => svc.transitionHypothesis(hyp.id, 'invalid_state')).toThrow(/SWARM_HYPOTHESIS_STATE_INVALID/);
  });

  it('lists hypotheses', () => {
    svc.createHypothesis({ question: 'Hypothesis 1' });
    svc.createHypothesis({ question: 'Hypothesis 2' });
    const list = svc.listHypotheses();
    expect(list.length).toBe(2);
  });
});

describe('G15.7 concurrency slots', () => {
  it('sets and checks concurrency slots', () => {
    svc.setConcurrencySlot('codex', 'low', 3);
    expect(svc.checkConcurrencySlot('codex', 'low')).toMatchObject({ available: true, active: 0, max: 3 });
  });

  it('acquires and releases slots', () => {
    svc.setConcurrencySlot('opencode', 'medium', 2);
    expect(svc.acquireConcurrencySlot('opencode', 'medium')).toBe(true);
    expect(svc.acquireConcurrencySlot('opencode', 'medium')).toBe(true);
    expect(svc.acquireConcurrencySlot('opencode', 'medium')).toBe(false); // exhausted
    svc.releaseConcurrencySlot('opencode', 'medium');
    expect(svc.acquireConcurrencySlot('opencode', 'medium')).toBe(true); // released
  });

  it('returns unlimited for unset slots', () => {
    expect(svc.checkConcurrencySlot('mock', 'low')).toMatchObject({ available: true, max: Infinity });
  });
});

describe('G15.8 specialist profile versions', () => {
  it('retrieves profile version for known specialist', () => {
    const version = svc.getSpecialistProfileVersion('systems_architect');
    expect(version).toBeDefined();
    expect(typeof version).toBe('string');
  });

  it('returns default version for unknown specialist', () => {
    const version = svc.getSpecialistProfileVersion('unknown_specialist');
    expect(version).toBe('1.0.0');
  });
});
