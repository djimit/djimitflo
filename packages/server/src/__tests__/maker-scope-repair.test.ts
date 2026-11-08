import { afterEach, describe, expect, it, vi } from 'vitest';
// Fixture runtimes report fake versions; admission is exercised in runtime-admission.test.ts.
process.env.RUNTIME_ADMISSION_MODE = 'shadow';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { GoalService } from '../services/goal-service';
import { scopeRepairPlan } from '../services/maker-scope-repair';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { experimentDefs } from '../services/experiment-registry';

/**
 * MAKER_SCOPE_REPAIR: an oracle-lane maker that wrote its test and also rewrote package.json / package-lock.json (prod: the
 * runtime ran `npm install-scripts approve`) has exactly those manifests restored to the base before the gates; anything else
 * out of scope is left alone and the scope gate fails as today. Off: unchanged.
 */
const TEST = 'packages/server/src/__tests__/foo.test.ts';
const roots: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const d of dbs.splice(0)) d.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const BASE_FILES: Record<string, string> = {
  'package.json': '{ "name": "root", "workspaces": ["packages/*"] }\n',
  'package-lock.json': '{ "name": "root", "lockfileVersion": 3 }\n',
  'packages/server/package.json': '{ "name": "@x/server" }\n',
  'packages/server/package-lock.json': '{ "name": "@x/server", "lockfileVersion": 3 }\n',
  'packages/server/src/services/foo.ts': 'export const foo = 1;\n',
  'README.md': 'fixture\n',
};

interface Opts { refs?: string; autoScope?: boolean; objective?: boolean }
function fixture({ refs = '["test-gap:packages/server/src/services/foo.ts"]', autoScope = true, objective = false }: Opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-msr-')); roots.push(root);
  vi.stubEnv('LOOP_WORKTREE_ROOT', path.join(root, 'worktrees'));
  const repo = path.join(root, 'repo');
  for (const [f, c] of Object.entries(BASE_FILES)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), c); }
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base'], { cwd: repo, stdio: 'ignore' });
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); dbs.push(db);
  const goalId = new GoalService(db).createGoal({ objective: 'Add a test', acceptance_criteria: ['pass'], risk_class: 'low', metadata: { source: 'self-improvement' } }).id;
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, grounding_json, evidence_refs_json, created_at, updated_at)
    VALUES ('imp', 'feature', 't', 'Test-only.', 'r', 'gap_analysis', 'executing', 0.6, ?, ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ artifactPath: TEST }), refs);
  db.prepare("UPDATE goals SET improvement_id = 'imp' WHERE id = ?").run(goalId);
  const loops = new LoopService(db, path.join(root, 'evidence'));
  db.prepare(`INSERT INTO loop_runs (id,goal_id,loop_name,mode,status,repository_path,findings_json,metadata) VALUES ('run',?,'doc-drift-and-small-fix-loop','closed','running',?,?,?)`).run(goalId, repo,
    JSON.stringify([{ id: 'finding', type: 'test_gap', severity: 'info', file: TEST, message: 'Add a test', evidence: 'gap', suggested_fix: 'test', ...(objective ? { metadata: { objective_mode: true } } : {}) }]),
    JSON.stringify({ risk_class: 'low' }));
  const assignment = path.join(root, 'assignment.md'); fs.writeFileSync(assignment, 'Fixture assignment');
  loops.insertWorkerLease({ id: 'maker', loopRunId: 'run', role: 'maker', runtime: 'mock', findingId: 'finding', worktreePath: repo, branchName: null, now: new Date().toISOString(),
    metadata: { assignment_file: assignment, ...(autoScope ? { auto_approved_scope: TEST } : {}) } });
  loops.insertWorkerLease({ id: 'checker', loopRunId: 'run', role: 'checker', runtime: 'manual', findingId: 'finding', worktreePath: null, branchName: null, now: new Date().toISOString(), metadata: { maker_lease_id: 'maker' } });
  db.prepare("UPDATE worker_leases SET status = 'prepared' WHERE id = 'maker'").run();
  return { db, loops, repo };
}

/** The maker writes the test plus `writes` (file → content), then verification runs; returns what the gates and the tree saw. */
async function makerRun(writes: Record<string, string>, opts: Opts = {}, flag?: string) {
  if (flag) vi.stubEnv('MAKER_SCOPE_REPAIR', flag);
  const { db, loops, repo } = fixture(opts);
  const all = { [TEST]: "import { it } from 'vitest'; it('x', () => {});\n", ...writes };
  const script = Object.entries(all).map(([f, c]) => `fs.mkdirSync(path.dirname(${JSON.stringify(f)}), { recursive: true }); fs.writeFileSync(${JSON.stringify(f)}, ${JSON.stringify(c)});`).join('');
  vi.spyOn(loops, 'buildRuntimeCommand').mockReturnValue({ command: process.execPath, args: ['-e', `const fs = require("fs"), path = require("path"); ${script}`] });
  await loops.executeMaker('run', { lease_id: 'maker' });
  const lease = loops.getWorkerLease('maker');
  const gates = loops.verifyLoopRun('run').gates;
  const gate = (name: string) => gates.find((g) => g.name === name)?.status;
  const dirty = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => l.slice(3)).sort();
  const events = db.prepare("SELECT metadata FROM loop_events WHERE event_type = 'maker_scope_repaired'").all() as Array<{ metadata: string }>;
  return { lease, gate, dirty, events, repo };
}

const NPM_PKG = '{ "name": "root", "workspaces": ["packages/*"], "allowScripts": { "esbuild": true } }\n';

describe('MAKER_SCOPE_REPAIR=on', () => {
  it('package.json the only extra change: restored to base, the scope gate passes on the repaired tree, the repair is recorded', async () => {
    const r = await makerRun({ 'package.json': NPM_PKG }, {}, 'on');
    expect(fs.readFileSync(path.join(r.repo, 'package.json'), 'utf8')).toBe(BASE_FILES['package.json']);
    expect(r.dirty).toEqual([TEST]);
    expect(r.lease.status).toBe('completed');
    expect(r.lease.metadata.changed_files).toEqual([TEST]);
    expect(r.gate('auto_approved_scope')).toBe('pass');
    expect(r.lease.metadata.scope_repair).toEqual({ restored: ['package.json'], at: expect.any(String), base: expect.stringMatching(/^[0-9a-f]{40}$/), scope: TEST, lane: 'test-gap' });
    expect(r.events).toHaveLength(1);
    expect(JSON.parse(r.events[0].metadata)).toMatchObject({ maker_lease_id: 'maker', restored: ['package.json'], scope: TEST });
  });

  it('package.json + root lockfile (npm install-scripts approve) and a workspace lockfile-only extra are both repaired', async () => {
    const both = await makerRun({ 'package.json': NPM_PKG, 'package-lock.json': '{ "changed": true }\n' }, {}, 'on');
    expect(both.lease.metadata.scope_repair).toMatchObject({ restored: ['package-lock.json', 'package.json'] });
    expect(both.gate('auto_approved_scope')).toBe('pass');
    const lock = await makerRun({ 'packages/server/package-lock.json': '{ "changed": true }\n' }, {}, 'on');
    expect(lock.lease.metadata.scope_repair).toMatchObject({ restored: ['packages/server/package-lock.json'] });
    expect(lock.lease.metadata.changed_files).toEqual([TEST]);
    expect(lock.gate('auto_approved_scope')).toBe('pass');
    expect(fs.readFileSync(path.join(lock.repo, 'packages/server/package-lock.json'), 'utf8')).toBe(BASE_FILES['packages/server/package-lock.json']);
  });

  it('a mutation-gap objective-mode maker (objective_scope gate) is repaired the same way', async () => {
    const r = await makerRun({ 'packages/server/package.json': '{ "name": "@x/server", "scripts": {} }\n' },
      { refs: '["mutation-gap:packages/server/src/services/foo.ts"]', autoScope: false, objective: true }, 'on');
    expect(r.lease.metadata.scope_repair).toMatchObject({ restored: ['packages/server/package.json'], lane: 'mutation' });
    expect(r.gate('objective_scope')).toBe('pass');
  });

  it('an extra src file is NOT repaired: nothing restored, the scope gate fails as today', async () => {
    const r = await makerRun({ 'package.json': NPM_PKG, 'packages/server/src/services/foo.ts': 'export const foo = 2;\n' }, {}, 'on');
    expect(fs.readFileSync(path.join(r.repo, 'package.json'), 'utf8')).toBe(NPM_PKG);
    expect(r.lease.metadata.scope_repair).toBeUndefined();
    expect(r.events).toHaveLength(0);
    expect(r.gate('auto_approved_scope')).toBe('fail');
  });

  it('outside the oracle test lanes nothing is repaired', async () => {
    const r = await makerRun({ 'package.json': NPM_PKG }, { refs: '["reflection:x"]' }, 'on');
    expect(fs.readFileSync(path.join(r.repo, 'package.json'), 'utf8')).toBe(NPM_PKG);
    expect(r.lease.metadata.scope_repair).toBeUndefined();
    expect(r.gate('auto_approved_scope')).toBe('fail');
  });
});

it('MAKER_SCOPE_REPAIR off (default) = unchanged: package.json stays, the scope gate fails, nothing recorded', async () => {
  for (const flag of [undefined, 'shadow']) {
    const r = await makerRun({ 'package.json': NPM_PKG }, {}, flag);
    expect(fs.readFileSync(path.join(r.repo, 'package.json'), 'utf8')).toBe(NPM_PKG);
    expect(r.lease.metadata.changed_files).toEqual(['package.json', TEST]);
    expect(r.lease.metadata.scope_repair).toBeUndefined();
    expect(r.events).toHaveLength(0);
    expect(r.gate('auto_approved_scope')).toBe('fail');
    vi.unstubAllEnvs();
  }
});

it('scopeRepairPlan: only tracked manifests outside the scope, nothing else', () => {
  expect(scopeRepairPlan(TEST, ['package.json', TEST], [])).toEqual(['package.json']);
  expect(scopeRepairPlan(TEST, ['packages/a/package-lock.json'], [TEST])).toEqual(['packages/a/package-lock.json']);
  expect(scopeRepairPlan(TEST, [TEST], ['.djimitflo/LOOP_WORK.md'])).toBeNull(); // nothing out of scope
  expect(scopeRepairPlan(TEST, ['package.json', 'src/a.ts'], [])).toBeNull();
  expect(scopeRepairPlan(TEST, ['package.json'], ['packages/new/package.json'])).toBeNull(); // a new manifest has no base
  expect(scopeRepairPlan(TEST, ['package.json.bak'], [])).toBeNull();
  expect(scopeRepairPlan(null, ['package.json'], [TEST])).toBeNull();
});

it('registered: an acting evolution flag and a treatment variable of every running oracle-population experiment', () => {
  expect(EVOLUTION_FLAGS).toContainEqual({ name: 'MAKER_SCOPE_REPAIR', acting: true });
  const runbook = fs.readFileSync(path.resolve(__dirname, '../../../../docs/runbooks/self-improvement-loop-operations.md'), 'utf8');
  expect(runbook).toContain('| `MAKER_SCOPE_REPAIR` |');
  const oracle = experimentDefs().filter((d) => d.treatment_env?.includes('SKILL_ROUTE_MODE')).map((d) => d.id);
  expect(oracle.length).toBeGreaterThan(0);
  expect(experimentDefs().filter((d) => d.treatment_env?.includes('MAKER_SCOPE_REPAIR')).map((d) => d.id)).toEqual(oracle);
});
