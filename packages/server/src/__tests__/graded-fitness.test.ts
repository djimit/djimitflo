import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { gradedContestMode, gradedFitnessMode, gradedRefs, leaseGradedRefs, parseGraded, recordMakerGraded, type KillRunner } from '../services/graded-fitness';

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
