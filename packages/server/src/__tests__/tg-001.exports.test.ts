import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import {
  TG_PLAN_ID,
  TG_ID,
  TG_ARMS,
  TG_MDE,
  TG_ALPHA,
  TG_STEP_BUDGET,
  TG_CLASSIFIER_VERSION,
  TG_MAX_INFRA_RETRIES,
  TG_LABEL,
  canonicalJson,
  tgAnalysisPlan,
  tgAnalysisValidity,
  firstPhysicalAttempt,
} from '../services/tg-001';
import type { TgManifest, TgAnalysis } from '../services/tg-001';
import type { FailureTask } from '../services/gym-failure-tasks';

let db: Database.Database;
const NOW = '2026-10-11T12:00:00.000Z';
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

const fakeTask = (key: string, prior = 0): FailureTask => ({
  commit: key, kind: 'write_test', base: 'a'.repeat(40), source: `packages/server/src/__tests__/${key}.test.ts`,
  tests: [`packages/server/src/__tests__/${key}.test.ts`], target: `packages/server/src/services/${key}.ts`,
  sourceLines: 10, run_id: `run-${key}`, lane: 'exports', mutants: [{ key: `mut:${key}`, content: 'x' }], oracle: 'o',
});

function makeManifest(overrides: Partial<TgManifest> = {}): TgManifest {
  const tasks = [
    { key: 'k1', lane: 'exports', run_id: 'run-k1', base: 'b1', source: 's1', target: 't1', prior_gym_attempts: 0,
      prompt_sha256: Object.fromEntries(TG_ARMS.map((a) => [a, sha(`p-${a}-1`)])) as Record<typeof TG_ARMS[number], string>,
      prompts: Object.fromEntries(TG_ARMS.map((a) => [a, `prompt-${a}-1`])) as Record<typeof TG_ARMS[number], string>, task: fakeTask('k1') },
    { key: 'k2', lane: 'exports', run_id: 'run-k2', base: 'b2', source: 's2', target: 't2', prior_gym_attempts: 2,
      prompt_sha256: Object.fromEntries(TG_ARMS.map((a) => [a, sha(`p-${a}-2`)])) as Record<typeof TG_ARMS[number], string>,
      prompts: Object.fromEntries(TG_ARMS.map((a) => [a, `prompt-${a}-2`])) as Record<typeof TG_ARMS[number], string>, task: fakeTask('k2') },
  ];
  return {
    id: TG_ID, generation: 'r2', frozen_at: NOW, commit: 'c1', species: 'test-species', harness: 'worker-sha',
    evaluator: { oracle: 'oracle', prod_gates: { gate: true } },
    flags: {}, seed: 11_10_2026, arms: { A: 'MINIMAL_GYM', B: 'FULL_PRODUCTION', C: 'CONTROLLED_PRODUCTION', D: 'STRUCTURED_MINIMAL' },
    c_removed: ['ids', 'advisory', 'policy'], tasks, skipped: [], ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(schema);
  runMigrations(db);
});
afterEach(() => { db.close(); });

describe('tgAnalysisPlan', () => {
  it('builds an analysis with the plan id (not the generation), task fingerprints, prompt fingerprints and condition order', () => {
    const m = makeManifest();
    const schedule = [
      { seq: 0, task_key: 'k1', arm: 'A' as const },
      { seq: 1, task_key: 'k1', arm: 'B' as const },
      { seq: 2, task_key: 'k2', arm: 'C' as const },
      { seq: 3, task_key: 'k2', arm: 'D' as const },
    ];
    const plan = tgAnalysisPlan(m, schedule);
    expect(plan.experiment_id).toBe(TG_PLAN_ID);
    expect(plan.frozen_at).toBe(NOW);
    expect(plan.commit).toBe('c1');
    expect(plan.worker_version).toBe('worker-sha');
    expect(plan.task_ids).toEqual(['k1', 'k2']);
    expect(plan.task_fingerprints).toHaveProperty('k1');
    expect(plan.task_fingerprints).toHaveProperty('k2');
    expect(plan.task_fingerprints.k1).toBe(sha(canonicalJson(m.tasks[0].task)));
    expect(plan.prompt_fingerprints.k1).toEqual(m.tasks[0].prompt_sha256);
    expect(plan.seed).toBe(m.seed);
    expect(plan.condition_order).toEqual(schedule);
    expect(plan.mde).toBe(TG_MDE);
    expect(plan.alpha).toBe(TG_ALPHA);
    expect(plan.classifier_version).toBe(TG_CLASSIFIER_VERSION);
    expect(plan.step_budget).toBe(TG_STEP_BUDGET);
    expect(plan.label).toBe(TG_LABEL);
    expect(plan.interpretation.length).toBeGreaterThan(0);
  });

  it('sets prior_exposure from prior_gym_attempts and marks prior condition as arm A when exposed', () => {
    const m = makeManifest();
    const plan = tgAnalysisPlan(m, []);
    expect(plan.prior_exposure.k1).toEqual({ prior_exposure: false, prior_attempt_count: 0, prior_condition_if_known: null });
    expect(plan.prior_exposure.k2).toEqual({ prior_exposure: true, prior_attempt_count: 2, prior_condition_if_known: 'A' });
  });

  it('includes the retry and exclusion policies referencing TG_MAX_INFRA_RETRIES', () => {
    const plan = tgAnalysisPlan(makeManifest(), []);
    expect(plan.retry_policy).toContain(String(TG_MAX_INFRA_RETRIES));
    expect(plan.exclusion_policy.length).toBeGreaterThanOrEqual(2);
  });
});

describe('tgAnalysisValidity', () => {
  it('returns invalid when the manifest has no frozen analysis', () => {
    const m = makeManifest();
    const r = tgAnalysisValidity(db, m);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('no frozen analysis manifest');
  });

  it('returns invalid when no experiment row exists', () => {
    const m = makeManifest();
    m.analysis = tgAnalysisPlan(m, []);
    const r = tgAnalysisValidity(db, m);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('no stored analysis fingerprint');
  });

  it('returns invalid when the stored fingerprint does not match the manifest analysis', () => {
    const m = makeManifest();
    m.analysis = tgAnalysisPlan(m, []);
    db.prepare('INSERT INTO tg_experiments (id, frozen_at, manifest_json, analysis_sha256) VALUES (?, ?, ?, ?)')
      .run(m.id, m.frozen_at, '{}', 'wrong-fingerprint');
    const r = tgAnalysisValidity(db, m);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('analysis manifest changed after freeze');
  });

  it('returns invalid when frozen_at differs from the experiment row', () => {
    const m = makeManifest();
    m.analysis = tgAnalysisPlan(m, []);
    db.prepare('INSERT INTO tg_experiments (id, frozen_at, manifest_json, analysis_sha256) VALUES (?, ?, ?, ?)')
      .run(m.id, '2020-01-01T00:00:00.000Z', '{}', sha(canonicalJson(m.analysis)));
    const r = tgAnalysisValidity(db, m);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('analysis manifest frozen_at differs from the experiment row');
  });

  it('returns invalid when the analysis was not written before the first physical attempt', () => {
    const m = makeManifest();
    m.analysis = tgAnalysisPlan(m, []);
    const earlier = '2026-10-10T00:00:00.000Z';
    db.prepare('INSERT INTO tg_experiments (id, frozen_at, manifest_json, analysis_sha256) VALUES (?, ?, ?, ?)')
      .run(m.id, m.frozen_at, '{}', sha(canonicalJson(m.analysis)));
    db.prepare("INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at, first_claimed_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)")
      .run('att-1', m.id, 'k1', 'A', 0, m.frozen_at, earlier);
    const r = tgAnalysisValidity(db, m);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('not written before the first physical attempt');
  });

  it('returns valid when fingerprint and frozen_at match and the plan predates all attempts', () => {
    const m = makeManifest();
    m.analysis = tgAnalysisPlan(m, []);
    const later = '2026-10-12T00:00:00.000Z';
    db.prepare('INSERT INTO tg_experiments (id, frozen_at, manifest_json, analysis_sha256) VALUES (?, ?, ?, ?)')
      .run(m.id, m.frozen_at, '{}', sha(canonicalJson(m.analysis)));
    db.prepare("INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at, first_claimed_at) VALUES (?, ?, ?, ?, ?, 'claimed', 0, ?, ?)")
      .run('att-1', m.id, 'k1', 'A', 0, later, later);
    const r = tgAnalysisValidity(db, m);
    expect(r.valid).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('returns valid when no attempts exist yet', () => {
    const m = makeManifest();
    m.analysis = tgAnalysisPlan(m, []);
    db.prepare('INSERT INTO tg_experiments (id, frozen_at, manifest_json, analysis_sha256) VALUES (?, ?, ?, ?)')
      .run(m.id, m.frozen_at, '{}', sha(canonicalJson(m.analysis)));
    const r = tgAnalysisValidity(db, m);
    expect(r.valid).toBe(true);
    expect(r.reason).toBeNull();
  });
});

describe('firstPhysicalAttempt', () => {
  it('returns null when no attempts exist', () => {
    expect(firstPhysicalAttempt(db, 'no-such-experiment')).toBeNull();
  });

  it('returns the earliest first_claimed_at across all attempts', () => {
    db.prepare("INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at, first_claimed_at) VALUES (?, ?, ?, ?, ?, 'done', 0, ?, ?)")
      .run('a1', 'exp1', 'k1', 'A', 0, '2026-10-12T10:00:00.000Z', '2026-10-12T10:00:00.000Z');
    db.prepare("INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at, first_claimed_at) VALUES (?, ?, ?, ?, ?, 'done', 0, ?, ?)")
      .run('a2', 'exp1', 'k1', 'B', 1, '2026-10-12T09:00:00.000Z', '2026-10-12T09:00:00.000Z');
    expect(firstPhysicalAttempt(db, 'exp1')).toBe('2026-10-12T09:00:00.000Z');
  });

  it('considers history_json entries as well', () => {
    db.prepare("INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at, first_claimed_at, history_json) VALUES (?, ?, ?, ?, ?, 'done', 0, ?, ?, ?)")
      .run('a1', 'exp2', 'k1', 'A', 0, '2026-10-12T10:00:00.000Z', null, JSON.stringify([{ at: '2026-10-11T08:00:00.000Z' }]));
    expect(firstPhysicalAttempt(db, 'exp2')).toBe('2026-10-11T08:00:00.000Z');
  });

  it('picks the earliest across first_claimed_at and history entries', () => {
    db.prepare("INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at, first_claimed_at, history_json) VALUES (?, ?, ?, ?, ?, 'done', 0, ?, ?, ?)")
      .run('a1', 'exp3', 'k1', 'A', 0, '2026-10-12T10:00:00.000Z', '2026-10-12T09:00:00.000Z', JSON.stringify([{ at: '2026-10-12T09:30:00.000Z' }]));
    db.prepare("INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at, first_claimed_at, history_json) VALUES (?, ?, ?, ?, ?, 'done', 0, ?, ?, ?)")
      .run('a2', 'exp3', 'k1', 'B', 1, '2026-10-12T10:00:00.000Z', '2026-10-12T08:00:00.000Z', JSON.stringify([{ at: '2026-10-12T08:30:00.000Z' }]));
    expect(firstPhysicalAttempt(db, 'exp3')).toBe('2026-10-12T08:00:00.000Z');
  });

  it('returns null when attempts have no first_claimed_at and no history', () => {
    db.prepare("INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)")
      .run('a1', 'exp4', 'k1', 'A', 0, '2026-10-12T10:00:00.000Z');
    expect(firstPhysicalAttempt(db, 'exp4')).toBeNull();
  });

  it('returns undefined on a database error (missing table)', () => {
    db.exec('DROP TABLE tg_attempts');
    expect(firstPhysicalAttempt(db, 'exp1')).toBeUndefined();
  });
});