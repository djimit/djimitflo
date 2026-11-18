import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { GRADED_MUTANTS_V2, gradedContestMode, gradedEvidence, gradedFitnessMode, gradedMutants, gradedRefs, gradedTarget, leaseGraded, leaseGradedRefs, mutationScoreOf, parseGraded, recordMakerGraded, type KillRunner } from '../services/graded-fitness';
import { autoMergeValueSignal } from '../services/loop-auto-merge-state';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { WRITE_TEST_MUTANTS } from '../services/gym-failure-tasks';

const TARGET = 'packages/server/src/services/widget.ts';
const TEST = 'packages/server/src/__tests__/widget.test.ts';
// three operator lines, so the seeded-mutant helper finds three distinct single-operator mutants
const SOURCE = 'export const a = (x: number) => x > 1;\nexport const b = (x: number) => x === 2;\nexport const c = (p: boolean, q: boolean) => p && q;\n';

let db: Database.Database; let wt: string;
const now = new Date().toISOString();
const meta = (id: string) => JSON.parse((db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(id) as { metadata: string }).metadata);
function seed(evidence: string[], changed: string[], status = 'completed') {
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, grounding_json, created_at, updated_at)
    VALUES ('p-1', 'feature', 't', 'd', 'r', 'gap_analysis', 'executing', 0.5, ?, ?, ?, ?)`).run(JSON.stringify(evidence), JSON.stringify({ artifactPath: TEST, target: TARGET }), now, now);
  db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES ('g-1', 'o', 'low', 'running', '{}', 'p-1', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, goal_id, created_at, updated_at) VALUES ('run-1', 'test-gap', 'closed', 'running', '[]', 'g-1', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, worktree_path, metadata, created_at, updated_at) VALUES ('m-1', 'run-1', 'maker', 'opencode', ?, ?, ?, ?, ?)`)
    .run(status, wt, JSON.stringify({ changed_files: changed }), now, now);
}
/** A stub vitest: green on the real target; red on a mutant whose line `kills` matches (the test notices that mutation). */
const runner = (kills: RegExp[], calls: string[] = []): KillRunner => (cwd, test) => {
  calls.push(test);
  const content = fs.readFileSync(path.join(cwd, '..', '..', TARGET), 'utf8');
  if (content === SOURCE) return 'pass';
  return kills.some((re) => re.test(content)) ? 'fail' : 'pass';
};

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  wt = fs.mkdtempSync(path.join(os.tmpdir(), 'graded-'));
  fs.mkdirSync(path.join(wt, 'packages/server/src/services'), { recursive: true }); fs.mkdirSync(path.join(wt, 'packages/server/src/__tests__'), { recursive: true });
  fs.writeFileSync(path.join(wt, TARGET), SOURCE); fs.writeFileSync(path.join(wt, TEST), "it('x', () => {});\n");
});
afterEach(() => { db.close(); fs.rmSync(wt, { recursive: true, force: true }); });

it('SI-A contract: graded:<0..1 with 3 decimals> plus graded_kind, parsed back from evidence refs', () => {
  expect(gradedRefs(2 / 3, 'mutant_kill')).toEqual(['graded:0.667', 'graded_kind:mutant_kill']);
  expect(gradedRefs(1.4, 'tests_green')).toEqual(['graded:1.000', 'graded_kind:tests_green']);
  expect(gradedRefs(-1, 'binary')).toEqual(['graded:0.000', 'graded_kind:binary']);
  expect(gradedRefs(Number.NaN, 'binary')).toEqual([]);
  expect(parseGraded(['loop_run:x', 'graded:0.333', 'graded_kind:mutant_kill'])).toEqual({ score: 0.333, kind: 'mutant_kill' });
  expect(parseGraded(['graded:abc', 'graded_kind:mutant_kill'])).toBeNull();
  expect(parseGraded(['graded:0.5', 'graded_kind:vibes'])).toBeNull();
});

it('flags: GRADED_FITNESS_MODE off|shadow and GRADED_CONTEST_MODE off|shadow|act, default off', () => {
  expect([gradedFitnessMode({}), gradedFitnessMode({ GRADED_FITNESS_MODE: 'shadow' }), gradedFitnessMode({ GRADED_FITNESS_MODE: 'act' })]).toEqual(['off', 'shadow', 'off']);
  expect([gradedContestMode({}), gradedContestMode({ GRADED_CONTEST_MODE: 'shadow' }), gradedContestMode({ GRADED_CONTEST_MODE: 'act' }), gradedContestMode({ GRADED_CONTEST_MODE: 'yes' })]).toEqual(['off', 'shadow', 'act', 'off']);
});

it('SI-A prod: off records nothing and runs nothing', () => {
  seed(['test-gap:widget'], [TEST]);
  const calls: string[] = [];
  recordMakerGraded(db, 'run-1', 'm-1', { env: {}, run: runner([/x <= 1/], calls) });
  expect(meta('m-1').graded).toBeUndefined();
  expect(calls).toEqual([]);
});

it('SI-A prod (shadow): a test-gap maker that wrote the test gets the kill share of <= 3 seeded mutants of the target; target restored', () => {
  seed(['test-gap:widget'], [TEST]);
  const calls: string[] = [];
  recordMakerGraded(db, 'run-1', 'm-1', { env: { GRADED_FITNESS_MODE: 'shadow' }, run: runner([/x <= 1/, /x !== 2/], calls) });
  const g = meta('m-1').graded;
  expect(g).toMatchObject({ kind: 'mutant_kill', lane: 'test-gap', total: 3 });
  expect(g.killed).toBe(2);
  expect(g.score).toBe(0.667);
  expect(g.ms).toBeLessThan(60_000);
  expect(calls.length).toBe(4); // baseline + 3 mutants, only the maker's test file
  expect(new Set(calls)).toEqual(new Set(['src/__tests__/widget.test.ts']));
  expect(fs.readFileSync(path.join(wt, TARGET), 'utf8')).toBe(SOURCE);
  expect(leaseGradedRefs(meta('m-1'))).toEqual([...gradedRefs(g.score, 'mutant_kill'), 'graded_lane:test-gap']);
  // idempotent: a second call (e.g. selection and outcome both ask) costs nothing
  recordMakerGraded(db, 'run-1', 'm-1', { env: { GRADED_FITNESS_MODE: 'shadow' }, run: runner([], calls) });
  expect(calls.length).toBe(4);
});

it('SI-A prod (shadow): the exports lane is its own pool', () => {
  seed(['test-gap:widget#exports'], [TEST]);
  recordMakerGraded(db, 'run-1', 'm-1', { env: { GRADED_FITNESS_MODE: 'shadow' }, run: runner([/./]) });
  expect(meta('m-1').graded).toMatchObject({ kind: 'mutant_kill', lane: 'exports', killed: 3, total: 3, score: 1 });
});

it('SI-A prod (shadow): a timeout, a red baseline or a runner crash records no graded ref and never throws', () => {
  seed(['test-gap:widget'], [TEST]);
  recordMakerGraded(db, 'run-1', 'm-1', { env: { GRADED_FITNESS_MODE: 'shadow' }, run: () => 'timeout' });
  expect(meta('m-1').graded).toMatchObject({ skipped: 'timeout' });
  expect(leaseGradedRefs(meta('m-1'))).toEqual([]);
  expect(fs.readFileSync(path.join(wt, TARGET), 'utf8')).toBe(SOURCE);
  db.prepare("UPDATE worker_leases SET metadata = json_remove(metadata, '$.graded') WHERE id = 'm-1'").run();
  recordMakerGraded(db, 'run-1', 'm-1', { env: { GRADED_FITNESS_MODE: 'shadow' }, run: () => 'fail' });
  expect(meta('m-1').graded).toMatchObject({ skipped: 'baseline red' });
  db.prepare("UPDATE worker_leases SET metadata = json_remove(metadata, '$.graded') WHERE id = 'm-1'").run();
  expect(() => recordMakerGraded(db, 'run-1', 'm-1', { env: { GRADED_FITNESS_MODE: 'shadow' }, run: () => { throw new Error('spawn ENOENT'); } })).not.toThrow();
  expect(leaseGradedRefs(meta('m-1'))).toEqual([]);
  expect(fs.readFileSync(path.join(wt, TARGET), 'utf8')).toBe(SOURCE);
});

it('SI-A prod (shadow): no test file in the diff, a failed maker or another lane is not graded', () => {
  seed(['test-gap:widget'], [TARGET]);
  const calls: string[] = [];
  recordMakerGraded(db, 'run-1', 'm-1', { env: { GRADED_FITNESS_MODE: 'shadow' }, run: runner([], calls) });
  db.prepare("UPDATE worker_leases SET status = 'failed', metadata = ? WHERE id = 'm-1'").run(JSON.stringify({ changed_files: [TEST] }));
  recordMakerGraded(db, 'run-1', 'm-1', { env: { GRADED_FITNESS_MODE: 'shadow' }, run: runner([], calls) });
  db.prepare("UPDATE worker_leases SET status = 'completed' WHERE id = 'm-1'").run();
  db.prepare("UPDATE self_improvements SET evidence_refs_json = '[\"mutation-gap:widget\"]'").run();
  recordMakerGraded(db, 'run-1', 'm-1', { env: { GRADED_FITNESS_MODE: 'shadow' }, run: runner([], calls) });
  expect(calls).toEqual([]);
  expect(meta('m-1').graded).toBeUndefined();
});

it('SI-A prod (shadow): a mutation-gap maker is graded from its own test:mutation:grounded result (after / 100), no extra runtime', () => {
  const log = path.join(wt, 'mutation.stdout.log');
  fs.writeFileSync(log, 'stryker noise\n{"mutation_gain":{"file":"x","test":"y","before":14.5,"after":98.2,"gain":83.7,"min_gain":10,"pass":true}}\n');
  seed(['mutation-gap:widget'], [TEST]);
  db.prepare('UPDATE worker_leases SET metadata = ? WHERE id = ?').run(JSON.stringify({ changed_files: [TEST], deterministic_checks: [{ name: 'lint', status: 'pass' }, { name: 'test:mutation:grounded', status: 'pass', stdout_path: log }] }), 'm-1');
  const calls: string[] = [];
  recordMakerGraded(db, 'run-1', 'm-1', { env: { GRADED_FITNESS_MODE: 'shadow' }, run: runner([], calls) });
  expect(calls).toEqual([]);
  expect(meta('m-1').graded).toMatchObject({ score: 0.982, kind: 'mutation_score', lane: 'mutation' });
  expect(leaseGradedRefs(meta('m-1'))).toEqual(['graded:0.982', 'graded_kind:mutation_score', 'graded_lane:mutation']);
  expect(parseGraded(leaseGradedRefs(meta('m-1')))).toEqual({ score: 0.982, kind: 'mutation_score' });
  // a measured 0 is a score; off records nothing
  db.prepare("UPDATE worker_leases SET metadata = json_remove(metadata, '$.graded') WHERE id = 'm-1'").run();
  fs.writeFileSync(log, '{"mutation_gain":{"before":0,"after":0,"gain":0,"pass":false}}\n');
  recordMakerGraded(db, 'run-1', 'm-1', { env: {} });
  expect(meta('m-1').graded).toBeUndefined();
  recordMakerGraded(db, 'run-1', 'm-1', { env: { GRADED_FITNESS_MODE: 'shadow' } });
  expect(leaseGradedRefs(meta('m-1'))).toEqual(['graded:0.000', 'graded_kind:mutation_score', 'graded_lane:mutation']);
});

// re-20261105 B7: with 3 seeded mutants "1 of 3" (0.333) passes the value gate's 0.2 and the graded contest ties 3/3.
// GRADED_FITNESS_MUTANTS_V2=on (default off) grades a production test-gap / exports maker against 6; the gym's write_test
// tasks (served to scripts/gym-worker.mjs, which accepts at most 5) keep WRITE_TEST_MUTANTS = 3.
it('B7 flag: GRADED_FITNESS_MUTANTS_V2 off (default, 3 = WRITE_TEST_MUTANTS) | on (6), registered as an acting flag', () => {
  expect(WRITE_TEST_MUTANTS).toBe(3);
  expect(GRADED_MUTANTS_V2).toBe(6);
  expect([gradedMutants({}), gradedMutants({ GRADED_FITNESS_MUTANTS_V2: 'on' }), gradedMutants({ GRADED_FITNESS_MUTANTS_V2: ' ON ' }), gradedMutants({ GRADED_FITNESS_MUTANTS_V2: '6' })]).toEqual([3, 6, 6, 3]);
  expect(EVOLUTION_FLAGS).toContainEqual({ name: 'GRADED_FITNESS_MUTANTS_V2', acting: true });
});

it('B7: on, a test that kills 1 seeded mutant scores 1/6 (low for the value gate); off (default) the same test scores 1/3 (pass)', () => {
  const BIG = `${SOURCE}export const d = (x: number) => x < 5 || x >= 9;\nexport const e = (x: number) => x - 1 >= 0 && x !== 7;\n`;
  fs.writeFileSync(path.join(wt, TARGET), BIG);
  // green on the real target; red on the first mutant it is run against only
  const killsOne = (): KillRunner => { let seen = 0; return (cwd) => { const c = fs.readFileSync(path.join(cwd, '..', '..', TARGET), 'utf8'); if (c === BIG) return 'pass'; seen++; return seen === 1 ? 'fail' : 'pass'; }; };
  seed(['test-gap:widget#exports'], [TEST]);
  recordMakerGraded(db, 'run-1', 'm-1', { env: { GRADED_FITNESS_MODE: 'shadow', GRADED_FITNESS_MUTANTS_V2: 'on' }, run: killsOne() });
  const on = meta('m-1').graded;
  expect(on).toMatchObject({ kind: 'mutant_kill', lane: 'exports', killed: 1, total: 6, score: 0.167 });
  expect(autoMergeValueSignal([], on)).toBe('low');
  expect(fs.readFileSync(path.join(wt, TARGET), 'utf8')).toBe(BIG);
  db.prepare("UPDATE worker_leases SET metadata = json_remove(metadata, '$.graded') WHERE id = 'm-1'").run();
  recordMakerGraded(db, 'run-1', 'm-1', { env: { GRADED_FITNESS_MODE: 'shadow' }, run: killsOne() });
  const off = meta('m-1').graded;
  expect(off).toMatchObject({ killed: 1, total: 3, score: 0.333 });
  expect(autoMergeValueSignal([], off)).toBe('pass');
});

it('parseGraded: strict graded:<0|1>.ddd anchored regex and score <= 1 bound; kind required', () => {
  expect(parseGraded(['graded:1.000', 'graded_kind:binary'])).toEqual({ score: 1, kind: 'binary' });
  // a leading junk char is rejected by the ^ anchor; a 4th decimal by the $ anchor
  expect(parseGraded(['graded:X0.333', 'graded_kind:mutant_kill'])).toBeNull();
  expect(parseGraded(['graded:0.3334', 'graded_kind:mutant_kill'])).toBeNull();
  // regex matches but score > 1 is rejected (1.500, not 2.000 which fails the [01] class)
  expect(parseGraded(['graded:1.500', 'graded_kind:mutant_kill'])).toBeNull();
  expect(parseGraded(['graded:0.333'])).toBeNull(); // no kind
});

it('gradedRefs: an invalid kind yields no refs even with a finite score', () => {
  expect(gradedRefs(0.5, 'vibes' as never)).toEqual([]);
});

it('leaseGraded: finite number + valid kind required; missing kind or non-number score is null', () => {
  expect(leaseGraded({})).toBeNull();
  expect(leaseGraded({ graded: { score: 0.5 } })).toBeNull();
  expect(leaseGraded({ graded: { score: 'x', kind: 'mutant_kill' } })).toBeNull();
  expect(leaseGraded({ graded: { score: Number.NaN, kind: 'mutant_kill' } })).toBeNull();
  expect(leaseGraded({ graded: { score: 0.5, kind: 'mutant_kill' } })).toEqual({ score: 0.5, kind: 'mutant_kill' });
  expect(leaseGraded({ graded: { score: 2, kind: 'mutant_kill', lane: 'test-gap' } })).toEqual({ score: 1, kind: 'mutant_kill', lane: 'test-gap' });
});

it('gradedTarget: the grounding target when it is a service file, else the test namesake; strict anchored service regex', () => {
  expect(gradedTarget('packages/server/src/__tests__/widget.test.ts', 'packages/server/src/services/other.ts')).toBe('packages/server/src/services/other.ts');
  expect(gradedTarget('packages/server/src/__tests__/widget.test.ts', null)).toBe('packages/server/src/services/widget.ts');
  expect(gradedTarget('packages/server/src/__tests__/widget.test.ts', 'not/a/service.ts')).toBe('packages/server/src/services/widget.ts');
  // a prefixed path fails the ^ anchor of the test regex -> throws (a relaxed mutant would return the namesake)
  expect(() => gradedTarget('foo/packages/server/src/__tests__/widget.test.ts', null)).toThrow();
});

it('mutationScoreOf: parses the after score from the mutation-gain JSON line; measured 0 is 0, missing/unreadable is null', () => {
  const log = (s: string) => { const p = path.join(wt, `m-${Math.random()}.log`); fs.writeFileSync(p, s); return p; };
  expect(mutationScoreOf([{ name: 'test:mutation:grounded', stdout_path: log('{"after":98.25}') }])).toBe(98.25);
  expect(mutationScoreOf([{ name: 'test:mutation:grounded', stdout_path: log('{"after":0}') }])).toBe(0);
  expect(mutationScoreOf([{ name: 'test:mutation:grounded', stdout_path: log('no after here') }])).toBeNull();
  expect(mutationScoreOf([{ name: 'lint' }])).toBeNull();
  expect(mutationScoreOf([{ name: 'test:mutation:grounded', stdout_path: '/no/such/file.log' }])).toBeNull();
});

it('SI-A prod (shadow): a runner crash records the error message (no "Error: " prefix) and restores the target', () => {
  seed(['test-gap:widget'], [TEST]);
  expect(() => recordMakerGraded(db, 'run-1', 'm-1', { env: { GRADED_FITNESS_MODE: 'shadow' }, run: () => { throw new Error('spawn ENOENT'); } })).not.toThrow();
  expect(meta('m-1').graded.skipped).toBe('error: spawn ENOENT');
  expect(fs.readFileSync(path.join(wt, TARGET), 'utf8')).toBe(SOURCE);
});

it('SI-A prod (shadow): a target with no valid single-operator mutant records skipped "no mutant" (not a NaN score)', () => {
  const NO_OP = 'export const x = 1;\n';
  fs.writeFileSync(path.join(wt, TARGET), NO_OP);
  seed(['test-gap:widget'], [TEST]);
  recordMakerGraded(db, 'run-1', 'm-1', { env: { GRADED_FITNESS_MODE: 'shadow' }, run: runner([/./]) });
  expect(meta('m-1').graded).toMatchObject({ skipped: 'no mutant' });
});

it('SI-A prod (shadow): a non-test-gap / non-exports / non-mutation lane is not graded', () => {
  seed(['doc-drift:widget'], [TEST]);
  const calls: string[] = [];
  recordMakerGraded(db, 'run-1', 'm-1', { env: { GRADED_FITNESS_MODE: 'shadow' }, run: runner([/./], calls) });
  expect(calls).toEqual([]);
  expect(meta('m-1').graded).toBeUndefined();
});

it('SI-A prod (shadow): an unreadable proposal (unknown run id) never throws and records nothing', () => {
  seed(['test-gap:widget'], [TEST]);
  expect(() => recordMakerGraded(db, 'no-such-run', 'm-1', { env: { GRADED_FITNESS_MODE: 'shadow' }, run: runner([/./]) })).not.toThrow();
  expect(meta('m-1').graded).toBeUndefined();
});

it('SI-A/SI-B evidence: gradedEvidence aggregates per-pool n/mean/share_full and contest agreement; empty db is null, never zero', () => {
  db.exec(`CREATE TABLE IF NOT EXISTS skill_outcomes (id TEXT PRIMARY KEY, skill_id TEXT NOT NULL DEFAULT '', success INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, domain TEXT NOT NULL DEFAULT '', task_id TEXT, agent_id TEXT, model TEXT,
    evidence_refs_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)`);
  const at = new Date(Date.now() - 1000).toISOString();
  const out = db.prepare('INSERT INTO skill_outcomes (id, skill_id, success, domain, evidence_refs_json, created_at) VALUES (?, ?, 1, ?, ?, ?)');
  const g = (score: string, kind: string, ...extra: string[]) => JSON.stringify([`graded:${score}`, `graded_kind:${kind}`, ...extra]);
  out.run('w1', 's', 'gym', g('1.000', 'mutant_kill', 'gym:fail'), at);
  out.run('w2', 's', 'gym', g('0.500', 'mutant_kill', 'gym:fail'), at);
  out.run('r1', 's', 'gym', g('0.500', 'tests_green'), at);
  out.run('t1', 's', 'test-gap', g('0.667', 'mutant_kill', 'graded_lane:test-gap'), at);
  out.run('x1', 's', 'test-gap', g('1.000', 'mutant_kill', 'graded_lane:exports'), at);
  out.run('m1', 's', 'doc-drift', g('0.982', 'mutation_score', 'graded_lane:mutation'), at);
  out.run('bad', 's', 'gym', '["graded:0.5"]', at); // no kind -> not parsed
  out.run('plain', 's', 'gym', '[]', at);
  db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES ('c', 'test-gap', 'closed', 'completed', '[]', ?, ?)").run(at, at);
  const ev = db.prepare("INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, 'c', 'contest_graded', 'info', 'm', ?, ?)");
  ev.run('e1', JSON.stringify({ agree: 1 }), at); ev.run('e2', JSON.stringify({ agree: 0 }), at); ev.run('e3', JSON.stringify({ agree: 1 }), at);
  const e = gradedEvidence(db, at, { GRADED_FITNESS_MODE: 'shadow', GRADED_CONTEST_MODE: 'shadow' });
  expect(e.mode).toEqual({ fitness: 'shadow', contest: 'shadow' });
  expect(e.pools).toEqual([
    { pool: 'gym_write_test', n: 2, mean: 0.75, share_full: 0.5 },
    { pool: 'gym_repair', n: 1, mean: 0.5, share_full: 0 },
    { pool: 'prod_test_gap', n: 1, mean: 0.667, share_full: 0 },
    { pool: 'prod_exports', n: 1, mean: 1, share_full: 1 },
    { pool: 'prod_mutation', n: 1, mean: 0.982, share_full: 0 },
  ]);
  expect(e.contest).toEqual({ contests: 3, agree: 2, agreement_rate: 0.667 });
  // a bare database (no tables) reports null means / null agreement rate, never zeros
  const bare = new Database(':memory:');
  const b = gradedEvidence(bare, at);
  expect(b.pools.every((p) => p.n === 0 && p.mean === null && p.share_full === null)).toBe(true);
  expect(b.contest).toEqual({ contests: 0, agree: 0, agreement_rate: null });
  bare.close();
});
