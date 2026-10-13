import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { RemoteGymService } from '../services/remote-gym-service';
import { infraFailing } from '../services/evolution-gym-service';
import { gymObservations } from '../services/gym-irt';
import type { FailureTask } from '../services/gym-failure-tasks';
import { TG_LOOP, TG_MDE, pairedTable, tangoInterval, tg001Evidence, tgGoChecklist, tgInterpret, tgManifest, tgVerdict } from '../services/tg-001';

/**
 * TG-001 FINAL PRE-RUN DIRECTIVE (B27, pre-data): the decision surface over every possible paired A/B table, isolation of TG
 * attempts by provenance, censoring by arm × execution position, and the strict plan-before-first-physical-attempt rule.
 */

type Verdict = 'representation_supported' | 'representation_rejected' | 'inconclusive';
function tableRows(a: number, b: number, c: number, d: number) {
  const rows: Array<{ task_key: string; arm: string; status: string }> = []; let i = 0;
  const add = (x: boolean, y: boolean) => { const k = `t${i++}`; rows.push({ task_key: k, arm: 'A', status: x ? 'success' : 'failure' }, { task_key: k, arm: 'B', status: y ? 'success' : 'failure' }); };
  for (let j = 0; j < a; j++) add(true, true); for (let j = 0; j < b; j++) add(true, false);
  for (let j = 0; j < c; j++) add(false, true); for (let j = 0; j < d; j++) add(false, false);
  return rows;
}
/** Every (both_success, A_only, B_only, both_fail) summing to n, through TG-001's own pairedTable + tgInterpret. */
function surface(n: number) {
  const out: Array<{ a: number; b: number; c: number; d: number; verdict: Verdict; effect: number; ci: number[]; p: number }> = [];
  for (let b = 0; b <= n; b++) for (let c = 0; c <= n - b; c++) for (let a = 0; a <= n - b - c; a++) {
    const t = pairedTable(tableRows(a, b, c, n - a - b - c), 'A', 'B');
    const v = tgInterpret(t, true).verdict as Verdict;
    out.push({ a, b, c, d: n - a - b - c, verdict: v, effect: t.raw!.effect, ci: t.raw!.ci95, p: t.raw!.mcnemar_exact_p });
  }
  return out;
}

it('decision surface n=20 and n=40: every verdict reachable, exactly one verdict per state, verdict depends only on (b, c)', () => {
  for (const n of [20, 40]) {
    const s = surface(n);
    expect(s.length).toBe(((n + 1) * (n + 2) * (n + 3)) / 6);
    const verdicts = new Set(s.map((r) => r.verdict));
    expect(verdicts).toEqual(new Set(['representation_supported', 'representation_rejected', 'inconclusive']));
    for (const r of s) {
      const supported = r.effect >= TG_MDE - 1e-12 && r.p < 0.05; const rejected = r.ci[1] < TG_MDE;
      expect(supported && rejected).toBe(false); // no contradictory state
      expect(r.verdict).toBe(supported ? 'representation_supported' : rejected ? 'representation_rejected' : 'inconclusive');
      expect(r.ci[0]).toBeLessThanOrEqual(r.effect); expect(r.ci[1]).toBeGreaterThanOrEqual(r.effect);
    }
    // McNemar and the score interval use only the discordant cells: the verdict cannot depend on how concordant pairs split
    const byDisc = new Map<string, Set<Verdict>>();
    for (const r of s) { const k = `${r.b},${r.c}`; byDisc.set(k, (byDisc.get(k) ?? new Set()).add(r.verdict)); }
    for (const v of byDisc.values()) expect(v.size).toBe(1);
  }
});

it('pre-data defect fixed: the interval never collapses at zero discordance and does not reject on a one-sided small count', () => {
  // the Wald interval gave [0, 0] here (zero width from 20 concordant pairs) — the score interval keeps the uncertainty
  const [lo, hi] = tangoInterval(0, 0, 20);
  expect(hi).toBeCloseTo(3.8416 / (20 + 3.8416), 3); expect(lo).toBeCloseTo(-hi, 6);
  // Wald: b = 4, c = 0 at n = 40 had upper bound 0.193 → REJECTED although A won 4 tasks and B none; score bound 0.231
  const t = pairedTable(tableRows(10, 4, 0, 26), 'A', 'B');
  expect(t.ci_method).toBe('tango score (paired)');
  expect(t.raw!.ci95[1]).toBeGreaterThan(TG_MDE);
  expect(tgInterpret(t, true).verdict).toBe('inconclusive');
});

it('boundaries behave as written: effect exactly 0.2 with p < 0.05 is SUPPORTED; upper bound exactly 0.2 is not REJECTED', () => {
  const t = pairedTable(tableRows(10, 8, 0, 22), 'A', 'B'); // n = 40, A − B = 8/40 = 0.2, exact McNemar p = 2/256
  expect(t.raw!.effect).toBeCloseTo(0.2, 12);
  expect(tgInterpret(t, true).verdict).toBe('representation_supported');
  expect(tgVerdict(0.1, [-0.05, 0.2], 0.5)).toBe('inconclusive');
  expect(tgVerdict(0.1, [-0.05, 0.19999], 0.5)).toBe('representation_rejected');
  expect(tgVerdict(0.19, [0.05, 0.4], 0.001)).toBe('inconclusive'); // significant but below the MDE
  // the verdict reads the unrounded values (rounded display may differ in the third decimal)
  expect(tgInterpret({ n_pairs: 40, effect: 0.2, ci95: [0, 0.2], mcnemar_exact_p: 0.05, raw: { effect: 0.2, ci95: [0, 0.19995], mcnemar_exact_p: 0.0499 } }, true).verdict).toBe('representation_supported');
});

let db: Database.Database;
const NOW = '2026-10-11T12:00:00.000Z';
function seedTask(i: number): FailureTask {
  const runId = `run-${i}`;
  const finding = { id: 'f1', type: 'test_gap', severity: 'low', file: `packages/server/src/services/w${i}.ts`, message: `w${i}.ts exports parse() without a unit test.`,
    evidence: 'scan', suggested_fix: `Write packages/server/src/__tests__/w${i}.test.ts.`, metadata: { objective_mode: true } };
  db.prepare('INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(runId, 'test-gap-loop', 'closed', 'completed', JSON.stringify([finding]), '{}', NOW, NOW);
  db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`lease-${i}`, runId, 'maker', 'remote', 'failed', 'f1', '{}', NOW, NOW);
  return { commit: `fail:${runId}`, kind: 'write_test', base: 'a'.repeat(40), source: `packages/server/src/__tests__/w${i}.test.ts`, tests: [`packages/server/src/__tests__/w${i}.test.ts`],
    target: `packages/server/src/services/w${i}.ts`, sourceLines: 10, run_id: runId, lane: 'exports', mutants: [{ key: `mut:a:w${i}:1:1`, content: 'x' }], oracle: 'o' };
}
const CAPS = { capabilities: ['write_test', 'prod_gates', 'prompt_override'] };
const SPECIES = 'atomic@llama-router';
let t0 = Date.parse(NOW);
const tick = () => new Date((t0 += 60_000));
function startTg(svc: RemoteGymService) {
  const freezing = svc.claim('workstation', [SPECIES], tick(), CAPS) as { runId?: string; tg?: unknown };
  expect(freezing.tg).toBeUndefined(); // the freezing claim starts no TG attempt
  if (freezing.runId) svc.record(freezing.runId, 'workstation', { status: 'discarded', reason: 'task: not part of the experiment' });
  expect(tgManifest(db)).not.toBeNull();
}
const tgClaim = (svc: RemoteGymService) => svc.claim('workstation', [SPECIES], tick(), CAPS) as { runId: string; tg: { arm: string }; task: FailureTask };

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  t0 = Date.parse(NOW);
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo-that-does-not-exist');
  vi.stubEnv('TG_001_MODE', 'on'); vi.stubEnv('GYM_PROD_GATES', 'true'); vi.stubEnv('GYM_FAILURE_TASKS_ENABLED', 'true');
  vi.stubEnv('GYM_STORE_DIFFS', 'true'); vi.stubEnv('GRADED_FITNESS_MODE', 'shadow'); vi.stubEnv('HACK_DETECTOR_MODE', 'shadow');
  vi.stubEnv('EVOLUTION_GYM_REMOTE_MAX_PER_DAY', '1000');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

it('isolation by provenance: TG attempts never reach skill outcomes, gym statistics, the breaker, IRT, the diff dataset, effort events, memory or model ledgers', () => {
  const svc = new RemoteGymService(db, () => []);
  const tasks = Array.from({ length: 12 }, (_, i) => seedTask(i + 1));
  svc.failureTasks = () => tasks;
  startTg(svc);
  const before = { outcomes: (db.prepare('SELECT COUNT(*) AS n FROM skill_outcomes').get() as { n: number }).n, obs: gymObservations(db).length };
  // a success with a diff, graded and hack-flag inputs, plus three infra discards (would bench the species if counted)
  const ok = tgClaim(svc);
  svc.record(ok.runId, 'workstation', { status: 'success', reason: 'tests green, source only', diff: 'diff --git a/x b/x\n+ok', changed_files: ['packages/server/src/__tests__/x.test.ts', 'README.md'], killed_mutants: [] });
  for (let i = 0; i < 3; i++) { const c = tgClaim(svc); svc.record(c.runId, 'workstation', { status: 'discarded', reason: 'infra: npm ci failed' }); }
  const tgRuns = db.prepare("SELECT loop_name, COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.gym.tg') IS NOT NULL GROUP BY 1").all();
  expect(tgRuns).toEqual([{ loop_name: TG_LOOP, n: 4 }]); // provenance: never an 'evolution-gym' run
  expect((db.prepare('SELECT COUNT(*) AS n FROM skill_outcomes').get() as { n: number }).n).toBe(before.outcomes); // bandit, fitness view, skill traits read these
  expect(gymObservations(db).length).toBe(before.obs); // IRT / difficulty
  expect(infraFailing(db, SPECIES, '1970-01-01')).toBe(false); // the ordinary gym breaker
  expect(db.prepare('SELECT COUNT(*) AS n FROM gym_attempt_diffs').get()).toEqual({ n: 0 }); // no promotion-ineligible copy in the training set
  const okRun = db.prepare("SELECT json_extract(metadata, '$.gym_result.diff_ref') AS ref FROM loop_runs WHERE id = ?").get(ok.runId) as { ref: string | null };
  expect(okRun.ref).toMatch(/^sha256:[0-9a-f]{64}$/); // the raw diff's fingerprint stays on the TG run itself
  expect(db.prepare("SELECT COUNT(*) AS n FROM loop_events WHERE loop_run_id IN (SELECT id FROM loop_runs WHERE loop_name = ?) AND event_type LIKE 'effort%'").get(TG_LOOP)).toEqual({ n: 0 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM memory_access_log').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM llm_model_calls').get()).toEqual({ n: 0 });
  // TG task keys stay reserved: never served as ordinary gym work, never part of a holdout freeze
  const plain = svc.claim('workstation', [SPECIES], tick(), { capabilities: ['write_test', 'prod_gates'] }) as { task?: FailureTask; skipped?: string };
  const tgKeys = new Set(tgManifest(db)!.tasks.map((t) => t.key));
  if (plain.task) expect(tgKeys.has(plain.task.commit)).toBe(false);
});

it('a run that loses its report settles its TG attempt as an infra discard instead of leaving it claimed', () => {
  const svc = new RemoteGymService(db, () => []);
  const tasks = Array.from({ length: 12 }, (_, i) => seedTask(i + 1)); svc.failureTasks = () => tasks;
  startTg(svc);
  const lost = tgClaim(svc); // the worker never reports; its next claim settles the lost run
  tgClaim(svc);
  const row = db.prepare('SELECT status, retries, history_json FROM tg_attempts WHERE history_json LIKE ?').get(`%${lost.runId}%`) as { status: string; retries: number; history_json: string };
  expect(row.retries).toBe(1); // re-queued (and, oldest seq first, already served again to the next claim)
  expect(['pending', 'claimed']).toContain(row.status);
  expect(JSON.parse(row.history_json)[0].reason).toMatch(/^infra: worker lost the result/);
});

it('censoring by arm × position; only infra discards are retried, semantic failures never', () => {
  const svc = new RemoteGymService(db, () => []);
  const tasks = Array.from({ length: 12 }, (_, i) => seedTask(i + 1)); svc.failureTasks = () => tasks;
  startTg(svc);
  const first = tgClaim(svc);
  const attempt = db.prepare('SELECT id, arm, seq FROM tg_attempts WHERE run_id = ?').get(first.runId) as { id: string; arm: string; seq: number };
  svc.record(first.runId, 'workstation', { status: 'discarded', reason: 'infra: npm ci failed' });
  for (let i = 0; i < 2; i++) { const c = tgClaim(svc); svc.record(c.runId, 'workstation', { status: 'discarded', reason: 'infra: npm ci failed' }); }
  // 3 physical attempts = the first + TG_MAX_INFRA_RETRIES (2) re-queues; all infra → INFRA_CENSORED
  const censored = db.prepare('SELECT status, history_json FROM tg_attempts WHERE id = ?').get(attempt.id) as { status: string; history_json: string };
  expect(censored.status).toBe('infra_exhausted');
  expect(JSON.parse(censored.history_json)).toHaveLength(3);
  const ev = tg001Evidence(db) as unknown as { censoring: Array<{ arm: string; by_position: number[] }>; order_effects: { positions: Array<{ position: number; infra_censored: number }> }; arms: Array<{ arm: string; infra_censored: number; failure: number }> };
  const pos = (attempt.seq % 4) + 1;
  expect(ev.censoring.find((c) => c.arm === attempt.arm)!.by_position[pos - 1]).toBe(1);
  expect(ev.order_effects.positions.find((p) => p.position === pos)!.infra_censored).toBe(1);
  expect(ev.arms.find((a) => a.arm === attempt.arm)).toMatchObject({ infra_censored: 1, failure: 0 }); // censored ≠ failure
  // a semantic failure is final: one observation, no retry; a task discard is INVALID, not re-queued
  const f = tgClaim(svc); svc.record(f.runId, 'workstation', { status: 'failure', reason: 'tests still red' });
  expect(db.prepare('SELECT status, retries FROM tg_attempts WHERE run_id = ?').get(f.runId)).toEqual({ status: 'done', retries: 0 });
  const t = tgClaim(svc); svc.record(t.runId, 'workstation', { status: 'discarded', reason: 'task: gap already closed' });
  expect(db.prepare('SELECT status, retries FROM tg_attempts WHERE run_id = ?').get(t.runId)).toEqual({ status: 'invalid', retries: 0 });
});

it('the plan must strictly predate the first physical attempt (a claim, not only a result); go-checklist records the freeze', () => {
  const svc = new RemoteGymService(db, () => []);
  const tasks = Array.from({ length: 12 }, (_, i) => seedTask(i + 1)); svc.failureTasks = () => tasks;
  startTg(svc);
  const m = tgManifest(db)!;
  const worker = m.harness?.split(':').pop() ?? null;
  const pre = tgGoChecklist(db, { commit: m.commit, build_id: 'b1', worker_sha256: worker }, process.env, NOW);
  expect(pre.checks).toMatchObject({ frozen: true, analysis_valid: true, plan_predates_first_attempt: true, no_attempt_yet: true });
  expect(pre.record).toMatchObject({ experiment_id: 'tg-001-r2', generation: 'r2', seed: m.seed, step_budget: 40, classifier_version: expect.any(String), model_router: SPECIES });
  expect(Object.keys(pre.record!.prompt_fingerprints).sort()).toEqual(['A', 'B', 'C', 'D']);
  expect(pre.go).toBe(m.harness !== null && m.commit !== null); // in this sandbox the checkout has no git head / worker file
  // a claim (no result yet) dated at or before the plan invalidates the analysis
  const c = tgClaim(svc);
  db.prepare('UPDATE tg_attempts SET first_claimed_at = ? WHERE run_id = ?').run(m.frozen_at, c.runId);
  expect(tg001Evidence(db)).toMatchObject({ status: 'invalid_manifest' });
  expect(tgGoChecklist(db, { commit: m.commit, build_id: 'b1', worker_sha256: worker }).checks.plan_predates_first_attempt).toBe(false);
});
