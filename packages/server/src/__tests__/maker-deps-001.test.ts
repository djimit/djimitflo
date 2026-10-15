import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { MAKER_DEPS_001, MAKER_DEPS_001_TARGET_PER_ARM, makerDeps001Evidence, makerDeps001On, makerDepsArm, makerDepsEligible } from '../services/maker-deps-001';
import { aceArm } from '../services/ace-001';
import { steArm } from '../services/ste-001';
import { siblingArm } from '../services/effort-controller';
import { checkerFamilyArm } from '../services/checker-family';
import { TG_LOOP } from '../services/tg-001';
import { buildEvolutionEvidence } from '../services/evolution-evidence';

/**
 * MAKER-DEPS-001 v1 (docs/research/di-001/MAKER_DEPS_001_PREREG.md). Arm A = today, arm B = the daemon runs the checks' own
 * `npm ci` (+ the shared build) before a local opencode maker starts. Prod shape (MAKER_FAILURES.md, lease 0328565b): a worktree
 * with a lockfile and packages/shared, no node_modules, no dist; npm 12 warns that install scripts were blocked.
 */
const roots: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const d of dbs.splice(0)) d.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** First synthetic goal id in the requested arm. */
const goalIn = (arm: 'A' | 'B', prefix = 'goal') => { for (let i = 0; ; i++) if (makerDepsArm(`${prefix}-${i}`) === arm) return `${prefix}-${i}`; };

/** A fake `npm` on PATH that behaves like npm 12.0.2 in prod: `ci` installs and warns that scripts were blocked. */
function fakeNpm(root: string, opts: { ciExit?: number } = {}) {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const log = path.join(root, 'npm-calls.log');
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  --version) echo "12.0.2"; exit 0 ;;
  ci) ${opts.ciExit ? `echo "npm error gyp ERR! not ok" >&2; exit ${opts.ciExit}` : `mkdir -p node_modules/vitest
      echo "npm warn install-scripts 2 packages had install scripts blocked because they are not covered by allowScripts:" >&2
      echo "npm warn install-scripts   better-sqlite3@13.0.3 (install: node-gyp rebuild)" >&2; exit 0`} ;;
  run) mkdir -p packages/shared/dist && echo "export {}" > packages/shared/dist/index.js; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
}

const LOCK = '{"lockfileVersion":3}';
function fixture(runtime: string, opts: { goalId?: string | null; loopName?: string; leaseMeta?: Record<string, unknown> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-md1-')); roots.push(root);
  vi.stubEnv('LOOP_WORKTREE_ROOT', path.join(root, 'worktrees'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(path.join(repo, 'packages', 'shared', 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }));
  fs.writeFileSync(path.join(repo, 'package-lock.json'), LOCK);
  fs.writeFileSync(path.join(repo, 'packages', 'shared', 'package.json'), JSON.stringify({ name: '@djimitflo/shared', main: './dist/index.js' }));
  fs.writeFileSync(path.join(repo, 'packages', 'shared', 'src', 'index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture'], { cwd: repo, stdio: 'ignore' });
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); dbs.push(db);
  const loops = new LoopService(db, path.join(root, 'evidence'));
  const goalId = opts.goalId === undefined ? goalIn('B') : opts.goalId;
  if (goalId) db.prepare("INSERT INTO goals (id, objective, risk_class, status) VALUES (?, 'Raise the mutation score', 'low', 'running')").run(goalId);
  db.prepare(`INSERT INTO loop_runs (id,loop_name,mode,status,repository_path,findings_json,metadata,goal_id) VALUES ('md-run',?,'closed','running',?,?,?,?)`).run(
    opts.loopName ?? 'doc-drift-and-small-fix-loop', repo,
    JSON.stringify([{ id: 'finding', type: 'todo_marker', severity: 'low', file: 'README.md', message: 'Raise the mutation score', evidence: 'x', suggested_fix: 'y' }]),
    JSON.stringify({ risk_class: 'low' }), goalId);
  const assignment = path.join(root, 'assignment.md'); fs.writeFileSync(assignment, 'Fixture assignment');
  loops.insertWorkerLease({ id: 'maker', loopRunId: 'md-run', role: 'maker', runtime, findingId: 'finding', worktreePath: repo, branchName: null,
    now: new Date().toISOString(), metadata: { assignment_file: assignment, ...(opts.leaseMeta ?? {}) } });
  vi.spyOn(loops, 'getRuntimeContract').mockReturnValue({ available: true, status: 'ok' } as ReturnType<LoopService['getRuntimeContract']>);
  return { root, repo, db, loops, goalId };
}

/** What the maker found when it started (incl. whether its arm was already recorded), plus the lease and events afterwards. */
async function runMaker(loops: LoopService, repo: string, engine: { exitCode: number; stderr?: string } = { exitCode: 0 }) {
  const seen = { node_modules: false, shared_dist: false, arm_recorded: false };
  vi.spyOn(loops.workerExecutor as unknown as { executeViaEngine: () => Promise<unknown> }, 'executeViaEngine').mockImplementation(async () => {
    seen.node_modules = fs.existsSync(path.join(repo, 'node_modules'));
    seen.shared_dist = fs.existsSync(path.join(repo, 'packages', 'shared', 'dist', 'index.js'));
    seen.arm_recorded = loops.listLoopEvents('md-run').some((e) => e.event_type === 'maker_deps_arm');
    return { exitCode: engine.exitCode, signal: null, timedOut: false, stdout: '', stderr: engine.stderr ?? '' };
  });
  const result = await loops.executeMaker('md-run', { lease_id: 'maker' });
  const events = loops.listLoopEvents('md-run');
  return { seen, result, lease: loops.getWorkerLease('maker'),
    arm: events.filter((e) => e.event_type === 'maker_deps_arm'), prep: events.filter((e) => e.event_type === 'maker_worktree_prepared') };
}

const GATES = ['maker_runtime_exit_zero', 'diff_under_threshold', 'token_budget', 'runtime_warning_gate', 'no_automatic_merge'];

describe('MAKER-DEPS-001 assignment', () => {
  it('MAKER_DEPS_001_MODE is off unless set to on', () => {
    expect(makerDeps001On({})).toBe(false);
    expect(makerDeps001On({ MAKER_DEPS_001_MODE: 'true' })).toBe(false);
    expect(makerDeps001On({ MAKER_DEPS_001_MODE: 'on' })).toBe(true);
  });

  it('arm = parity of sha256("maker-deps-001:" + goal id), A even / B odd', () => {
    for (const g of ['g1', 'goal-42', '5c5b77b0-d685-403a-90b6-a8b4c1f3bd95']) {
      const odd = parseInt(createHash('sha256').update(`maker-deps-001:${g}`).digest('hex').slice(0, 8), 16) % 2 === 1;
      expect(makerDepsArm(g)).toBe(odd ? 'B' : 'A');
    }
    expect(MAKER_DEPS_001).toEqual({ id: 'MAKER-DEPS-001', version: 'v1' });
  });

  it('is independent of the ACE-001, STE-001, X1 and F2 arms (4000 synthetic goals, 2x2 chi-square p > 0.001, shares 0.45-0.55)', () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `synthetic-goal-${i}`);
    const others: Record<string, (g: string) => string> = {
      ace_r: (g) => String(aceArm(g).r), ace_s: (g) => String(aceArm(g).s), ste: (g) => String(steArm(g)), x1: siblingArm, f2: checkerFamilyArm,
    };
    const b = ids.filter((g) => makerDepsArm(g) === 'B').length / ids.length;
    expect(b).toBeGreaterThan(0.45); expect(b).toBeLessThan(0.55);
    for (const [name, other] of Object.entries(others)) {
      const levels = [...new Set(ids.map(other))]; expect(levels, name).toHaveLength(2);
      const cell = (a: string, o: string) => ids.filter((g) => makerDepsArm(g) === a && other(g) === o).length;
      const n = ids.length; let chi = 0;
      for (const a of ['A', 'B']) for (const o of levels) {
        const exp = (ids.filter((g) => makerDepsArm(g) === a).length * ids.filter((g) => other(g) === o).length) / n;
        chi += (cell(a, o) - exp) ** 2 / exp;
      }
      expect(chi, `${name} chi2=${chi}`).toBeLessThan(10.83); // df 1, p = 0.001
    }
  });

  it('eligible: local opencode makers of goal runs only — never TG-001, the gym, remote, mock, manual or goal-less runs', () => {
    const ok = { runtime: 'opencode', role: 'maker', goal_id: 'g', loop_name: 'doc-drift-and-small-fix-loop' };
    expect(makerDepsEligible(ok)).toBe(true);
    expect(makerDepsEligible({ ...ok, loop_name: TG_LOOP })).toBe(false);
    expect(makerDepsEligible({ ...ok, loop_name: 'evolution-gym' })).toBe(false);
    for (const runtime of ['remote', 'mock', 'manual', 'atomic', 'codex', 'claude']) expect(makerDepsEligible({ ...ok, runtime }), runtime).toBe(false);
    expect(makerDepsEligible({ ...ok, goal_id: null })).toBe(false);
    expect(makerDepsEligible({ ...ok, role: 'checker' })).toBe(false);
  });
});

describe('MAKER-DEPS-001 in executeMaker', () => {
  it('arm B: the arm is recorded before the maker starts, then node_modules + shared dist exist, with dependency provenance', async () => {
    vi.stubEnv('MAKER_DEPS_001_MODE', 'on');
    const { root, repo, loops, goalId } = fixture('opencode', { goalId: goalIn('B') });
    const calls = fakeNpm(root);
    const { seen, lease, arm, prep } = await runMaker(loops, repo);
    expect(seen).toEqual({ node_modules: true, shared_dist: true, arm_recorded: true });
    expect(calls()).toEqual(['--version', 'ci --legacy-peer-deps --no-audit --no-fund', 'run build --workspace=@djimitflo/shared']);
    const record = { experiment: 'MAKER-DEPS-001', version: 'v1', arm: 'B', goal_id: goalId, maker_lease_id: 'maker' };
    expect(arm).toHaveLength(1); expect(arm[0].metadata).toEqual(record);
    expect(lease!.metadata.maker_deps_001).toEqual(record);
    expect(prep).toHaveLength(1);
    expect(prep[0].metadata).toMatchObject({ maker_lease_id: 'maker', arm: 'B', installed: true, install_exit: 0, install_failed: false, shared_built: true, shared_failed: false,
      command: 'npm ci --legacy-peer-deps --no-audit --no-fund', npm_version: '12.0.2', lockfile_sha256: createHash('sha256').update(LOCK).digest('hex') });
    expect(typeof prep[0].metadata.install_ms).toBe('number');
    expect(lease!.status).toBe('completed');
    expect(lease!.metadata.changed_files).toEqual([]); // install output never enters the change set
  });

  it('arm A: the arm is recorded, nothing is installed or built (today\'s behaviour)', async () => {
    vi.stubEnv('MAKER_DEPS_001_MODE', 'on');
    const { root, repo, loops } = fixture('opencode', { goalId: goalIn('A') });
    const calls = fakeNpm(root);
    const { seen, arm, prep, result } = await runMaker(loops, repo);
    expect(seen).toEqual({ node_modules: false, shared_dist: false, arm_recorded: true });
    expect(calls()).toEqual([]);
    expect(arm[0].metadata).toMatchObject({ arm: 'A' });
    expect(prep).toHaveLength(0);
    expect(result.gates.map((g) => g.name)).toEqual(GATES);
  });

  it('mode off (default): no arm, no install, no event — baseline unchanged', async () => {
    const { root, repo, loops } = fixture('opencode');
    const calls = fakeNpm(root);
    const { seen, arm, prep, lease } = await runMaker(loops, repo);
    expect(seen).toEqual({ node_modules: false, shared_dist: false, arm_recorded: false });
    expect(calls()).toEqual([]);
    expect(arm).toHaveLength(0); expect(prep).toHaveLength(0);
    expect(lease!.metadata.maker_deps_001).toBeUndefined();
  });

  it('a recorded arm is immutable: a lease that already carries arm A keeps it even where the hash says B', async () => {
    vi.stubEnv('MAKER_DEPS_001_MODE', 'on');
    const goalId = goalIn('B');
    const prior = { experiment: 'MAKER-DEPS-001', version: 'v1', arm: 'A', goal_id: goalId, maker_lease_id: 'maker' };
    const { root, repo, loops } = fixture('opencode', { goalId, leaseMeta: { maker_deps_001: prior } });
    const calls = fakeNpm(root);
    const { arm, lease } = await runMaker(loops, repo);
    expect(calls()).toEqual([]);
    expect(arm[0].metadata).toEqual(prior);
    expect(lease!.metadata.maker_deps_001).toEqual(prior);
  });

  it('arm B install failure: arm still recorded, warning, the maker runs as in A — gates and reason unchanged', async () => {
    vi.stubEnv('MAKER_DEPS_001_MODE', 'on');
    const { root, repo, loops } = fixture('opencode', { goalId: goalIn('B') });
    fakeNpm(root, { ciExit: 1 });
    const { seen, lease, arm, prep, result } = await runMaker(loops, repo);
    expect(seen.node_modules).toBe(false);
    expect(arm[0].metadata).toMatchObject({ arm: 'B' });
    expect(prep[0].level).toBe('warning');
    expect(prep[0].metadata).toMatchObject({ installed: false, install_failed: true, install_exit: 1 });
    expect(lease!.status).toBe('completed');
    expect(lease!.metadata.failure_reason).toBeUndefined();
    expect(result.gates.map((g) => g.name)).toEqual(GATES);
  });

  it('a maker failure in arm B stays the maker failure (the brake reason is not rewritten)', async () => {
    vi.stubEnv('MAKER_DEPS_001_MODE', 'on');
    const { root, repo, loops } = fixture('opencode', { goalId: goalIn('B') });
    fakeNpm(root);
    const { lease } = await runMaker(loops, repo, { exitCode: 1, stderr: 'Error: OpenCode token budget exceeded: 1001056 > 1000000 tokens (OPENCODE_MAX_RUN_TOKENS)' });
    expect(lease!.status).toBe('failed');
    expect(lease!.metadata.failure_reason).toBe('maker_gate_failed:maker_runtime_exit_zero');
  });

  it.each([
    ['a TG-001 run', 'opencode', { loopName: TG_LOOP }],
    ['an evolution-gym run', 'opencode', { loopName: 'evolution-gym' }],
    ['a remote maker', 'remote', {}],
    ['a goal-less run', 'opencode', { goalId: null }],
  ])('%s never gets an arm and is never prepared', async (_name, runtime, opts) => {
    vi.stubEnv('MAKER_DEPS_001_MODE', 'on');
    const { root, repo, loops } = fixture(runtime, opts as { loopName?: string; goalId?: string | null });
    const calls = fakeNpm(root);
    const { arm, prep, lease } = await runMaker(loops, repo);
    expect(calls()).toEqual([]);
    expect(arm).toHaveLength(0); expect(prep).toHaveLength(0);
    expect(lease!.metadata.maker_deps_001).toBeUndefined();
  });
});

describe('evolution-evidence maker_deps_001', () => {
  it('ITT by goal: verified / terminal per arm, preparation success, collecting until the pre-registered target', () => {
    const db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); dbs.push(db);
    const now = new Date().toISOString();
    const add = (goal: string, arm: 'A' | 'B', status: string, prep?: { install_failed: boolean }) => {
      db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, created_at, updated_at) VALUES (?, 'feature', 't', 'd', 'r', 'self-improvement', ?, ?, ?)").run(`si-${goal}`, status, now, now);
      db.prepare("INSERT INTO goals (id, improvement_id, objective, risk_class, status) VALUES (?, ?, 't', 'low', 'completed')").run(goal, `si-${goal}`);
      db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, goal_id) VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', 'completed', ?)").run(`run-${goal}`, goal);
      const rec = { experiment: 'MAKER-DEPS-001', version: 'v1', arm, goal_id: goal, maker_lease_id: `l-${goal}` };
      db.prepare("INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, 'maker_deps_arm', 'info', 'm', ?, ?)").run(`e-${goal}`, `run-${goal}`, JSON.stringify(rec), now);
      if (prep) db.prepare("INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, 'maker_worktree_prepared', 'info', 'm', ?, ?)").run(`p-${goal}`, `run-${goal}`, JSON.stringify({ arm, ...prep }), now);
    };
    add('a1', 'A', 'verified'); add('a2', 'A', 'regressed'); add('a3', 'A', 'running');
    add('b1', 'B', 'verified', { install_failed: false }); add('b2', 'B', 'verified', { install_failed: true });
    const ev = makerDeps001Evidence(db, '2000-01-01', { MAKER_DEPS_001_MODE: 'on' });
    expect(ev.experiment).toBe('MAKER-DEPS-001'); expect(ev.version).toBe('v1'); expect(ev.mode).toBe('on');
    expect(ev.target_per_arm).toBe(MAKER_DEPS_001_TARGET_PER_ARM);
    expect(ev.arms.A).toMatchObject({ goals: 3, terminal: 2, verified: 1, regressed: 1, censored: 1, verified_rate: 0.5 });
    expect(ev.arms.B).toMatchObject({ goals: 2, terminal: 2, verified: 2, regressed: 0, verified_rate: 1, preparations: 2, preparation_failed: 1 });
    expect(ev.status).toBe('collecting');
    expect(buildEvolutionEvidence(db).maker_deps_001).toBeDefined();
  });
});
