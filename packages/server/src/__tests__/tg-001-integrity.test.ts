import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import type { FailureTask } from '../services/gym-failure-tasks';
import { writeTestHoldout } from '../services/genome-registry';
import { classifyTgFailure, cochranQ, chi2Sf, freezeTg001, recordTg001, sanitizeTgMetrics, tg001Evidence, tgInterpret, tgManifest, TG_ID, TG_MDE } from '../services/tg-001';

// TG-001 integrity addendum (operator 11-10, pre-data): one observation per (task, arm), infra-censoring, a frozen analysis
// manifest that the evidence refuses to analyse once edited or written late, Cochran's Q, prior exposure, UNKNOWN telemetry.
let db: Database.Database;
const NOW = '2026-10-11T12:00:00.000Z';
const FINDING = { id: 'f1', type: 'test_gap', severity: 'low', message: 'wN.ts exports parse() without a unit test.', evidence: 'scan', suggested_fix: 'Write the test.', metadata: { objective_mode: true } };

function seedTask(i: number): FailureTask {
  const runId = `run-${i}`;
  db.prepare('INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(runId, 'test-gap-loop', 'closed', 'completed', JSON.stringify([{ ...FINDING, file: `packages/server/src/services/w${i}.ts` }]), '{}', NOW, NOW);
  db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`lease-${i}`, runId, 'maker', 'remote', 'failed', 'f1', '{}', NOW, NOW);
  return { commit: `fail:${runId}`, kind: 'write_test', base: 'a'.repeat(40), source: `packages/server/src/__tests__/w${i}.test.ts`, tests: [`packages/server/src/__tests__/w${i}.test.ts`],
    target: `packages/server/src/services/w${i}.ts`, sourceLines: 10, run_id: runId, lane: 'exports', mutants: [{ key: `mut:a:w${i}:1:1`, content: 'x' }], oracle: 'o' };
}
function freeze(n = 10) {
  const tasks = Array.from({ length: n }, (_, i) => seedTask(i + 1));
  // task 1 had two earlier ordinary gym attempts (arm A goal)
  for (const k of [1, 2]) db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at, updated_at) VALUES (?, 'evolution-gym', 'closed', 'completed', ?, ?, ?)")
    .run(`prior-${k}`, JSON.stringify({ gym: { commit: tasks[0].commit } }), NOW, NOW);
  const r = freezeTg001(db, tasks, { checkoutPath: '/x', species: 'atomic@llama-router', commit: 'c0', harness: 'h0', prodGates: { lint: true }, reserved: new Set(), now: NOW });
  expect(r.frozen).toBe(true);
  return { tasks, manifest: r.manifest! };
}
/** settle one physical attempt of (task, arm) through the real bookkeeping */
function settle(task: string, arm: string, status: string, reason: string, at: string, metrics: unknown = {}) {
  const row = db.prepare("SELECT id FROM tg_attempts WHERE task_key = ? AND arm = ?").get(task, arm) as { id: string };
  const runId = `r-${task}-${arm}-${at}`;
  db.prepare("UPDATE tg_attempts SET status = 'claimed', run_id = ? WHERE id = ?").run(runId, row.id);
  recordTg001(db, row.id, runId, { status, reason, tg_metrics: metrics }, at);
}

beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

it('1: retries collapse into one observation; all-infra attempts are INFRA_CENSORED, counted per arm and kept out of paired tables', () => {
  const { manifest } = freeze();
  const t1 = manifest.tasks[0].key; const t2 = manifest.tasks[1].key;
  // t1/A: infra, then a real failure → ONE observation (failure), not two
  settle(t1, 'A', 'discarded', 'infra: npm ci failed', '2026-10-11T13:00:00Z');
  settle(t1, 'A', 'failure', 'tests still red', '2026-10-11T13:10:00Z');
  settle(t1, 'B', 'success', 'tests green, source only', '2026-10-11T13:20:00Z');
  // t2/B: three infra discards (1 + 2 retries) → censored
  for (const m of ['01', '02', '03']) settle(t2, 'B', 'discarded', 'infra: worker lost', `2026-10-11T14:${m}:00Z`);
  settle(t2, 'A', 'success', 'tests green, source only', '2026-10-11T14:30:00Z');
  const ev = tg001Evidence(db) as { arms: Array<{ arm: string; n: number; failure: number; infra_censored: number }>; paired: Array<{ n_pairs: number; excluded_tasks: number; infra_censored: number; discordant: number }> };
  expect(ev.arms.find((a) => a.arm === 'A')).toMatchObject({ n: 2, failure: 1, infra_censored: 0 });
  expect(ev.arms.find((a) => a.arm === 'B')).toMatchObject({ n: 1, infra_censored: 1 });
  expect(ev.paired[0]).toMatchObject({ n_pairs: 1, discordant: 1, excluded_tasks: 1, infra_censored: 1 }); // t2 excluded, not a failure
});

it('2: the analysis manifest is frozen with its fingerprint; an edited or late manifest makes the evidence refuse analysis', () => {
  const { manifest } = freeze();
  const a = manifest.analysis!;
  expect(a).toMatchObject({ experiment_id: 'tg-001', commit: 'c0', worker_version: 'h0', seed: manifest.seed, mde: TG_MDE });
  expect(a.task_ids).toHaveLength(10);
  expect(a.condition_order).toHaveLength(40);
  expect(Object.keys(a.prompt_fingerprints[a.task_ids[0]]).sort()).toEqual(['A', 'B', 'C', 'D']);
  expect(a.secondary.join(' ')).toMatch(/Cochran/);
  expect(tg001Evidence(db)).toMatchObject({ status: 'collecting' });
  // editing the plan after freeze (e.g. a new primary comparison) → refused
  const edited = { ...manifest, analysis: { ...a, primary: 'C vs D' } };
  db.prepare('UPDATE tg_experiments SET manifest_json = ? WHERE id = ?').run(JSON.stringify(edited), TG_ID);
  expect(tg001Evidence(db)).toMatchObject({ status: 'invalid_manifest', reason: 'analysis manifest changed after freeze' });
  // restoring the plan but backdating outcomes before the freeze (a plan written after the data) → refused
  db.prepare('UPDATE tg_experiments SET manifest_json = ? WHERE id = ?').run(JSON.stringify(manifest), TG_ID);
  settle(manifest.tasks[0].key, 'A', 'success', 'tests green, source only', '2026-10-11T11:00:00Z');
  expect(tg001Evidence(db)).toMatchObject({ status: 'invalid_manifest' });
  expect((tg001Evidence(db) as { reason: string }).reason).toMatch(/not written before the first physical attempt/);
  // a manifest without a plan (frozen before the addendum) is never analysed
  db.prepare('UPDATE tg_experiments SET manifest_json = ?, analysis_sha256 = NULL WHERE id = ?').run(JSON.stringify({ ...manifest, analysis: undefined }), TG_ID);
  expect(tg001Evidence(db)).toMatchObject({ status: 'invalid_manifest', reason: 'no frozen analysis manifest' });
});

it("3: Cochran's Q on a known table (chi-square df = 3)", () => {
  // rows = tasks, columns A B C D; column totals 5 1 4 4, N = 14, Σ row² = 42 → Q = 3·(4·58 − 196)/(56 − 42) = 7.714
  const t = [[1, 0, 1, 1], [1, 0, 0, 1], [1, 1, 1, 1], [1, 0, 1, 0], [0, 0, 0, 0], [1, 0, 1, 1]].map((r) => r.map(Boolean));
  const q = cochranQ(t);
  expect(q).toMatchObject({ k: 4, n_blocks: 6, q: 7.714, df: 3 });
  expect(q.p!).toBeCloseTo(0.0523, 3);
  expect(chi2Sf(7.815, 3)).toBeCloseTo(0.05, 3); // chi-square critical value df 3
  expect(chi2Sf(5.991, 2)).toBeCloseTo(0.05, 3);
  expect(cochranQ([[true, true, true, true], [false, false, false, false]])).toMatchObject({ q: 0, p: 1 });
});

it('4: prior exposure is in the plan, reported, labelled diagnostic, and TG tasks never become a promotion holdout', () => {
  const { tasks, manifest } = freeze();
  const pe = manifest.analysis!.prior_exposure[tasks[0].commit];
  expect(pe).toEqual({ prior_exposure: true, prior_attempt_count: 2, prior_condition_if_known: 'A' });
  expect(manifest.analysis!.prior_exposure[tasks[1].commit]).toEqual({ prior_exposure: false, prior_attempt_count: 0, prior_condition_if_known: null });
  expect(tg001Evidence(db)).toMatchObject({ prior_exposure: { exposed: 1, unexposed: 9, prior_attempts: 2 }, label: expect.stringMatching(/not a promotion holdout/) });
  const extra = Array.from({ length: 6 }, (_, i) => seedTask(i + 50));
  const holdout = writeTestHoldout(db, () => [...tasks, ...extra], NOW);
  expect(holdout.map((t) => t.commit).filter((k) => tasks.some((x) => x.commit === k))).toEqual([]);
  expect(holdout).toHaveLength(6);
});

it('5: unavailable telemetry stays null and renders UNKNOWN; TOOL_FAILURE needs observed tool calls; else UNKNOWN_FAILURE', () => {
  expect(sanitizeTgMetrics({ tool_calls: null, files_inspected: undefined, tokens: 'n/a' })).toMatchObject({ tool_calls: null, files_inspected: null, tokens: null });
  expect(classifyTgFailure('failure', 'no change (maker gave up)', { failed_tool_calls: null, tool_calls: null })).toBe('UNKNOWN_FAILURE');
  expect(classifyTgFailure('failure', 'something unexpected', {})).toBe('UNKNOWN_FAILURE');
  const { manifest } = freeze();
  settle(manifest.tasks[0].key, 'A', 'success', 'tests green, source only', '2026-10-11T13:00:00Z', { tool_calls: null, files_inspected: null });
  const a = (tg001Evidence(db) as { arms: Array<{ arm: string; tokens_mean: unknown; tool_calls: unknown; files_inspected: unknown }> }).arms.find((x) => x.arm === 'A')!;
  expect(a).toMatchObject({ tokens_mean: 'UNKNOWN', tool_calls: 'UNKNOWN', files_inspected: 'UNKNOWN' });
});

it('interpretation follows the frozen rules and stays pending until the data is complete', () => {
  expect(tgInterpret({ n_pairs: 20, effect: 0.35, ci95: [0.12, 0.58], mcnemar_exact_p: 0.008 }, true)).toMatchObject({ verdict: 'representation_supported', next_experiment: expect.stringMatching(/ablation/) });
  expect(tgInterpret({ n_pairs: 20, effect: 0.0, ci95: [-0.12, 0.12], mcnemar_exact_p: 1 }, true)).toMatchObject({ verdict: 'representation_rejected', next_experiment: expect.stringMatching(/40 vs 60/) });
  expect(tgInterpret({ n_pairs: 20, effect: 0.1, ci95: [-0.1, 0.3], mcnemar_exact_p: 0.4 }, true)).toMatchObject({ verdict: 'inconclusive' });
  expect(tgInterpret({ n_pairs: 20, effect: 0.35, ci95: [0.12, 0.58], mcnemar_exact_p: 0.008 }, false)).toMatchObject({ verdict: 'pending', falsified: null });
  freeze();
  expect((tg001Evidence(db) as { result: { verdict: string } }).result.verdict).toBe('pending');
  expect(tgManifest(db)!.analysis!.interpretation).toHaveLength(3);
});
