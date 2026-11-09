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
import { scopeRepairPlan, repairMakerScope } from '../services/maker-scope-repair';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { experimentDefs } from '../services/experiment-registry';
import type { LoopFinding, LoopRunRecord, WorkerLeaseRecord } from '../services/loop-types';

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
  // a null scope with only a tracked manifest still repairs nothing (no scope to hold the maker to)
  expect(scopeRepairPlan(null, ['package.json'], [])).toBeNull();
  // a manifest under .djimitflo/ is inside-scope noise, never an outside manifest to restore
  expect(scopeRepairPlan(TEST, [TEST, '.djimitflo/package.json'], [])).toBeNull();
});

// Direct unit tests of repairMakerScope exercise the guard, the allowedScope branches (auto-approved file, objective-mode
// finding file, DB artifactPath fallback) and the git-failure catch that the integration fixture does not reach.
const SCOPE_FILE = 'src/foo.ts';
const ARTIFACT = 'src/foo.ts';

function directDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE goals (id TEXT PRIMARY KEY, improvement_id TEXT);
    CREATE TABLE self_improvements (id TEXT PRIMARY KEY, evidence_refs_json TEXT, grounding_json TEXT);`);
  dbs.push(db);
  return db;
}

function seedLane(db: Database.Database, goalId: string, impId: string, lane: 'test-gap' | 'mutation', artifact = ARTIFACT): void {
  db.prepare("INSERT INTO self_improvements (id, evidence_refs_json, grounding_json) VALUES (?, ?, ?)").run(
    impId, lane === 'mutation' ? '"mutation-gap:x"' : '"test-gap:x"', JSON.stringify({ artifactPath: artifact }));
  db.prepare('INSERT INTO goals (id, improvement_id) VALUES (?, ?)').run(goalId, impId);
}

function directRun(goalId: string | null, loopName = 'doc-drift-and-small-fix-loop', findings: LoopFinding[] = []): LoopRunRecord {
  return { id: 'run-1', goal_id: goalId, loop_name: loopName, mode: 'closed', status: 'running', repository_path: null,
    state_file: null, findings, plan: {}, gates: [], next_actions: [], metadata: {},
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', completed_at: null };
}

function directLease(overrides: Partial<WorkerLeaseRecord> = {}): WorkerLeaseRecord {
  return { id: 'lease-1', loop_run_id: 'run-1', role: 'maker', runtime: 'opencode', status: 'completed', finding_id: null,
    worktree_path: '/tmp/worktree', branch_name: 'b', budget: {}, metadata: {}, created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z', parent_lease_id: null, spawn_tree_id: null, depth: 0, spawned_by_agent_id: null,
    ...overrides };
}

/** A git stub that reports the scope file plus one root manifest as the only changes (all tracked, none untracked). */
function manifestGit(): (cwd: string, args: string[]) => string {
  return (_cwd: string, args: string[]) => {
    if (args[0] === 'diff') return `${SCOPE_FILE}\npackage.json\n`;
    if (args[0] === 'ls-files') return '';
    if (args[0] === 'rev-parse') return 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    return '';
  };
}

describe('repairMakerScope guard', () => {
  it('a non-maker lease is never repaired even when the rest of the setup would repair', () => {
    const db = directDb(); seedLane(db, 'g1', 'imp-1', 'test-gap');
    expect(repairMakerScope(db, directRun('g1'), directLease({ role: 'checker', metadata: { auto_approved_scope: SCOPE_FILE } }), manifestGit())).toBeNull();
  });

  it('a maker lease without a worktree_path is never repaired', () => {
    const db = directDb(); seedLane(db, 'g1', 'imp-1', 'test-gap');
    expect(repairMakerScope(db, directRun('g1'), directLease({ worktree_path: null, metadata: { auto_approved_scope: SCOPE_FILE } }), manifestGit())).toBeNull();
  });

  it('a tg-001 maker lease is never repaired', () => {
    const db = directDb(); seedLane(db, 'g1', 'imp-1', 'test-gap');
    expect(repairMakerScope(db, directRun('g1', 'tg-001'), directLease({ metadata: { auto_approved_scope: SCOPE_FILE } }), manifestGit())).toBeNull();
  });

  it('an evolution-gym maker lease is never repaired', () => {
    const db = directDb(); seedLane(db, 'g1', 'imp-1', 'test-gap');
    expect(repairMakerScope(db, directRun('g1', 'evolution-gym'), directLease({ metadata: { auto_approved_scope: SCOPE_FILE } }), manifestGit())).toBeNull();
  });

  it('a git failure leaves the tree untouched and returns null (not a throw)', () => {
    const db = directDb(); seedLane(db, 'g1', 'imp-1', 'test-gap');
    const git = (): string => { throw new Error('git blew up'); };
    expect(repairMakerScope(db, directRun('g1'), directLease({ metadata: { auto_approved_scope: SCOPE_FILE } }), git)).toBeNull();
  });
});

describe('repairMakerScope allowedScope branches', () => {
  it('falls back to the goal artifactPath when no auto_approved_scope and no objective finding, and repairs', () => {
    const db = directDb(); seedLane(db, 'g1', 'imp-1', 'test-gap', SCOPE_FILE);
    const out = repairMakerScope(db, directRun('g1', 'doc-drift-and-small-fix-loop', []), directLease(), manifestGit());
    expect(out).toMatchObject({ restored: ['package.json'], scope: SCOPE_FILE, lane: 'test-gap' });
  });

  it('keeps the auto_approved_scope when it differs from the artifact, so a non-manifest outside file blocks repair', () => {
    const db = directDb(); seedLane(db, 'g1', 'imp-1', 'test-gap', SCOPE_FILE);
    // scope held to other.ts, but the changed files are the artifact (src/foo.ts) + a manifest; src/foo.ts is not a manifest
    expect(repairMakerScope(db, directRun('g1'), directLease({ metadata: { auto_approved_scope: 'other.ts' } }), manifestGit())).toBeNull();
  });

  it('an objective-mode finding whose file differs from the artifact uses the finding file, so a non-manifest outside file blocks repair', () => {
    const db = directDb(); seedLane(db, 'g1', 'imp-1', 'mutation', SCOPE_FILE);
    const finding: LoopFinding = { id: 'f1', type: 'test_gap', severity: 'info', file: 'other.ts', message: 'm', evidence: 'e', suggested_fix: 's', metadata: { objective_mode: true } };
    expect(repairMakerScope(db, directRun('g1', 'doc-drift-and-small-fix-loop', [finding]), directLease({ finding_id: 'f1' }), manifestGit())).toBeNull();
  });

  it('a non-objective finding whose file differs from the artifact falls through to the artifact and repairs', () => {
    const db = directDb(); seedLane(db, 'g1', 'imp-1', 'test-gap', SCOPE_FILE);
    const finding: LoopFinding = { id: 'f1', type: 'test_gap', severity: 'info', file: 'other.ts', message: 'm', evidence: 'e', suggested_fix: 's', metadata: { objective_mode: false } };
    const out = repairMakerScope(db, directRun('g1', 'doc-drift-and-small-fix-loop', [finding]), directLease({ finding_id: 'f1' }), manifestGit());
    expect(out).toMatchObject({ restored: ['package.json'], scope: SCOPE_FILE, lane: 'test-gap' });
  });
});

it('registered: an acting evolution flag and a treatment variable of every running oracle-population experiment', () => {
  expect(EVOLUTION_FLAGS).toContainEqual({ name: 'MAKER_SCOPE_REPAIR', acting: true });
  const runbook = fs.readFileSync(path.resolve(__dirname, '../../../../docs/runbooks/self-improvement-loop-operations.md'), 'utf8');
  expect(runbook).toContain('| `MAKER_SCOPE_REPAIR` |');
  const oracle = experimentDefs().filter((d) => d.treatment_env?.includes('SKILL_ROUTE_MODE')).map((d) => d.id);
  expect(oracle.length).toBeGreaterThan(0);
  expect(experimentDefs().filter((d) => d.treatment_env?.includes('MAKER_SCOPE_REPAIR')).map((d) => d.id)).toEqual(oracle);
});
