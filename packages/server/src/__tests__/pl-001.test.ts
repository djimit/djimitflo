import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { RemoteGymService } from '../services/remote-gym-service';
import { infraFailing, triedTasks } from '../services/evolution-gym-service';
import { gymObservations } from '../services/gym-irt';
import { exclusionReason, holdoutExclusions } from '../services/holdout-exposure';
import { strategyGenomeFor } from '../services/genome-registry';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { PROCEDURE_ID, PROCEDURE_LINES, linesSha256, procedure } from '../services/procedure-selector';
import type { GymTask } from '../services/gym-task-miner';
import {
  PL_LINES_SHA256, PL_LOOP, PL_NO_LINES_SHA256, PL_PAIRS, PL_TASKS, PL_UNFIT, applyPl001Lifecycle, claimPl001, firstArm, freezePl001, orderSha, pl001Evidence, plClaimMeta, plGoChecklist,
  plGoal, plManifest, plManifestSha, plManifestValidity, plPaired, plSelectorCheck, plState, plVoid, type PlManifest,
} from '../services/pl-001';

/**
 * PL-001 runner (docs/research/procedure-loop/PL-001_PROTOCOL.md): freeze, paired order, delivery + fire check per arm,
 * isolation by provenance, the oracle verdict, the analysis and stop rule, the lifecycle decision and the off mode.
 */
type Worker = { makerInput: (claim: unknown, task: unknown, writeTest: boolean, lines?: string[]) => string; fireCheck: (sent: string, lines?: string[]) => Record<string, unknown>; gymGoal: (task: unknown, writeTest: boolean, lines?: string[]) => string };
let worker: Worker;
const SPECIES = 'atomic@llama-router';
const CAPS = { capabilities: ['canary', 'write_test', 'prod_gates', 'prompt_override', 'procedure_lines'] };
const mut = (i: number, source = `packages/server/src/services/s${i}.ts`): GymTask => ({ commit: `mut:bbbbbbbbbbbb:${source}:3:${i}`, base: 'b'.repeat(40), source,
  tests: [`packages/server/src/__tests__/s${i}.test.ts`], sourceLines: 40, mutant: `export const s${i} = ${i} - 1;\n`, tier: 3 + (i % 4) } as GymTask);
const fresh = () => { const d = new Database(':memory:'); d.pragma('foreign_keys = OFF'); d.exec(schema); runMigrations(d); return d; };
let db: Database.Database;
let t0 = Date.now() - 3_600_000;
const tick = () => new Date((t0 += 1_000));
type Claim = { runId: string; task: GymTask; genome?: { id: string; lines: string[] }; pl?: { experiment: string; arm: 'A' | 'B' }; prod_gates?: unknown; skipped?: string };

beforeEach(async () => {
  worker = await import(path.resolve(__dirname, '../../../../scripts/gym-worker.mjs')) as Worker;
  db = fresh(); t0 = Date.now() - 3_600_000;
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo-that-does-not-exist');
  vi.stubEnv('GYM_PROD_GATES', 'true'); vi.stubEnv('PL_001_MODE', 'on'); vi.stubEnv('EVOLUTION_GYM_REMOTE_MAX_PER_DAY', '1000');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const service = (d: Database.Database, candidates: GymTask[]) => { const svc = new RemoteGymService(d, () => []); svc.plCandidates = () => candidates; return svc; };
const pool = (n = 100) => Array.from({ length: n }, (_, i) => mut(i + 1));
function start(svc: RemoteGymService): PlManifest {
  const freezing = svc.claim('workstation', [SPECIES], tick(), CAPS) as Claim;
  expect(freezing.pl).toBeUndefined(); // the freezing claim starts no PL attempt
  const m = plManifest(db);
  expect(m).not.toBeNull();
  return m!;
}
const plClaim = (svc: RemoteGymService) => svc.claim('workstation', [SPECIES], tick(), CAPS) as Claim;
/** what the real worker reports for this claim (fire check over the exact input it would send) */
const fire = (c: Claim) => { const lines = Array.isArray(c.genome?.lines) ? c.genome!.lines : []; return worker.fireCheck(worker.makerInput(c, c.task, false, lines), lines); };
const success = (c: Claim, over: Record<string, unknown> = {}) => ({ status: 'success' as const, reason: 'tests green, source only', changed_files: [c.task.source], diff: `diff --git a/${c.task.source} b/${c.task.source}\n-a\n+b`,
  prod_gates: { diff_limit: 'pass', lint: 'pass' }, fire_check: fire(c), tokens: 1234, durationMs: 9_000, tg_metrics: { maker_ms: 5_000, termination: 'exit:0' }, ...over });
const failure = (c: Claim, over: Record<string, unknown> = {}) => ({ status: 'failure' as const, reason: 'tests still red', changed_files: [c.task.source], diff: 'diff --git a/x b/x\n+c', fire_check: fire(c), durationMs: 8_000, ...over });
const attempt = (runId: string) => db.prepare('SELECT task_key, arm, status, retries, result_json, history_json FROM pl_attempts WHERE run_id = ? OR history_json LIKE ?').get(runId, `%${runId}%`) as
  { task_key: string; arm: string; status: string; retries: number; result_json: string | null; history_json: string | null };

it('plGoal is exactly the worker gym goal + newline; the protocol lines are the registry lines', () => {
  const task = mut(1);
  expect(plGoal(task, [])).toBe(`${worker.gymGoal(task, false, [])}\n`);
  expect(plGoal(task, PROCEDURE_LINES)).toBe(`${worker.gymGoal(task, false, [...PROCEDURE_LINES])}\n`);
  expect(plGoal(task, PROCEDURE_LINES)).toBe(worker.makerInput({ genome: { lines: PROCEDURE_LINES } }, task, false, [...PROCEDURE_LINES]));
  expect(linesSha256(PROCEDURE_LINES)).toBe(PL_LINES_SHA256);
});

it('pre-start selector check: at least 10 seeded unfit tasks, every one does_not_apply on the clause it was built for', () => {
  expect(procedure(db, PROCEDURE_ID)).toBeNull(); // nothing is seeded before a freeze or the selector
  const check = plSelectorCheck({ task_kinds: ['repair'], lanes: ['gym-repair'], file_patterns: ['packages/server/src/services/**/*.ts'], required_capabilities: ['prod_gates'], exclusions: ['**/__tests__/**', '**/*.test.ts', '**/*.d.ts', '**/*.generated.ts'] });
  expect(check.n).toBeGreaterThanOrEqual(10);
  expect(check).toMatchObject({ ok: true, applies: [], does_not_apply: PL_UNFIT.length });
  for (const r of check.results) expect(r.failed_clause, r.name).toBe(r.expected_clause);
  // one `applies` stops the start: a contract that accepts JS files lets the JS task through
  expect(plSelectorCheck({ task_kinds: ['repair'], lanes: ['gym-repair'], file_patterns: ['packages/server/src/services/**'], required_capabilities: ['prod_gates'], exclusions: [] }).ok).toBe(false);
});

it('freeze: 75 applicable tasks, never a holdout, TG-001, trial-attempted, dream-exposed or earlier gym key; ordered by sha256; manifest fingerprint stable', () => {
  const tasks = pool(110);
  const iso = new Date(t0).toISOString();
  db.prepare('INSERT INTO gym_holdout (commit_sha, created_at) VALUES (?, ?)').run(tasks[0].commit, iso);
  db.prepare('INSERT INTO gym_mutant_holdout (key, task_json, created_at) VALUES (?, ?, ?)').run(tasks[1].commit, '{}', iso);
  db.prepare('INSERT INTO gym_write_test_holdout (key, task_json, created_at) VALUES (?, ?, ?)').run(tasks[2].commit, '{}', iso);
  db.prepare("INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at) VALUES ('t1', 'tg-001-r2', ?, 'A', 0, 'done', 0, ?)").run(tasks[3].commit, iso);
  const run = (id: string, gym: Record<string, unknown>, result: Record<string, unknown>, at = iso) => db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at, updated_at) VALUES (?, 'evolution-gym', 'closed', 'completed', ?, ?, ?)")
    .run(id, JSON.stringify({ gym, gym_result: result }), at, at);
  run('r-trial', { commit: tasks[4].commit, genome: 'g1', species: SPECIES }, { status: 'failure', reason: 'tests still red' });
  run('r-prior', { commit: tasks[5].commit, species: SPECIES }, { status: 'success', reason: 'ok' });
  // a dream genome exposed the source file of tasks[6] (a gym failure in the 24 h before it was dreamt)
  run('r-dream', { commit: 'mined-x', source: tasks[6].source, species: SPECIES }, { status: 'failure', reason: 'tests still red' }, new Date(t0 - 3_600_000).toISOString());
  db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES ('g-dream', 'baseline', 'strategy_lines', '[]', 'dream', 'retired', ?, ?)").run(iso, iso);
  const unfit = [mut(900, 'packages/server/src/services/x.js'), mut(901, 'packages/server/src/__tests__/x.test.ts'), { ...mut(902), kind: 'write_test' } as GymTask];
  const m = start(service(db, [...tasks, ...unfit]));
  const banned = new Set([...tasks.slice(0, 7).map((t) => t.commit), ...unfit.map((t) => t.commit)]);
  expect(m.tasks).toHaveLength(PL_TASKS);
  expect(m.tasks.filter((t) => banned.has(t.key))).toEqual([]);
  expect(m.pool.excluded).toMatchObject({ 'already frozen in a holdout epoch': 3, 'TG-001 task key': 1, 'attempted in a genome trial': 1, 'earlier evolution-gym attempt': 1, 'dream-exposed source file': 1 });
  expect(Object.entries(m.pool.excluded).filter(([k]) => k.startsWith('does_not_apply')).reduce((a, [, n]) => a + n, 0)).toBe(3);
  // ordered by sha256('pl-001:' + key), and those are the first 75 of every eligible key
  const eligible = [...tasks, ...unfit].filter((t) => !banned.has(t.commit)).map((t) => t.commit).sort((a, b) => (orderSha(a) < orderSha(b) ? -1 : 1));
  expect(m.tasks.map((t) => t.key)).toEqual(eligible.slice(0, PL_TASKS));
  expect(m.procedure).toMatchObject({ id: PROCEDURE_ID, version: 1, lines_sha256: PL_LINES_SHA256, lines: [...PROCEDURE_LINES] });
  expect(m.tasks.every((t) => t.mutant_sha256 && t.base === 'b'.repeat(40) && t.kind === 'mutant')).toBe(true);
  // the fingerprint is stored with the freeze and recomputes; the same inputs at the same time freeze the same manifest
  expect(plManifestValidity(db, m)).toEqual({ valid: true, reason: null });
  const ctx = { species: SPECIES, commit: 'c'.repeat(40), harness: 'scripts/gym-worker.mjs@sha256:abc', prodGates: { scripts: ['lint'] }, now: m.frozen_at };
  const twice = [fresh(), fresh()];
  try {
    const [x, y] = twice.map((d) => freezePl001(d, pool(110).reverse(), ctx, { ...process.env }).manifest!);
    expect(plManifestSha(x)).toBe(plManifestSha(y));
    expect(x.tasks.map((t) => t.key)).toEqual(pool(110).map((t) => t.commit).sort((a, b) => (orderSha(a) < orderSha(b) ? -1 : 1)).slice(0, PL_TASKS)); // input order does not matter
    expect(freezePl001(twice[0], pool(5), ctx).manifest).toEqual(x); // frozen once: a later freeze returns the stored manifest
  } finally { for (const d of twice) d.close(); }
  // an edited manifest is not analysed and serves nothing
  db.prepare("UPDATE pl_experiments SET manifest_json = json_set(manifest_json, '$.tasks[0].tier', 9)").run();
  expect(plManifestValidity(db, plManifest(db)!)).toMatchObject({ valid: false, reason: 'manifest changed after freeze' });
  expect(claimPl001(db, plManifest(db)!, 'r', new Date().toISOString())).toBeNull();
});

it('freeze refused: too few applicable tasks or a procedure row with another digest freezes nothing; the reason is evidence', () => {
  service(db, pool(30)).claim('workstation', [SPECIES], tick(), CAPS);
  expect(plManifest(db)).toBeNull();
  const ev = pl001Evidence(db, process.env);
  expect(ev).toMatchObject({ status: 'not_frozen', manifest: null, primary: null, arms: [], freeze_refused: { reason: `only 30 applicable, unexposed tasks (need ${PL_TASKS})` } });
  const d = fresh();
  try {
    d.prepare(`INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, note, created_at, updated_at, evidence_sources_json)
      VALUES (?, NULL, 'procedure', '["another line"]', 'procedure', 'candidate', '', 'x', 'x', ?)`).run(PROCEDURE_ID, JSON.stringify({ procedure: { version: 1, applicability: { task_kinds: ['repair'], lanes: ['gym-repair'], file_patterns: ['packages/server/src/services/**/*.ts'], required_capabilities: ['prod_gates'], exclusions: [] } } }));
    const svc = new RemoteGymService(d, () => []); svc.plCandidates = () => pool(100);
    svc.claim('workstation', [SPECIES], tick(), CAPS);
    expect(plManifest(d)).toBeNull();
    expect(pl001Evidence(d, process.env).freeze_refused?.reason).toMatch(/^procedure lines digest .* is not the protocol's/);
  } finally { d.close(); }
});

it('paired order: per task the first arm is fixed by sha256 parity, recorded at freeze, and served in that order', () => {
  const svc = service(db, pool());
  const m = start(svc);
  for (const t of m.tasks) expect(t.first_arm).toBe(parseInt(orderSha(t.key).slice(0, 2), 16) % 2 === 0 ? 'A' : 'B');
  expect(m.analysis.condition_order).toHaveLength(2 * PL_TASKS);
  expect(m.analysis.condition_order.slice(0, 2)).toEqual([{ seq: 0, task_key: m.tasks[0].key, arm: m.tasks[0].first_arm }, { seq: 1, task_key: m.tasks[0].key, arm: m.tasks[0].first_arm === 'A' ? 'B' : 'A' }]);
  const rows = db.prepare('SELECT task_key, arm, seq FROM pl_attempts ORDER BY seq').all();
  expect(rows).toEqual(m.analysis.condition_order);
  expect(new Set(m.tasks.map((t) => t.first_arm))).toEqual(new Set(['A', 'B'])); // both orders occur
  const c1 = plClaim(svc);
  expect(c1.pl).toEqual({ experiment: 'pl-001', arm: m.tasks[0].first_arm });
  expect(c1.task.commit).toBe(m.tasks[0].key);
  expect(firstArm(m.tasks[0].key)).toBe(m.tasks[0].first_arm);
});

it('arm B gets exactly the protocol lines (digest 6dddbba1…), arm A gets none; model, budget and gates are the same', () => {
  const svc = service(db, pool());
  const m = start(svc);
  const first = plClaim(svc); svc.record(first.runId, 'workstation', failure(first));
  const second = plClaim(svc);
  const [a, b] = first.pl!.arm === 'A' ? [first, second] : [second, first];
  expect(a.task.commit).toBe(b.task.commit);
  expect(b.genome).toEqual({ id: PROCEDURE_ID, lines: [...PROCEDURE_LINES] });
  expect(linesSha256(b.genome!.lines)).toBe(PL_LINES_SHA256);
  expect(a.genome).toBeUndefined();
  for (const line of PROCEDURE_LINES) expect(JSON.stringify(a)).not.toContain(line);
  expect(a.prod_gates).toEqual(b.prod_gates);
  const meta = (c: Claim) => JSON.parse((db.prepare("SELECT json_extract(metadata, '$.gym') AS g FROM loop_runs WHERE id = ?").get(c.runId) as { g: string }).g);
  expect(meta(b).pl).toMatchObject({ arm: 'B', delivered_lines: 5, delivered_lines_sha256: PL_LINES_SHA256, expected_goal_sha256: fire(b).goal_sha256 });
  expect(meta(a).pl).toMatchObject({ arm: 'A', delivered_lines: 0, delivered_lines_sha256: PL_NO_LINES_SHA256, expected_goal_sha256: fire(a).goal_sha256 });
  expect(meta(a).species).toBe(m.species); expect(meta(b).species).toBe(m.species);
  expect(meta(a).prod_gates).toBe(1); expect(meta(b).prod_gates).toBe(1);
  svc.record(second.runId, 'workstation', success(second));
  expect(attempt(second.runId).status).toBe('done');
  expect(JSON.parse(attempt(second.runId).result_json!)).toMatchObject({ void: null, verified: true, fire_check: { lines_sha256: second.pl!.arm === 'B' ? PL_LINES_SHA256 : PL_NO_LINES_SHA256 } });
});

it('fire check, both arms: a B attempt without 5/5 lines or with another lines digest is VOID and served again; an A attempt with lines is VOID', () => {
  const svc = service(db, pool());
  start(svc);
  const c = plClaim(svc);
  const goodFire = fire(c);
  const tampered = c.pl!.arm === 'B' ? { ...goodFire, genome_lines_found: 4 } : { ...goodFire, genome_lines: 5, genome_lines_found: 5, lines_sha256: PL_LINES_SHA256 };
  svc.record(c.runId, 'workstation', success(c, { fire_check: tampered }));
  const row = attempt(c.runId);
  expect(row).toMatchObject({ status: 'pending', retries: 1 }); // VOID → the arm is served again
  expect(JSON.parse(row.history_json!)[0].void).toMatch(c.pl!.arm === 'B' ? /^fire_check: 4 of 5 procedure lines/ : /arm A received lines/);
  const again = plClaim(svc);
  expect([again.task.commit, again.pl!.arm]).toEqual([c.task.commit, c.pl!.arm]);
  // no fire check at all → VOID; the stored run says why
  svc.record(again.runId, 'workstation', success(again, { fire_check: undefined }));
  expect((db.prepare("SELECT json_extract(metadata, '$.gym_result.void') AS v FROM loop_runs WHERE id = ?").get(again.runId) as { v: string }).v).toBe('fire_check: no evidence of the maker prompt');
  // the delivered digest itself must be the protocol's: any other lines are a different treatment
  const meta = { ...plClaimMeta({ attempt_id: 'x', arm: 'B', task: c.task, lines: ['Another line.'] }) };
  expect(plVoid(meta, true, 'failure', undefined, worker.fireCheck(plGoal(c.task, ['Another line.']), ['Another line.']))).toMatch(/^procedure: delivered lines digest/);
  const real = plClaimMeta({ attempt_id: 'x', arm: 'B', task: c.task, lines: [...PROCEDURE_LINES] });
  expect(plVoid(real, true, 'failure', undefined, worker.fireCheck(plGoal(c.task, PROCEDURE_LINES), [...PROCEDURE_LINES]))).toBeNull();
  // a worker that rewrote the goal (same lines found, other text) fails the goal sha256
  expect(plVoid(real, true, 'failure', undefined, { ...worker.fireCheck(plGoal(c.task, PROCEDURE_LINES), [...PROCEDURE_LINES]), goal_sha256: 'f'.repeat(64) })).toBe('fire_check: the goal sent differs from the protocol goal for this arm');
  // three VOID / infra physical attempts → INFRA_CENSORED, every attempt kept
  const third = plClaim(svc); svc.record(third.runId, 'workstation', { status: 'discarded', reason: 'infra: npm ci failed' });
  expect(attempt(third.runId)).toMatchObject({ status: 'censored', retries: 2 });
  expect(JSON.parse(attempt(third.runId).history_json!)).toHaveLength(3);
});

it('the oracle verdict is required: no diff = infra discard, no per-check gate map = VOID, a hack-flagged success is quarantined = not verified', () => {
  const svc = service(db, pool());
  start(svc);
  const c = plClaim(svc);
  svc.record(c.runId, 'workstation', success(c, { diff: '' }));
  expect(JSON.parse(attempt(c.runId).history_json!)[0]).toMatchObject({ status: 'discarded', reason: 'infra: success without changed_files/diff evidence' });
  const c2 = plClaim(svc);
  svc.record(c2.runId, 'workstation', success(c2, { prod_gates: undefined }));
  expect(JSON.parse(attempt(c2.runId).history_json!)[1].void).toBe('oracle: gated success without per-check prod gate results (ELIGIBLE_GATED)');
  const c3 = plClaim(svc);
  svc.record(c3.runId, 'workstation', success(c3, { changed_files: [c3.task.source, 'packages/server/src/__tests__/s1.test.ts'] }));
  const row = attempt(c3.runId);
  expect(row.status).toBe('done');
  expect(JSON.parse(row.result_json!)).toMatchObject({ status: 'quarantined', verified: false, hack_flags: ['tests_touched'] });
  // the other arm: a real gated success with its fire check is the only verified observation
  const c4 = plClaim(svc); svc.record(c4.runId, 'workstation', success(c4));
  expect(JSON.parse(attempt(c4.runId).result_json!)).toMatchObject({ status: 'success', verified: true });
  const s = plState(db, plManifest(db)!);
  expect(s.completed).toHaveLength(1);
  expect(s.primary).toMatchObject({ n_pairs: 1, both_verified: 0 });
});

it('isolation: PL-001 runs are invisible to skill outcomes, gym statistics, the breaker, tried tasks, IRT, the diff dataset, trials and holdouts', () => {
  vi.stubEnv('GYM_STORE_DIFFS', 'true'); vi.stubEnv('GRADED_FITNESS_MODE', 'shadow'); vi.stubEnv('HACK_DETECTOR_MODE', 'shadow');
  const svc = service(db, pool());
  const m = start(svc);
  const before = { outcomes: (db.prepare('SELECT COUNT(*) AS n FROM skill_outcomes').get() as { n: number }).n, obs: gymObservations(db).length };
  const ok = plClaim(svc); svc.record(ok.runId, 'workstation', success(ok));
  // three recent infra discards: they would bench the species if the breaker counted them
  for (let i = 0; i < 3; i++) { const c = plClaim(svc); svc.record(c.runId, 'workstation', { status: 'discarded', reason: 'infra: npm ci failed' }); }
  expect(db.prepare("SELECT loop_name, COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.gym.pl') IS NOT NULL GROUP BY 1").all()).toEqual([{ loop_name: PL_LOOP, n: 4 }]);
  expect((db.prepare('SELECT COUNT(*) AS n FROM skill_outcomes').get() as { n: number }).n).toBe(before.outcomes); // fitness, bandit, skill traits
  expect(gymObservations(db).length).toBe(before.obs); // IRT
  expect(infraFailing(db, SPECIES, new Date(Date.now() - 86_400_000).toISOString())).toBe(false); // the breaker
  expect([...triedTasks(db, SPECIES)].filter((k) => m.tasks.some((t) => t.key === k))).toEqual([]); // never-repeat bookkeeping
  expect(db.prepare('SELECT COUNT(*) AS n FROM gym_attempt_diffs').get()).toEqual({ n: 0 });
  expect((db.prepare("SELECT json_extract(metadata, '$.gym_result.diff_ref') AS r FROM loop_runs WHERE id = ?").get(ok.runId) as { r: string }).r).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(db.prepare("SELECT COUNT(*) AS n FROM loop_events WHERE event_type LIKE 'effort%'").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM maker_genomes WHERE status IN ('trial', 'active') AND id <> 'baseline'").get()).toEqual({ n: 0 }); // no trial genome
  expect(db.prepare("SELECT COUNT(*) AS n FROM judgments WHERE judgment = 'procedure_selection'").get()).toEqual({ n: 0 });
  // holdouts: a PL key is never frozen into a holdout and never served as ordinary gym work
  expect(exclusionReason(holdoutExclusions(db), { commit: m.tasks[0].key })).toBe('PL-001 task key');
  vi.stubEnv('PL_001_MODE', 'off');
  const plain = new RemoteGymService(db, () => m.tasks.map((t) => ({ commit: t.key, source: t.source, tests: t.tests, sourceLines: 1 })));
  const c = plain.claim('workstation', [SPECIES], tick(), CAPS) as Claim;
  expect(c.skipped).toBe('no untried task');
  // the species breaker still counts an ordinary gym run's infra discards (the exclusion is PL-only)
  const ord = new RemoteGymService(db, () => [{ commit: 'ord-1', source: 'packages/server/src/services/z.ts', tests: ['t'], sourceLines: 1 }, { commit: 'ord-2', source: 'packages/server/src/services/z.ts', tests: ['t'], sourceLines: 1 }, { commit: 'ord-3', source: 'packages/server/src/services/z.ts', tests: ['t'], sourceLines: 1 }]);
  for (let i = 0; i < 3; i++) { const o = ord.claim('workstation', [SPECIES], tick(), CAPS) as Claim; ord.record(o.runId, 'workstation', { status: 'discarded', reason: 'infra: npm ci failed' }); }
  expect(infraFailing(db, SPECIES, new Date(Date.now() - 86_400_000).toISOString())).toBe(true);
});

it('a lost report settles the PL attempt as an infra discard (re-served), never left claimed', () => {
  const svc = service(db, pool());
  start(svc);
  const lost = plClaim(svc);
  const next = plClaim(svc); // the same host claims again: the first run lost its report
  expect(attempt(lost.runId)).toMatchObject({ retries: 1 });
  expect(JSON.parse(attempt(lost.runId).history_json!)[0].reason).toMatch(/^infra: worker lost the result/);
  expect([next.task.commit, next.pl!.arm]).toEqual([lost.task.commit, lost.pl!.arm]);
});

it('a task discard makes the task INVALID for both arms; the other arm is not served', () => {
  const svc = service(db, pool());
  const m = start(svc);
  const c = plClaim(svc);
  svc.record(c.runId, 'workstation', { status: 'discarded', reason: 'task: mutant survives (tests stay green)' });
  expect(db.prepare('SELECT DISTINCT status FROM pl_attempts WHERE task_key = ?').all(m.tasks[0].key)).toEqual([{ status: 'invalid' }]);
  expect(plClaim(svc).task.commit).toBe(m.tasks[1].key);
  expect(plState(db, m).invalid).toBe(1);
});

/** Sets an arm's observation directly (the analysis and stop rule read pl_attempts only). */
function settle(m: PlManifest, i: number, arm: 'A' | 'B', o: 'v' | 'n' | 'c', at: string, extra: Record<string, unknown> = {}) {
  const status = o === 'c' ? 'censored' : 'done';
  const r = { run_id: `run-${i}-${arm}`, status: o === 'v' ? 'success' : 'failure', reason: o === 'v' ? 'tests green' : 'tests still red', void: null, verified: o === 'v', out_of_scope: false, hack_flags: [], graded: o === 'v' ? 1 : 0,
    graded_kind: 'binary', tokens: null, duration_ms: 1, metrics: {}, fire_check: null, at, ...extra };
  db.prepare('UPDATE pl_attempts SET status = ?, result_json = ?, history_json = ?, updated_at = ?, first_claimed_at = COALESCE(first_claimed_at, ?) WHERE task_key = ? AND arm = ?')
    .run(status, JSON.stringify(r), JSON.stringify([r]), at, at, m.tasks[i].key, arm);
}

it('McNemar: exact one-sided on b (B only) vs c (A only); ITT counts a censored arm as not verified; sensitivity drops it', () => {
  expect(plPaired([])).toMatchObject({ n_pairs: 0, p_one_sided: null, supported: null, rate_A: null });
  const pairs = [...Array(10).fill({ A: 'not_verified', B: 'verified' }), ...Array(2).fill({ A: 'verified', B: 'not_verified' }), ...Array(5).fill({ A: 'verified', B: 'verified' })];
  const r = plPaired(pairs);
  expect(r).toMatchObject({ n_pairs: 17, b_only_B: 10, c_only_A: 2, both_verified: 5, supported: true });
  expect(r.p_one_sided).toBeCloseTo((66 + 12 + 1) / 4096, 10);
  expect(plPaired([...Array(5).fill({ A: 'not_verified', B: 'verified' }), ...Array(5).fill({ A: 'verified', B: 'not_verified' })]).supported).toBe(false);
  // a censored B arm is "not verified" in the primary analysis
  expect(plPaired([{ A: 'verified', B: 'INFRA_CENSORED' }])).toMatchObject({ c_only_A: 1 });
});

it('stop rule: 60 completed pairs → SUPPORTED / NOT_SUPPORTED; day 14 before 60 → INCONCLUSIVE; harm stops early; a stopped experiment serves nothing', () => {
  const svc = service(db, pool());
  const m = start(svc);
  const base = Date.parse(m.frozen_at) + 10_000; // every attempt after the freeze
  const at = (k: number) => new Date(base + k * 1_000).toISOString();
  // 59 pairs: collecting
  for (let i = 0; i < 59; i++) { const bWins = i < 20; const aWins = i >= 20 && i < 24; settle(m, i, 'A', aWins || i >= 40 ? 'v' : 'n', at(2 * i)); settle(m, i, 'B', bWins || i >= 40 ? 'v' : (i === 30 ? 'c' : 'n'), at(2 * i + 1)); }
  let s = plState(db, m);
  expect(s.verdict).toBeNull(); expect(s.stop.stopped).toBe(false);
  expect(pl001Evidence(db, process.env)).toMatchObject({ status: 'collecting', pairs: { done: 59, target: PL_PAIRS } });
  settle(m, 59, 'A', 'n', at(200)); settle(m, 59, 'B', 'n', at(201));
  s = plState(db, m);
  expect(s.primary).toMatchObject({ n_pairs: 60, b_only_B: 20, c_only_A: 4, supported: true });
  expect(s.sensitivity.n_pairs).toBe(59); // the pair with a censored arm is dropped
  expect(s.verdict).toBe('SUPPORTED');
  expect(claimPl001(db, m, 'r-late', new Date().toISOString())).toBeNull();
  // day 14 after the first attempt with fewer pairs
  db.prepare("UPDATE pl_attempts SET status = 'pending', result_json = NULL, history_json = NULL WHERE task_key IN (SELECT task_key FROM pl_attempts WHERE seq >= 40)").run();
  expect(plState(db, m).verdict).toBeNull();
  expect(plState(db, m, base + 14 * 86_400_000 + 1).verdict).toBe('INCONCLUSIVE');
  expect(plState(db, m, base + 14 * 86_400_000 + 1).stop.reason).toMatch(/^day 14 /);
  // harm: baseline beats candidate on every discordant pair → e-value ≥ 20 stops early, never an early stop for success
  db.prepare("UPDATE pl_attempts SET status = 'pending', result_json = NULL, history_json = NULL, first_claimed_at = NULL").run();
  for (let i = 0; i < 12; i++) { settle(m, i, 'A', 'v', at(2 * i)); settle(m, i, 'B', 'n', at(2 * i + 1)); }
  s = plState(db, m);
  expect(s.harm.e_value!).toBeGreaterThanOrEqual(20);
  expect(s.verdict).toBe('STOPPED_FOR_HARM');
  db.prepare("UPDATE pl_attempts SET status = 'pending', result_json = NULL, history_json = NULL, first_claimed_at = NULL").run();
  for (let i = 0; i < 12; i++) { settle(m, i, 'A', 'n', at(2 * i)); settle(m, i, 'B', 'v', at(2 * i + 1)); }
  expect(plState(db, m).verdict).toBeNull(); // a strong early candidate lead is not a stop
  // harm: B has 3 more out-of-scope results than A
  for (let i = 12; i < 15; i++) { settle(m, i, 'A', 'n', at(100 + i)); settle(m, i, 'B', 'n', at(120 + i), { out_of_scope: true, reason: 'out of scope: a.ts' }); }
  expect(plState(db, m)).toMatchObject({ verdict: 'STOPPED_FOR_HARM', harm: { scope_hack: { A: 0, B: 3 } } });
});

it('lifecycle: SUPPORTED → validated (not promoted), NOT_SUPPORTED → retired + negative-evidence draft, INCONCLUSIVE → candidate; once only', () => {
  const svc = service(db, pool());
  const m = start(svc);
  const at = (k: number) => new Date(Date.parse(m.frozen_at) + 10_000 + k * 1_000).toISOString();
  const row = () => db.prepare("SELECT status, note, json_extract(evidence_sources_json, '$.procedure.lifecycle') AS l, evidence_sources_json AS s FROM maker_genomes WHERE id = ?").get(PROCEDURE_ID) as { status: string; note: string; l: string | null; s: string };
  const contract = JSON.parse(row().s).procedure.applicability;
  const reset = () => { db.prepare("UPDATE pl_attempts SET status = 'pending', result_json = NULL, history_json = NULL").run(); db.prepare("UPDATE maker_genomes SET status = 'candidate', evidence_sources_json = json_remove(evidence_sources_json, '$.procedure.lifecycle') WHERE id = ?").run(PROCEDURE_ID); };
  expect(applyPl001Lifecycle(db, m, plState(db, m), at(0))).toEqual({ applied: false }); // no verdict yet
  for (let i = 0; i < 60; i++) { settle(m, i, 'A', i < 3 ? 'v' : 'n', at(2 * i)); settle(m, i, 'B', i < 15 ? 'v' : 'n', at(2 * i + 1)); }
  expect(applyPl001Lifecycle(db, m, plState(db, m), at(500))).toEqual({ applied: true, status: 'validated' });
  expect(row().status).toBe('validated');
  expect(JSON.parse(row().l!)).toMatchObject({ verdict: 'SUPPORTED', promoted: false, b: 12, c: 0, manifest_sha256: plManifestSha(m) });
  expect(row().note).toMatch(/operator decision is needed before any production delivery/);
  expect(JSON.parse(row().s).procedure.applicability).toEqual(contract); // the contract and the lines are untouched
  expect(procedure(db, PROCEDURE_ID)!.lines_sha256).toBe(PL_LINES_SHA256);
  expect(applyPl001Lifecycle(db, m, plState(db, m), at(501))).toEqual({ applied: false }); // once
  expect(strategyGenomeFor(db, 'atomic', 'llama-router')?.id ?? 'baseline').toBe('baseline'); // never a production strategy genome
  expect(db.prepare("SELECT COUNT(*) AS n FROM maker_genomes WHERE status IN ('active', 'trial') AND id <> 'baseline'").get()).toEqual({ n: 0 });
  reset();
  for (let i = 0; i < 60; i++) { settle(m, i, 'A', i < 10 ? 'v' : 'n', at(2 * i)); settle(m, i, 'B', i < 11 ? 'v' : 'n', at(2 * i + 1)); }
  expect(plState(db, m).verdict).toBe('NOT_SUPPORTED');
  expect(applyPl001Lifecycle(db, m, plState(db, m), at(600))).toEqual({ applied: true, status: 'retired' });
  const draft = db.prepare("SELECT subject_id, decision, answers_json FROM judgments WHERE judgment = 'negative_evidence_draft'").get() as { subject_id: string; decision: string; answers_json: string };
  expect(draft).toMatchObject({ subject_id: PROCEDURE_ID, decision: 'draft' });
  expect(JSON.parse(draft.answers_json)).toMatchObject({ verdict: 'REJECT', evidence: expect.arrayContaining([`lines_sha256 ${PL_LINES_SHA256}`]) });
  reset();
  for (let i = 0; i < 10; i++) { settle(m, i, 'A', 'n', at(2 * i)); settle(m, i, 'B', 'v', at(2 * i + 1)); }
  const late = plState(db, m, Date.now() + 15 * 86_400_000);
  expect(late.verdict).toBe('INCONCLUSIVE');
  expect(applyPl001Lifecycle(db, m, late, at(700))).toEqual({ applied: true, status: 'candidate' });
  expect(row().status).toBe('candidate');
  expect(JSON.parse(row().l!)).toMatchObject({ verdict: 'INCONCLUSIVE', reason: expect.stringMatching(/day 14/) });
});

it('the verdict is recorded through the claim / result path: the 60th pair settles the lifecycle', () => {
  const svc = service(db, pool());
  const m = start(svc);
  const at = (k: number) => new Date(Date.parse(m.frozen_at) + 10_000 + k * 1_000).toISOString();
  for (let i = 0; i < 59; i++) { settle(m, i, 'A', 'n', at(2 * i)); settle(m, i, 'B', i < 20 ? 'v' : 'n', at(2 * i + 1)); }
  db.prepare("UPDATE pl_attempts SET status = 'invalid' WHERE seq >= 120").run(); // only pair 59 is left to serve
  const c1 = plClaim(svc); svc.record(c1.runId, 'workstation', failure(c1));
  const c2 = plClaim(svc); svc.record(c2.runId, 'workstation', failure(c2));
  expect(plState(db, m).verdict).toBe('SUPPORTED');
  expect((db.prepare('SELECT status FROM maker_genomes WHERE id = ?').get(PROCEDURE_ID) as { status: string }).status).toBe('validated');
  expect(plClaim(svc).pl).toBeUndefined(); // stopped: nothing more is served
});

it('start condition: waits while g-a187f81f / g-d14c1156 are in trial; a cap share lets PL take that share only', () => {
  const iso = new Date(t0).toISOString();
  db.prepare("INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES ('g-a187f81f', 'baseline', 'strategy_lines', '[\"x\"]', 'dream', 'trial', ?, ?)").run(iso, iso);
  const svc = service(db, pool());
  start(svc);
  expect(plClaim(svc).pl).toBeUndefined();
  expect(pl001Evidence(db, process.env)).toMatchObject({ status: 'waiting_start', start_condition: { settled: false, open: false, rule: 'waiting' } });
  vi.stubEnv('PL_001_CAP_SHARE', '0.25'); vi.stubEnv('EVOLUTION_GYM_REMOTE_MAX_PER_DAY', '8');
  const served: Claim[] = [];
  for (let i = 0; i < 4; i++) { const c = plClaim(svc); if (c.runId) svc.record(c.runId, 'workstation', c.pl ? failure(c) : { status: 'discarded', reason: 'task: n/a' }); served.push(c); }
  expect(served.filter((c) => c.pl).length).toBe(2); // ceil(0.25 × 8)
  db.prepare("UPDATE maker_genomes SET status = 'retired' WHERE id = 'g-a187f81f'").run();
  vi.stubEnv('PL_001_CAP_SHARE', ''); vi.stubEnv('EVOLUTION_GYM_REMOTE_MAX_PER_DAY', '1000');
  expect(plClaim(svc).pl).toBeDefined(); // settled: PL takes the claim (after any trial attempt)
});

it('off mode is identical: PL_001_MODE unset, off, or on without a procedure_lines worker — same payload, same run row, nothing frozen', () => {
  const tasks = [{ commit: 'c1', source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 }];
  const run = (env: string | null, caps: string[]) => {
    const d = fresh();
    try {
      if (env === null) vi.stubEnv('PL_001_MODE', ''); else vi.stubEnv('PL_001_MODE', env);
      const svc = new RemoteGymService(d, () => tasks); svc.plCandidates = () => pool();
      const c = svc.claim('workstation', [SPECIES], new Date('2026-10-26T12:00:00.000Z'), { capabilities: caps }) as Claim;
      const row = d.prepare('SELECT loop_name, mode, status, metadata, created_at FROM loop_runs').all();
      const pl = d.prepare('SELECT (SELECT COUNT(*) FROM pl_experiments) + (SELECT COUNT(*) FROM pl_attempts) AS n').get();
      return { c: JSON.stringify({ ...c, runId: 'x' }), row: JSON.stringify(row), pl };
    } finally { d.close(); }
  };
  const unset = run(null, CAPS.capabilities);
  expect(run('off', CAPS.capabilities)).toEqual(unset);
  expect(run('on', ['canary', 'write_test', 'prod_gates', 'prompt_override'])).toEqual(unset); // an old worker never sees PL-001
  expect(unset.pl).toEqual({ n: 0 });
  expect(unset.c).not.toContain('"pl"');
});

it('evidence pl_001: unknown is never 0 — tokens kept apart from known counts; the GO checklist names what is missing', () => {
  const empty = buildEvolutionEvidence(db, {}, Date.now()) as unknown as { pl_001: ReturnType<typeof pl001Evidence> };
  expect(empty.pl_001).toMatchObject({ mode: 'off', status: 'not_frozen', primary: null, pairs: null, procedure: { id: PROCEDURE_ID, version: null, lines_sha256: null, protocol_lines_sha256: PL_LINES_SHA256, digest_matches: null } });
  const svc = service(db, pool());
  start(svc);
  const a = plClaim(svc); svc.record(a.runId, 'workstation', failure(a)); // no token count printed
  const b = plClaim(svc); svc.record(b.runId, 'workstation', success(b));
  const e = pl001Evidence(db, process.env);
  expect(e).toMatchObject({ status: 'collecting', procedure: { digest_matches: true, status: 'candidate' }, manifest: { tasks: PL_TASKS, valid: true }, pairs: { done: 1, target: PL_PAIRS } });
  const armOf = (c: Claim) => e.arms.find((x) => x.arm === c.pl!.arm)!;
  expect(armOf(a).tokens).toEqual({ known: 0, unknown: 1, mean_known: null });
  expect(armOf(b).tokens).toEqual({ known: 1, unknown: 0, mean_known: 1234 });
  expect(armOf(b).maker_ms_median).toBe(5_000); expect(armOf(a).maker_ms_median).toBeNull();
  expect(e.runs.map((r) => r.run_id).sort()).toEqual([a.runId, b.runId].sort());
  const go = plGoChecklist(db, { commit: null, worker_sha256: null }, process.env);
  expect(go.checks).toMatchObject({ mode_on: true, frozen: true, manifest_valid: true, procedure_digest: true, selector_check: true, tasks_frozen: true, start_condition: true, worker_matches_manifest: false });
  expect(go.go).toBe(false);
});
