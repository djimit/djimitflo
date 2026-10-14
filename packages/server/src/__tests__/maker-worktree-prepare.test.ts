import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { makerPrepareDepsOn } from '../services/loop-worker-executor-service';

/**
 * docs/research/di-001/MAKER_FAILURES.md: 22 opencode makers (30 d) hit the OPENCODE_MAX_RUN_TOKENS brake and 20 the wall clock;
 * a third of their provider-reported step tokens went to environment bootstrap in a worktree without node_modules
 * (`npm ci` → npm 12 "install scripts blocked" → `npm install-scripts approve better-sqlite3` → node-gyp without make →
 * apt-get/sudo, and `@djimitflo/shared` unbuilt). LOOP_MAKER_PREPARE_DEPS=on installs and builds what the deterministic
 * checks install anyway, before the maker starts. Gates, caps and the prompt are untouched.
 */
const roots: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const d of dbs.splice(0)) d.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** A fake `npm` on PATH that behaves like npm 12 in prod (10-08 lease 0328565b): `ci` installs and warns that scripts were blocked. */
function fakeNpm(root: string, opts: { ciExit?: number } = {}) {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const log = path.join(root, 'npm-calls.log');
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
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

/** The prod worktree shape: a lockfile and packages/shared sources, no node_modules, no packages/shared/dist. */
function fixture(runtime: string, extra: (repo: string) => void = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-mwp-')); roots.push(root);
  vi.stubEnv('LOOP_WORKTREE_ROOT', path.join(root, 'worktrees'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(path.join(repo, 'packages', 'shared', 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }));
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}');
  fs.writeFileSync(path.join(repo, 'packages', 'shared', 'package.json'), JSON.stringify({ name: '@djimitflo/shared', main: './dist/index.js' }));
  fs.writeFileSync(path.join(repo, 'packages', 'shared', 'src', 'index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  extra(repo);
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture'], { cwd: repo, stdio: 'ignore' });
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); dbs.push(db);
  const loops = new LoopService(db, path.join(root, 'evidence'));
  db.prepare(`INSERT INTO loop_runs (id,loop_name,mode,status,repository_path,findings_json,metadata) VALUES ('mwp-run','doc-drift-and-small-fix-loop','closed','running',?,?,?)`).run(repo,
    JSON.stringify([{ id: 'finding', type: 'todo_marker', severity: 'low', file: 'README.md', message: 'Raise the mutation score', evidence: 'x', suggested_fix: 'y' }]),
    JSON.stringify({ risk_class: 'low' }));
  const assignment = path.join(root, 'assignment.md'); fs.writeFileSync(assignment, 'Fixture assignment');
  loops.insertWorkerLease({ id: 'maker', loopRunId: 'mwp-run', role: 'maker', runtime, findingId: 'finding', worktreePath: repo, branchName: null,
    now: new Date().toISOString(), metadata: { assignment_file: assignment } });
  vi.spyOn(loops, 'getRuntimeContract').mockReturnValue({ available: true, status: 'ok' } as ReturnType<LoopService['getRuntimeContract']>);
  return { root, repo, db, loops };
}

/** What the maker found when it started, plus the lease and events afterwards. */
async function runMaker(loops: LoopService, repo: string, engine: { exitCode: number; stderr?: string } = { exitCode: 0 }) {
  const seen: { node_modules: boolean; shared_dist: boolean } = { node_modules: false, shared_dist: false };
  vi.spyOn(loops.workerExecutor as unknown as { executeViaEngine: () => Promise<unknown> }, 'executeViaEngine').mockImplementation(async () => {
    seen.node_modules = fs.existsSync(path.join(repo, 'node_modules'));
    seen.shared_dist = fs.existsSync(path.join(repo, 'packages', 'shared', 'dist', 'index.js'));
    return { exitCode: engine.exitCode, signal: null, timedOut: false, stdout: '', stderr: engine.stderr ?? '' };
  });
  const result = await loops.executeMaker('mwp-run', { lease_id: 'maker' });
  const events = loops.listLoopEvents('mwp-run').filter((e) => e.event_type === 'maker_worktree_prepared');
  return { seen, result, lease: loops.getWorkerLease('maker'), events };
}

describe('LOOP_MAKER_PREPARE_DEPS', () => {
  it('is off unless set to on', () => {
    expect(makerPrepareDepsOn({})).toBe(false);
    expect(makerPrepareDepsOn({ LOOP_MAKER_PREPARE_DEPS: 'true' })).toBe(false);
    expect(makerPrepareDepsOn({ LOOP_MAKER_PREPARE_DEPS: 'on' })).toBe(true);
  });

  it('on: an opencode maker starts in a worktree with node_modules and a built @djimitflo/shared (the prod shape)', async () => {
    vi.stubEnv('LOOP_MAKER_PREPARE_DEPS', 'on');
    const { root, repo, loops } = fixture('opencode');
    const calls = fakeNpm(root);
    const { seen, lease, events } = await runMaker(loops, repo);
    expect(seen).toEqual({ node_modules: true, shared_dist: true });
    expect(calls()).toEqual(['ci --legacy-peer-deps --no-audit --no-fund', 'run build --workspace=@djimitflo/shared']);
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ maker_lease_id: 'maker', installed: true, shared_built: true, install_failed: false, shared_failed: false });
    expect(lease!.status).toBe('completed');
    // install output never leaks into the maker's change set
    expect(lease!.metadata.changed_files).toEqual([]);
  });

  it('off (default): baseline unchanged — no install, no build, no event', async () => {
    const { root, repo, loops } = fixture('opencode');
    const calls = fakeNpm(root);
    const { seen, lease, events } = await runMaker(loops, repo);
    expect(seen).toEqual({ node_modules: false, shared_dist: false });
    expect(calls()).toEqual([]);
    expect(events).toHaveLength(0);
    expect(lease!.status).toBe('completed');
  });

  it('an install failure is recorded and the maker still runs: no new failure, gates and reason unchanged', async () => {
    vi.stubEnv('LOOP_MAKER_PREPARE_DEPS', 'on');
    const { root, repo, loops } = fixture('opencode');
    fakeNpm(root, { ciExit: 1 });
    const { seen, lease, events, result } = await runMaker(loops, repo);
    expect(seen.node_modules).toBe(false);
    expect(lease!.status).toBe('completed');
    expect(lease!.metadata.failure_reason).toBeUndefined();
    expect(result.gates.map((g) => g.name)).toEqual(['maker_runtime_exit_zero', 'diff_under_threshold', 'token_budget', 'runtime_warning_gate', 'no_automatic_merge']);
    expect(events[0].level).toBe('warning');
    expect(events[0].metadata).toMatchObject({ installed: false, install_failed: true });
  });

  it('a maker failure stays the maker failure (the brake reason is not rewritten)', async () => {
    vi.stubEnv('LOOP_MAKER_PREPARE_DEPS', 'on');
    const { root, repo, loops } = fixture('opencode');
    fakeNpm(root);
    const { lease } = await runMaker(loops, repo, { exitCode: 1, stderr: 'Error: OpenCode token budget exceeded: 1001056 > 1000000 tokens (OPENCODE_MAX_RUN_TOKENS)' });
    expect(lease!.status).toBe('failed');
    expect(lease!.metadata.failure_reason).toBe('maker_gate_failed:maker_runtime_exit_zero');
  });

  it('is idempotent: present node_modules and shared dist are left alone', async () => {
    vi.stubEnv('LOOP_MAKER_PREPARE_DEPS', 'on');
    const { root, repo, loops } = fixture('opencode');
    fs.mkdirSync(path.join(repo, 'node_modules'));
    fs.mkdirSync(path.join(repo, 'packages', 'shared', 'dist')); fs.writeFileSync(path.join(repo, 'packages', 'shared', 'dist', 'index.js'), '');
    const calls = fakeNpm(root);
    const { events } = await runMaker(loops, repo);
    expect(calls()).toEqual([]);
    expect(events[0].metadata).toMatchObject({ installed: false, shared_built: false, install_failed: false, shared_failed: false });
  });

  it('a remote maker is left alone: it runs on its own checkout on the compute host', async () => {
    vi.stubEnv('LOOP_MAKER_PREPARE_DEPS', 'on');
    const { root, repo, loops } = fixture('remote');
    const calls = fakeNpm(root);
    const { events } = await runMaker(loops, repo);
    expect(calls()).toEqual([]);
    expect(events).toHaveLength(0);
  });
});
