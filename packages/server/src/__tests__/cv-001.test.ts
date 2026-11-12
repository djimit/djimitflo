import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { RemoteGymService } from '../services/remote-gym-service';
import { RemoteMakerQueue } from '../services/remote-maker-queue';
import { infraFailing, triedTasks } from '../services/evolution-gym-service';
import { gymObservations } from '../services/gym-irt';
import { exclusionReason, holdoutExclusions } from '../services/holdout-exposure';
import { buildEvolutionEvidence, EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { experimentDefs } from '../services/experiment-registry';
import type { GymTask } from '../services/gym-task-miner';
import {
  CV_ALIASES, CV_BLOCK, CV_LOOP, CV_REPEATS, CV_TASKS, CV_VECTOR_SHA256, blockFirstArm, claimCv001, cv001Evidence, cvManifest, cvManifestValidity, cvPaired, cvSchedule, cvServable,
  cvState, cvVoid, sanitizeModelCheck, type CvPair, type CvResult,
} from '../services/cv-001';

/**
 * CV-001 step 2 runner (docs/research/cv-001/CV-001_PROTOCOL.md): the frozen schedule, the quiet-window and maker-job gate,
 * claims only for model_override workers, the alias delivered and verified (VOID otherwise), isolation by provenance, the
 * frozen decision rule and the off mode.
 */
type Worker = {
  modelCheckOf: (alias: string, route: unknown, listing: unknown, transcript: unknown) => Record<string, unknown>;
  transcriptMetrics: (text: string) => Record<string, unknown> | null; CAPABILITIES: string[];
};
let worker: Worker;
const SPECIES = 'atomic@llama-router';
const CAPS = { capabilities: ['canary', 'write_test', 'prod_gates', 'prompt_override', 'procedure_lines', 'model_override'] };
const OLD_CAPS = { capabilities: ['canary', 'write_test', 'prod_gates', 'prompt_override', 'procedure_lines'] };
const mut = (i: number, source = `packages/server/src/services/s${i}.ts`): GymTask => ({ commit: `mut:cccccccccccc:${source}:3:${i}`, base: 'c'.repeat(40), source,
  tests: [`packages/server/src/__tests__/s${i}.test.ts`], sourceLines: 40, mutant: `export const s${i} = ${i} - 1;\n`, tier: 3 + (i % 4) } as GymTask);
const fresh = () => { const d = new Database(':memory:'); d.pragma('foreign_keys = OFF'); d.exec(schema); runMigrations(d); new RemoteMakerQueue(d); return d; };
let db: Database.Database;
const NIGHT = Date.parse('2026-11-08T00:30:00.000Z');
let t0 = NIGHT;
const tick = () => new Date((t0 += 1_000));
type Claim = { runId: string; task: GymTask; model_override?: { alias: string }; cv?: { experiment: string; arm: 'A' | 'B'; repeat: number }; pl?: unknown; genome?: unknown; skipped?: string };

beforeEach(async () => {
  worker = await import(path.resolve(__dirname, '../../../../scripts/gym-worker.mjs')) as Worker;
  db = fresh(); t0 = NIGHT;
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo-that-does-not-exist');
  vi.stubEnv('GYM_PROD_GATES', 'true'); vi.stubEnv('CV_001_MODE', 'on'); vi.stubEnv('EVOLUTION_GYM_REMOTE_MAX_PER_DAY', '1000');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const service = (d: Database.Database, candidates: GymTask[], mined: GymTask[] = []) => { const svc = new RemoteGymService(d, () => mined); svc.cvCandidates = () => candidates; return svc; };
const pool = (n = 80) => Array.from({ length: n }, (_, i) => mut(i + 1));
const cvClaim = (svc: RemoteGymService, caps = CAPS) => svc.claim('workstation', [SPECIES], tick(), caps) as Claim;
function start(svc: RemoteGymService) {
  const freezing = cvClaim(svc);
  expect(freezing.cv).toBeUndefined(); // the freezing claim starts no CV attempt
  const m = cvManifest(db); expect(m).not.toBeNull();
  return m!;
}
const VEC = '/home/djimit/cv-001/qwen38-27b-discipline.gguf';
const CHAT = JSON.stringify({ messages: [{ role: 'user', content: 'go' }, { role: 'assistant', tool_calls: [{ function: { name: 'bash', arguments: '{"c":"npx vitest run"}' } }] },
  { role: 'tool', content: '      Tests  2 passed (2)' }] });
/** what the real worker reports for this claim (its own modelCheckOf / transcriptMetrics), optionally tampered */
const check = (c: Claim, over: { alias?: string; served?: string[]; vectors?: unknown[]; transcript?: unknown; unforced?: number; chat?: string } = {}) => {
  const alias = over.alias ?? c.model_override!.alias;
  const vectors = over.vectors ?? (c.cv!.arm === 'B' ? [{ path: VEC, scale: 1.5, sha256: CV_VECTOR_SHA256 }] : []);
  return worker.modelCheckOf(alias, { requests: 4, forced: 4 - (over.unforced ?? 0), unforced: over.unforced ?? 0, served_models: over.served ?? [alias], http_errors: 0 },
    { listed: true, status: 'loaded', layer_range: null, control_vectors: vectors }, over.transcript === undefined ? worker.transcriptMetrics(over.chat ?? CHAT) : over.transcript);
};
const success = (c: Claim, mc: unknown = check(c), over: Record<string, unknown> = {}) => ({ status: 'success' as const, reason: 'tests green, source only', changed_files: [c.task.source],
  diff: `diff --git a/${c.task.source} b/${c.task.source}\n-a\n+b`, prod_gates: { diff_limit: 'pass', lint: 'pass' }, model_check: mc, tokens: 1234, durationMs: 9_000,
  tg_metrics: { maker_ms: 5_000, termination: 'exit:0' }, ...over });
const failure = (c: Claim, mc: unknown = check(c)) => ({ status: 'failure' as const, reason: 'tests still red', changed_files: [c.task.source], diff: 'diff --git a/x b/x\n+c', model_check: mc,
  durationMs: 8_000, tg_metrics: { maker_ms: 4_000, termination: 'exit:0' } });
const slot = (runId: string) => db.prepare('SELECT task_key, repeat, arm, status, retries, result_json, history_json FROM cv_attempts WHERE run_id = ? OR history_json LIKE ?').get(runId, `%${runId}%`) as
  { task_key: string; repeat: number; arm: string; status: string; retries: number; result_json: string | null; history_json: string | null };

it('schedule: 120 units in 20 block pairs of 6; each pair serves the same units in both arms, first arm by sha256 parity; input order does not matter', () => {
  const keys = pool(CV_TASKS).map((t) => t.commit);
  const s = cvSchedule(keys);
  expect(s).toHaveLength(CV_TASKS * CV_REPEATS * 2);
  expect(JSON.stringify(cvSchedule([...keys].reverse()))).toBe(JSON.stringify(s));
  for (let k = 0; k < (CV_TASKS * CV_REPEATS) / CV_BLOCK; k++) {
    const pair = s.filter((x) => x.block_pair === k);
    expect(pair).toHaveLength(2 * CV_BLOCK);
    const first = pair.slice(0, CV_BLOCK); const second = pair.slice(CV_BLOCK);
    expect(new Set(first.map((x) => x.arm))).toEqual(new Set([blockFirstArm(k)]));
    expect(new Set(second.map((x) => x.arm))).toEqual(new Set([blockFirstArm(k) === 'A' ? 'B' : 'A']));
    const units = (xs: typeof s) => xs.map((x) => `${x.task_key}#${x.repeat}`).sort();
    expect(units(first)).toEqual(units(second));
    expect(first.map((x) => x.block)).toEqual(Array(CV_BLOCK).fill(2 * k));
  }
  // every unit exactly once per arm, seq is the serving order, and both arms lead some block pairs
  for (const arm of ['A', 'B']) expect(new Set(s.filter((x) => x.arm === arm).map((x) => `${x.task_key}#${x.repeat}`)).size).toBe(CV_TASKS * CV_REPEATS);
  expect(s.map((x) => x.seq)).toEqual(s.map((_, i) => i));
  const leads = new Set(Array.from({ length: 20 }, (_, k) => blockFirstArm(k)));
  expect(leads).toEqual(new Set(['A', 'B']));
});

it('freeze: 60 mutant-repair tasks, never a holdout, TG, PL, trial, earlier-gym, mined or write_test key; ordered by sha256; refused when short', () => {
  const tasks = pool(80); const iso = new Date(NIGHT - 3_600_000).toISOString();
  db.prepare('INSERT INTO gym_mutant_holdout (key, task_json, created_at) VALUES (?, ?, ?)').run(tasks[0].commit, '{}', iso);
  db.prepare("INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at) VALUES ('t1', 'tg-001-r2', ?, 'A', 0, 'done', 0, ?)").run(tasks[1].commit, iso);
  db.prepare("INSERT INTO pl_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at) VALUES ('p1', 'pl-001', ?, 'A', 0, 'done', 0, ?)").run(tasks[2].commit, iso);
  const run = (id: string, gym: Record<string, unknown>) => db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at, updated_at) VALUES (?, 'evolution-gym', 'closed', 'completed', ?, ?, ?)")
    .run(id, JSON.stringify({ gym, gym_result: { status: 'failure', reason: 'tests still red' } }), iso, iso);
  run('r-trial', { commit: tasks[3].commit, genome: 'g1', species: SPECIES }); run('r-prior', { commit: tasks[4].commit, species: SPECIES });
  const mined = { commit: 'mined-1', source: 'packages/server/src/services/m.ts', tests: ['t'], sourceLines: 3 } as GymTask;
  const wt = { ...mut(901), kind: 'write_test' } as GymTask;
  const m = start(service(db, [...tasks, mined, wt]));
  const banned = new Set([...tasks.slice(0, 5).map((t) => t.commit), mined.commit, wt.commit]);
  expect(m.tasks).toHaveLength(CV_TASKS);
  expect(m.tasks.filter((t) => banned.has(t.key))).toEqual([]);
  expect(m.pool.excluded).toMatchObject({ 'already frozen in a holdout epoch': 1, 'TG-001 task key': 1, 'PL-001 task key': 1, 'attempted in a genome trial': 1, 'earlier evolution-gym attempt': 1, 'not a mutant-repair task': 2 });
  const { createHash } = require('crypto') as typeof import('crypto');
  const o = (k: string) => createHash('sha256').update(`cv-001:${k}`).digest('hex');
  expect(m.tasks.map((t) => t.key)).toEqual(tasks.slice(5).map((t) => t.commit).sort((a, b) => (o(a) < o(b) ? -1 : 1)).slice(0, CV_TASKS));
  expect(m.treatment).toEqual({ aliases: { A: 'qwen38-27b', B: 'qwen38-27b-cvd15' }, vector_sha256: CV_VECTOR_SHA256, scale: 1.5, layer_range: null });
  expect(m.schedule.slots).toHaveLength(240);
  expect((db.prepare('SELECT COUNT(*) AS n FROM cv_attempts').get() as { n: number }).n).toBe(240);
  expect(cvManifestValidity(db, m)).toEqual({ valid: true, reason: null });
  db.prepare("UPDATE cv_experiments SET manifest_json = json_set(manifest_json, '$.treatment.scale', 2)").run();
  expect(cvManifestValidity(db, cvManifest(db)!).valid).toBe(false);
  expect(claimCv001(db, cvManifest(db)!, 'r', new Date(NIGHT).toISOString())).toBeNull();
  // too few eligible: nothing frozen, the reason is evidence
  const d = fresh();
  try {
    service(d, pool(30)).claim('workstation', [SPECIES], new Date(NIGHT), CAPS);
    expect(cvManifest(d)).toBeNull();
    expect(cv001Evidence(d, process.env, NIGHT)).toMatchObject({ status: 'not_frozen', freeze_refused: { reason: 'only 30 eligible mutant-repair tasks (need 60)' } });
  } finally { d.close(); }
});

it('claims: only a model_override + prod_gates worker gets CV-001; the claim carries the arm alias and is served in schedule order', () => {
  const svc = service(db, pool());
  const m = start(svc);
  const old = cvClaim(svc, OLD_CAPS);
  expect(old.cv).toBeUndefined(); expect(old.model_override).toBeUndefined(); // an older worker never sees CV-001
  vi.stubEnv('GYM_PROD_GATES', 'false');
  expect(cvClaim(svc).cv).toBeUndefined(); // gates off: no CV
  vi.stubEnv('GYM_PROD_GATES', 'true');
  expect((svc.claim('workstation-2060', ['atomic@qwen36-2060'], tick(), CAPS) as Claim).cv).toBeUndefined(); // another species never
  const served = Array.from({ length: 8 }, () => { const c = cvClaim(svc); svc.record(c.runId, 'workstation', failure(c)); return c; });
  const order = m.schedule.slots.slice(0, 8);
  expect(served.map((c) => [c.task.commit, c.cv!.repeat, c.cv!.arm])).toEqual(order.map((x) => [x.task_key, x.repeat, x.arm]));
  for (const c of served) {
    expect(c.model_override).toEqual({ alias: CV_ALIASES[c.cv!.arm] });
    expect(c.genome).toBeUndefined(); expect(c.pl).toBeUndefined(); // the goal is the plain gym goal in both arms
    expect(c).toMatchObject({ prod_gates: expect.any(Object) });
  }
  const row = db.prepare('SELECT loop_name, json_extract(metadata, \'$.gym.cv\') AS cv FROM loop_runs WHERE id = ?').get(served[0].runId) as { loop_name: string; cv: string };
  expect(row.loop_name).toBe(CV_LOOP);
  expect(JSON.parse(row.cv)).toMatchObject({ experiment: 'cv-001', arm: served[0].cv!.arm, alias: CV_ALIASES[served[0].cv!.arm] });
});

it('window and maker gate: outside 00–06Z, with too little window left, with a remote maker job waiting, or an invalid window, nothing of CV-001 is served', () => {
  const svc = service(db, pool(), [{ commit: 'ord-1', source: 'packages/server/src/services/z.ts', tests: ['t'], sourceLines: 1 }]);
  start(svc);
  const at = (iso: string) => svc.claim('workstation', [SPECIES], new Date(iso), CAPS) as Claim;
  const noon = at('2026-11-08T12:00:00.000Z');
  expect(noon.cv).toBeUndefined(); expect(noon.task.commit).toBe('ord-1'); // falls through to the ordinary gym unchanged
  expect(cvServable(db, new Date('2026-11-08T05:50:00.000Z'))).toMatchObject({ open: false, reason: 'the maker budget would end after the window' });
  expect(cvServable(db, new Date('2026-11-08T05:44:00.000Z')).open).toBe(true);
  vi.stubEnv('GYM_MAKER_TIMEOUT_MS', '1800000');
  expect(cvServable(db, new Date('2026-11-08T05:44:00.000Z')).open).toBe(false);
  vi.stubEnv('GYM_MAKER_TIMEOUT_MS', '');
  new RemoteMakerQueue(db).enqueue('workstation', SPECIES, 'a'.repeat(40), 'fix');
  expect(cvServable(db, new Date('2026-11-08T01:00:00.000Z'))).toMatchObject({ open: false, reason: '1 remote maker job(s) queued or claimed', maker_jobs: 1 });
  expect(at('2026-11-08T01:00:00.000Z').cv).toBeUndefined();
  db.prepare("UPDATE remote_maker_jobs SET status = 'done'").run();
  expect(at('2026-11-08T01:00:01.000Z').cv).toBeDefined();
  vi.stubEnv('CV_001_WINDOW_UTC', '6-2');
  expect(cvServable(db, new Date('2026-11-08T01:00:00.000Z'))).toMatchObject({ open: false, reason: 'invalid CV_001_WINDOW_UTC "6-2"' });
  vi.stubEnv('CV_001_WINDOW_UTC', '20-24');
  expect(cvServable(db, new Date('2026-11-08T21:00:00.000Z')).open).toBe(true);
  const d = new Database(':memory:'); // no remote_maker_jobs table: unreadable = closed
  try { expect(cvServable(d as unknown as Database.Database, new Date('2026-11-08T21:00:00.000Z'))).toMatchObject({ open: false, reason: 'remote maker jobs unreadable' }); } finally { d.close(); }
});

it('delivery proof: the reported alias, the served model, the arm vector (scale, digest) and the transcript must match the claim, else VOID and re-served; 3 VOIDs censor the slot', () => {
  const svc = service(db, pool());
  start(svc);
  const ok = cvClaim(svc); svc.record(ok.runId, 'workstation', success(ok));
  expect(slot(ok.runId)).toMatchObject({ status: 'done' });
  expect(JSON.parse(slot(ok.runId).result_json!)).toMatchObject({ plain: true, clean: true, void: null, post_pass_edits: 0, loop: false, timeout: false, degenerate: false });
  const other = (a: 'A' | 'B') => (a === 'A' ? CV_ALIASES.B : CV_ALIASES.A);
  const tamper: Array<[string, (c: Claim) => unknown, RegExp]> = [
    ['no model check', () => null, /^delivery: the worker reported no model check/],
    ['other alias used', (c) => check(c, { alias: other(c.cv!.arm) }), /^delivery: the worker used model/],
    ['router served another model', (c) => check(c, { served: [c.model_override!.alias, other(c.cv!.arm)] }), /^delivery: the router served/],
    ['an unforced request', (c) => check(c, { unforced: 1 }), /reached the router without the alias/],
    ['wrong vector', (c) => check(c, { vectors: c.cv!.arm === 'B' ? [{ path: VEC, scale: 1.5, sha256: 'f'.repeat(64) }] : [{ path: VEC, scale: 1.5, sha256: CV_VECTOR_SHA256 }] }), /^delivery: arm [AB]/],
    ['no transcript', (c) => check(c, { transcript: null }), /^transcript:/],
  ];
  for (const [name, mc, why] of tamper) {
    const c = cvClaim(svc);
    svc.record(c.runId, 'workstation', success(c, mc(c)));
    const r = slot(c.runId);
    expect(JSON.parse(r.history_json!).at(-1).void, name).toMatch(why);
    expect(r.status, name).toMatch(/^(pending|censored)$/);
    const res = db.prepare("SELECT json_extract(metadata, '$.gym_result.void') AS v FROM loop_runs WHERE id = ?").get(c.runId) as { v: string };
    expect(res.v, name).toMatch(why);
  }
  // arm B with the wrong scale and arm A with any vector are both VOID (pure check)
  const meta = (arm: 'A' | 'B') => ({ experiment: 'cv-001', arm, repeat: 1, block: 0, attempt_id: 'x', alias: CV_ALIASES[arm] });
  const mc = (arm: 'A' | 'B', vectors: unknown[]) => sanitizeModelCheck({ alias: CV_ALIASES[arm], requests: 1, forced: 1, unforced: 0, served_models: [CV_ALIASES[arm]], http_errors: 0,
    router: { listed: true, status: 'loaded', layer_range: null, control_vectors: vectors }, transcript: { tool_calls: 1, broken_tool_calls: 0, loop: false, post_pass_edits: 0, pass_seen: true } });
  expect(cvVoid(meta('B'), true, 'failure', undefined, mc('B', [{ path: VEC, scale: 2, sha256: CV_VECTOR_SHA256 }]))).toMatch(/scale 2, not 1.5/);
  expect(cvVoid(meta('B'), true, 'failure', undefined, mc('B', []))).toMatch(/carries 0 control vectors/);
  expect(cvVoid(meta('A'), true, 'failure', undefined, mc('A', [{ path: VEC, scale: 1.5, sha256: CV_VECTOR_SHA256 }]))).toMatch(/arm A alias carries a control vector/);
  expect(cvVoid(meta('A'), true, 'failure', undefined, mc('A', []))).toBeNull();
  expect(cvVoid(meta('B'), true, 'failure', undefined, mc('B', [{ path: VEC, scale: 1.5, sha256: CV_VECTOR_SHA256 }]))).toBeNull();
  expect(cvVoid(meta('A'), false, 'failure', undefined, mc('A', []))).toMatch(/^oracle:/);
  expect(cvVoid(meta('A'), true, 'success', undefined, mc('A', []))).toMatch(/ELIGIBLE_GATED/);
  // the same slot VOID three times is INFRA_CENSORED
  const first = cvClaim(svc); const key = [first.task.commit, first.cv!.repeat, first.cv!.arm];
  svc.record(first.runId, 'workstation', success(first, check(first, { transcript: null })));
  let last = first;
  for (let i = 0; i < 2; i++) { last = cvClaim(svc); expect([last.task.commit, last.cv!.repeat, last.cv!.arm]).toEqual(key); svc.record(last.runId, 'workstation', success(last, check(last, { transcript: null }))); }
  expect(slot(last.runId)).toMatchObject({ status: 'censored', retries: 2 });
});

it('outcomes: clean needs 0 edits after the first pass, no loop and no timeout; a maker timeout is an observation; a task discard invalidates the task', () => {
  const svc = service(db, pool());
  start(svc);
  const edits = JSON.stringify({ messages: [{ role: 'tool', content: '  Tests  1 passed (1)' }, { role: 'assistant', tool_calls: [{ function: { name: 'write_file', arguments: '{}' } }] }] });
  const a = cvClaim(svc); svc.record(a.runId, 'workstation', success(a, check(a, { chat: edits })));
  expect(JSON.parse(slot(a.runId).result_json!)).toMatchObject({ plain: true, clean: false, post_pass_edits: 1 });
  const b = cvClaim(svc);
  svc.record(b.runId, 'workstation', { status: 'discarded', reason: 'infra: maker crashed or timed out without a change', model_check: check(b), tg_metrics: { termination: 'timeout', maker_ms: 900_000 }, durationMs: 1 });
  expect(slot(b.runId)).toMatchObject({ status: 'done' });
  expect(JSON.parse(slot(b.runId).result_json!)).toMatchObject({ status: 'failure', reason: 'maker timeout (CV-001 observation)', timeout: true, clean: false, plain: false });
  const c = cvClaim(svc); // a crash stays infra: re-served
  svc.record(c.runId, 'workstation', { status: 'discarded', reason: 'infra: maker crashed or timed out without a change', model_check: check(c), tg_metrics: { termination: 'exit:1' }, durationMs: 1 });
  expect(slot(c.runId)).toMatchObject({ status: 'pending', retries: 1 });
  const d = cvClaim(svc); expect(d.task.commit).toBe(c.task.commit);
  svc.record(d.runId, 'workstation', { status: 'discarded', reason: 'task: mutant survives (tests stay green)', durationMs: 1 });
  const left = db.prepare("SELECT COUNT(*) AS n FROM cv_attempts WHERE task_key = ? AND status <> 'invalid'").get(d.task.commit) as { n: number };
  expect(left.n).toBe(0); // all 4 slots of the task (2 repeats x 2 arms) are INVALID, never served again
});

it('isolation: CV-001 runs are invisible to skill outcomes, gym statistics, the breaker, tried tasks, IRT, the diff dataset, trials and holdouts', () => {
  vi.stubEnv('GYM_STORE_DIFFS', 'true'); vi.stubEnv('GRADED_FITNESS_MODE', 'shadow');
  const svc = service(db, pool());
  const m = start(svc);
  const before = { outcomes: (db.prepare('SELECT COUNT(*) AS n FROM skill_outcomes').get() as { n: number }).n, obs: gymObservations(db).length };
  const ok = cvClaim(svc); svc.record(ok.runId, 'workstation', success(ok));
  for (let i = 0; i < 3; i++) { const c = cvClaim(svc); svc.record(c.runId, 'workstation', { status: 'discarded', reason: 'infra: npm ci failed' }); }
  expect(db.prepare("SELECT loop_name, COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.gym.cv') IS NOT NULL GROUP BY 1").all()).toEqual([{ loop_name: CV_LOOP, n: 4 }]);
  expect((db.prepare('SELECT COUNT(*) AS n FROM skill_outcomes').get() as { n: number }).n).toBe(before.outcomes);
  expect(gymObservations(db).length).toBe(before.obs);
  expect(infraFailing(db, SPECIES, new Date(NIGHT - 86_400_000).toISOString())).toBe(false);
  expect([...triedTasks(db, SPECIES)].filter((k) => m.tasks.some((t) => t.key === k))).toEqual([]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM gym_attempt_diffs').get()).toEqual({ n: 0 });
  expect((db.prepare("SELECT json_extract(metadata, '$.gym_result.diff_ref') AS r FROM loop_runs WHERE id = ?").get(ok.runId) as { r: string }).r).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(db.prepare("SELECT COUNT(*) AS n FROM loop_runs WHERE loop_name = ? AND json_extract(metadata, '$.gym.gate_policy') IS NOT NULL").get(CV_LOOP)).toEqual({ n: 0 });
  expect(exclusionReason(holdoutExclusions(db), { commit: m.tasks[0].key })).toBe('CV-001 task key');
  // off: a CV key is never served as ordinary gym work
  vi.stubEnv('CV_001_MODE', 'off');
  const plain = new RemoteGymService(db, () => m.tasks.map((t) => ({ commit: t.key, source: t.source, tests: t.tests, sourceLines: 1 })));
  expect((plain.claim('workstation', [SPECIES], tick(), CAPS) as Claim).skipped).toBe('no untried task');
});

it('a lost report settles the CV slot as an infra discard (re-served), never left claimed', () => {
  const svc = service(db, pool());
  start(svc);
  const lost = cvClaim(svc);
  const next = cvClaim(svc);
  expect(slot(lost.runId)).toMatchObject({ retries: 1 });
  expect(JSON.parse(slot(lost.runId).history_json!)[0].reason).toMatch(/^infra: worker lost the result/);
  expect([next.task.commit, next.cv!.repeat, next.cv!.arm]).toEqual([lost.task.commit, lost.cv!.repeat, lost.cv!.arm]);
});

const res = (o: Partial<CvResult>): CvResult => ({ run_id: 'r', status: 'failure', reason: '', void: null, plain: false, clean: false, timeout: false, degenerate: false, loop: false,
  post_pass_edits: 0, tool_calls: 1, broken_tool_calls: 0, http_errors: 0, termination: 'exit:0', maker_ms: 1, tokens: null, at: 'x', ...o });
const CLEAN = res({ status: 'success', plain: true, clean: true }); const PLAIN = res({ status: 'success', plain: true }); const FAIL = res({});
const pairs = (spec: Array<[number, CvResult | null, CvResult | null]>): CvPair[] => spec.flatMap(([n, A, B]) => Array.from({ length: n }, (_, i) => ({ task_key: `k${i}`, repeat: 1, A, B })));

it('decision rule: exact one-sided McNemar on clean success plus the three over-steer rules; ITT counts a censored slot as not clean', () => {
  // 100 pairs: 14 B-only clean, 2 A-only clean → +12 points, p ≈ 0.0021
  const adopt = cvPaired(pairs([[20, CLEAN, CLEAN], [14, PLAIN, CLEAN], [2, CLEAN, PLAIN], [64, FAIL, FAIL]]));
  expect(adopt).toMatchObject({ n_pairs: 100, b_only_B: 14, c_only_A: 2, clean_rate_A: 0.22, clean_rate_B: 0.34, adopt: true });
  expect(adopt.p_one_sided!).toBeCloseTo(0.0021, 4);
  expect(adopt.rules).toEqual({ clean_plus_10_and_significant: true, plain_drop_at_most_5: true, degenerate_rise_at_most_2: true, timeouts_not_higher: true });
  // +9 points even when significant is not enough
  expect(cvPaired(pairs([[10, PLAIN, CLEAN], [1, CLEAN, PLAIN], [89, FAIL, FAIL]])).rules!.clean_plus_10_and_significant).toBe(false);
  // plain success drops 6 points (clean +12): over-steer, REJECT
  const drop = cvPaired(pairs([[12, FAIL, CLEAN], [18, PLAIN, FAIL], [70, FAIL, FAIL]]));
  expect(drop.rules).toMatchObject({ clean_plus_10_and_significant: true, plain_drop_at_most_5: false }); expect(drop.adopt).toBe(false);
  // degenerate +3 points and more timeouts in B both reject
  const deg = cvPaired(pairs([[14, FAIL, CLEAN], [3, FAIL, res({ degenerate: true })], [83, FAIL, FAIL]]));
  expect(deg.rules!.degenerate_rise_at_most_2).toBe(false); expect(deg.adopt).toBe(false);
  const two = cvPaired(pairs([[14, FAIL, CLEAN], [2, FAIL, res({ degenerate: true })], [84, FAIL, FAIL]]));
  expect(two.rules!.degenerate_rise_at_most_2).toBe(true); // exactly +2 points holds
  const to = cvPaired(pairs([[14, FAIL, CLEAN], [1, FAIL, res({ timeout: true })], [85, FAIL, FAIL]]));
  expect(to.rules!.timeouts_not_higher).toBe(false);
  // ITT: a censored B slot is not clean; it is left out of the observed (degenerate / timeout) rates
  const itt = cvPaired(pairs([[1, CLEAN, null], [1, FAIL, CLEAN]]));
  expect(itt).toMatchObject({ b_only_B: 1, c_only_A: 1, observed: { A: 2, B: 1 } });
  expect(cvPaired([])).toMatchObject({ n_pairs: 0, p_one_sided: null, rules: null, adopt: null });
});

it('verdict: when every unit is complete the verdict is recorded once (REJECT also drafts negative evidence); day 28 before that is INCONCLUSIVE; a stopped experiment serves nothing', () => {
  const svc = service(db, pool());
  const m = start(svc);
  // every slot answered as a plain failure with a valid delivery proof → no clean success in either arm → REJECT
  let served = 0;
  for (;;) { const c = cvClaim(svc); if (!c.cv) break; svc.record(c.runId, 'workstation', failure(c)); served++; }
  expect(served).toBe(240);
  const s = cvState(db, m, t0);
  expect(s).toMatchObject({ verdict: 'REJECT', open_units: 0, invalid_units: 0 });
  expect(s.primary.n_pairs).toBe(120);
  const rec = db.prepare('SELECT verdict_json FROM cv_experiments').get() as { verdict_json: string };
  expect(JSON.parse(rec.verdict_json)).toMatchObject({ verdict: 'REJECT', promoted: false });
  expect(db.prepare("SELECT COUNT(*) AS n FROM judgments WHERE judgment = 'negative_evidence_draft' AND subject_id = 'cv-001'").get()).toEqual({ n: 1 });
  expect(cv001Evidence(db, process.env, t0)).toMatchObject({ status: 'stopped', verdict: 'REJECT', pairs: { done: 120, open: 0 } });
  // day 28 with open units
  const d = fresh();
  try {
    const svc2 = service(d, pool()); svc2.claim('workstation', [SPECIES], new Date(NIGHT), CAPS);
    const c = svc2.claim('workstation', [SPECIES], new Date(NIGHT + 1000), CAPS) as Claim; svc2.record(c.runId, 'workstation', failure(c));
    const m2 = cvManifest(d)!;
    expect(cvState(d, m2, NIGHT + 27 * 86_400_000).verdict).toBeNull();
    expect(cvState(d, m2, NIGHT + 28 * 86_400_000 + 2000).verdict).toBe('INCONCLUSIVE');
    expect(claimCv001(d, m2, 'r', new Date(NIGHT + 29 * 86_400_000).toISOString())).toBeNull();
  } finally { d.close(); }
});

it('off mode is identical: CV_001_MODE unset, off, or on without a model_override worker — same payload, same run row, nothing frozen', () => {
  const tasks = [{ commit: 'c1', source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 }];
  const run = (env: string | null, caps: string[]) => {
    const d = fresh();
    try {
      vi.stubEnv('CV_001_MODE', env ?? '');
      const svc = new RemoteGymService(d, () => tasks); svc.cvCandidates = () => pool();
      const c = svc.claim('workstation', [SPECIES], new Date(NIGHT), { capabilities: caps }) as Claim;
      const row = d.prepare('SELECT loop_name, mode, status, metadata, created_at FROM loop_runs').all();
      const cv = d.prepare('SELECT (SELECT COUNT(*) FROM cv_experiments) + (SELECT COUNT(*) FROM cv_attempts) AS n').get();
      return { c: JSON.stringify({ ...c, runId: 'x' }), row: JSON.stringify(row).split(c.runId).join('x'), cv };
    } finally { d.close(); }
  };
  const unset = run(null, CAPS.capabilities);
  expect(run('off', CAPS.capabilities)).toEqual(unset);
  expect(run('on', OLD_CAPS.capabilities)).toEqual(unset);
  expect(run(null, OLD_CAPS.capabilities)).toEqual(unset); // the new capability alone changes nothing
  expect(unset.cv).toEqual({ n: 0 });
  expect(unset.c).not.toContain('model_override');
});

it('registry: the worker announces model_override; CV_001_MODE and CV_001_WINDOW_UTC are acting evolution flags; CV-001 is a gym-population experiment with its own flag first; evidence cv_001', () => {
  expect(worker.CAPABILITIES).toContain('model_override');
  for (const name of ['CV_001_MODE', 'CV_001_WINDOW_UTC']) expect(EVOLUTION_FLAGS).toContainEqual({ name, acting: true });
  const def = experimentDefs().find((d) => d.id === 'CV-001')!;
  expect(def).toMatchObject({ flag: 'CV_001_MODE', population: 'gym_tasks', protocol: 'docs/research/cv-001/CV-001_PROTOCOL.md', stop_by: '2026-12-07T00:00:00.000Z' });
  expect(def.treatment_env?.[0]).toBe('CV_001_MODE');
  expect(def.treatment_env).toContain('CV_001_WINDOW_UTC');
  const ev = buildEvolutionEvidence(db, process.env, NIGHT) as unknown as { cv_001: { status: string; mode: string; serving: { open: boolean } } };
  expect(ev.cv_001).toMatchObject({ status: 'not_frozen', mode: 'on', serving: { open: true } });
});
