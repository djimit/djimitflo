import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { analyse, armOrder, freezeManifest, manifestIntact, runArm, type AbcDeps, type AbcRow } from '../services/project-room-abc';
import type { LoopService } from '../services/loop-service';

let root: string; let repo: string; let solution: string;
const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const commit = (m: string) => { git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-q', '-m', m); return git('rev-parse', 'HEAD'); };
const FIX = 'function sum(a, b) { return a + b; }\nmodule.exports = { sum };\n';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-abc-')); repo = path.join(root, 'origin'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'sum.js'), 'function sum(a, b) { return a - b; }\nmodule.exports = { sum };\n');
  git('init', '-q'); commit('init');
  fs.writeFileSync(path.join(repo, 'sum.js'), FIX);
  fs.writeFileSync(path.join(repo, 'sum.test.js'), "const test = require('node:test'); const assert = require('node:assert');\nconst { sum } = require('./sum');\ntest('adds', () => assert.strictEqual(sum(2, 3), 5));\n");
  solution = commit('sum adds its arguments');
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

const mine = () => [{ commit: solution, source: 'sum.js', tests: ['sum.test.js'], sourceLines: 2 }];
const plan = { sources: [{ path: 'sum.js' }], decisions: ['add'], assumptions: [], uncertainties: [], open_questions: [], findings_review: [], steps: [{ id: 's1', title: 'add', depends_on: [], scope: ['sum.js'], expected_artifacts: [], verification: ['test:changed'] }], stop_conditions: [], recovery: 'revert' };
const review = { reusable_components: [], claims: [{ id: 'c1', claim: 'sum subtracts', refs: [{ path: 'sum.js' }] }], interfaces: [], invariants: [], failure_modes: [], assumptions: [], open_questions: [], proposal: 'change the operator' };
/** scripted adapters: the "maker" fixes the file only when its prompt carries a plan — so the arms differ by construction */
const deps = (seen: string[]): AbcDeps => ({
  runtime: 'codex',
  prepare: (loops: LoopService) => { vi.spyOn(loops, 'getRuntimeContract').mockReturnValue({ available: true, status: 'ok' } as ReturnType<LoopService['getRuntimeContract']>); },
  profileRunner: () => async (req) => { seen.push(req.profile);
    const out = req.profile === 'architecture-reviewer' ? review : { ...plan, findings_review: req.profile === 'implementation-planner' ? [{ claim_id: 'c1', status: 'confirmed', note: '' }] : [] };
    return { stdout: '```json\n' + JSON.stringify(out) + '\n```', runtime: 'scripted-test-adapter', model: null, tokens: 500, harness: 'vitest', read_only: { enforced_by: 'scripted', tree_clean: true } }; },
  engine: (db: Database.Database) => ({ executeTask: async (taskId: string) => {
    const t = db.prepare('SELECT description, metadata FROM tasks WHERE id = ?').get(taskId) as { description: string; metadata: string };
    if (t.description.includes('Engineering plan (project room)')) fs.writeFileSync(path.join(JSON.parse(t.metadata).workingDirectory, 'sum.js'), FIX);
    return { status: 'running', completion: Promise.resolve({ status: 'completed', message: 'ok', stdout: '', stderr: '' }) };
  } }),
});

it('freezes real tasks only, with a digest, and never pads a set', () => {
  expect(() => freezeManifest(repo, { seed: 1, check: ['node', '--test', '{tests}'], mine })).toThrow(/PR_ABC_NOT_ENOUGH_TASKS: 1 mined, 30 needed/);
  const m = freezeManifest(repo, { seed: 1, dev: 1, holdout: 0, check: ['node', '--test', '{tests}'], mine });
  expect(m.tasks).toEqual([{ id: solution.slice(0, 12), set: 'dev', commit: solution, parent: git('rev-parse', `${solution}^`), source: 'sum.js', tests: ['sum.test.js'], subject: 'sum adds its arguments' }]);
  expect(manifestIntact(m)).toBe(true);
  expect(manifestIntact({ ...m, seed: 2 })).toBe(false);
  expect(armOrder('x')).toEqual(armOrder('x'));
  expect([...armOrder('x')].sort()).toEqual(['A', 'B', 'C']);
});

it('runs each arm in its own workspace without the solution, with the same maker, and scores the hidden check (scripted adapters)', async () => {
  const m = freezeManifest(repo, { seed: 1, dev: 1, holdout: 0, check: ['node', '--test', '{tests}'], mine });
  const seen: string[] = []; const before = { mode: process.env.COMMONS_PROJECT_ROOM_MODE, wt: process.env.LOOP_WORKTREE_ROOT };
  const rows: AbcRow[] = [];
  for (const arm of armOrder(m.tasks[0].id)) rows.push(await runArm(m, m.tasks[0], arm, repo, deps(seen), path.join(root, 'work')));
  const by = Object.fromEntries(rows.map((r) => [r.arm, r]));
  expect(by.A).toMatchObject({ observation: 'FAIL', reason: 'hidden check exit 1', plan_version: null, tokens: 0 });
  expect(by.B).toMatchObject({ observation: 'PASS', plan_version: 1, tokens: 500 });   // one planner call
  expect(by.C).toMatchObject({ observation: 'PASS', plan_version: 1, tokens: 1000 });  // reviewer + planner, same budget
  expect(seen.sort()).toEqual(['architecture-reviewer', 'implementation-planner', 'single-planner']);
  for (const arm of ['A', 'B', 'C']) {
    const clone = path.join(root, 'work', `${m.tasks[0].id}-${arm}`, 'repo');
    expect(() => execFileSync('git', ['-C', clone, 'cat-file', '-e', `${solution}^{commit}`], { stdio: 'ignore' })).toThrow(); // the solution is not in the workspace
    expect(fs.existsSync(path.join(clone, 'sum.test.js'))).toBe(false); // the hidden test never reached the planner's source
  }
  expect({ mode: process.env.COMMONS_PROJECT_ROOM_MODE, wt: process.env.LOOP_WORKTREE_ROOT }).toEqual(before);
  // a check that cannot run is an evaluation error, not a task failure
  const broken = await runArm({ ...m, check: ['definitely-not-a-command-xyz'] }, m.tasks[0], 'B', repo, deps([]), path.join(root, 'work2'));
  expect(broken).toMatchObject({ observation: 'EVALUATION_ERROR', reason: expect.stringMatching(/check did not run/) });
});

it('analysis keeps every task in the denominator and reports paired differences only where both arms were scored', () => {
  const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, set: 'holdout' as const, commit: '', parent: '', source: '', tests: [], subject: '' }));
  const m = { schema_version: 1 as const, experiment: 'PR-ABC-001' as const, frozen_at_commit: '', seed: 1, budget: { max_tokens: 1, max_runtime_ms: 1 }, check: [], tasks, digest: 'x' };
  const row = (task: string, arm: 'A' | 'B' | 'C', observation: AbcRow['observation'], tokens: number | null = 100): AbcRow => ({ task, set: 'holdout', arm, order: 0, observation, reason: null, tokens, duration_ms: 1, plan_version: null });
  const rows = [
    ...['t0', 't1', 't2', 't3', 't4', 't5'].map((t) => row(t, 'C', 'PASS')), row('t6', 'C', 'EVALUATION_ERROR'),
    ...['t0', 't1', 't2'].map((t) => row(t, 'B', 'PASS')), ...['t3', 't4', 't5', 't6'].map((t) => row(t, 'B', 'FAIL')),
    row('t0', 'A', 'FAIL'), row('t0', 'A', 'PASS'), // a rerun replaces the row: still one task
  ];
  const a = analyse(m, rows, 'holdout');
  expect(a.arms.C).toMatchObject({ n_tasks: 8, PASS: 6, FAIL: 0, EVALUATION_ERROR: 1, NOT_RUN: 1, pass_rate_of_all: 0.75 });
  expect(a.arms.A).toMatchObject({ n_tasks: 8, PASS: 1, NOT_RUN: 7 });
  expect(a.paired[0]).toMatchObject({ comparison: 'C − B', usable_pairs: 6, dropped_pairs: 2, both_pass: 3, only_first: 3, only_second: 0, diff: 0.5, status: 'ok' });
  expect(a.paired[0].ci95).toHaveLength(2);
  expect(a.paired[1]).toMatchObject({ comparison: 'B − A', usable_pairs: 1, ci95: null, status: 'insufficient' }); // too few pairs: not "no difference"
  expect(analyse(m, [row('t0', 'C', 'PASS', null)], 'holdout').arms.C.tokens_per_pass).toBeNull(); // unknown cost stays unknown
});
