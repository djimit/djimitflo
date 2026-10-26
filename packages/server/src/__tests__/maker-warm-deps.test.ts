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
import { makerDepsArm } from '../services/maker-deps-001';
import { makerWarmDepsEvidence, provisionWarmDeps, pruneWarmDepsCache, warmDepsState, WARM_DEPS_KEEP } from '../services/maker-warm-deps';
import { buildEvolutionEvidence, EVOLUTION_FLAGS } from '../services/evolution-evidence';

/**
 * MAKER_WARM_DEPS (docs/research/di-001/MAKER_WARM_DEPS_DESIGN.md): MAKER-DEPS-001 arm B's preparation with node_modules from a
 * sha256(package-lock.json) cache. Hit / miss / fallback, the keep-3 cap, and the experiment block (both arms untouched).
 */
const roots: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const d of dbs.splice(0)) d.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});
const tmp = (prefix: string) => { const r = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(r); return r; };

const LOCK = '{"lockfileVersion":3,"packages":{}}';
/** A monorepo worktree with a lockfile, a workspace, no node_modules. */
function worktree(root: string, name: string, lock = LOCK) {
  const wt = path.join(root, name);
  fs.mkdirSync(path.join(wt, 'packages', 'shared'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }));
  fs.writeFileSync(path.join(wt, 'package-lock.json'), lock);
  fs.writeFileSync(path.join(wt, 'packages', 'shared', 'package.json'), JSON.stringify({ name: '@djimitflo/shared' }));
  return wt;
}
/** What `npm ci` leaves: root node_modules with a relative workspace link, a .bin symlink, and a workspace's own node_modules. */
function fakeInstall(wt: string, calls: string[]) {
  return () => {
    calls.push(wt);
    fs.mkdirSync(path.join(wt, 'node_modules', 'vitest'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'node_modules', 'vitest', 'index.js'), 'module.exports = 1;\n');
    fs.mkdirSync(path.join(wt, 'node_modules', '@djimitflo'), { recursive: true });
    fs.symlinkSync('../../packages/shared', path.join(wt, 'node_modules', '@djimitflo', 'shared'));
    fs.mkdirSync(path.join(wt, 'node_modules', '.bin'), { recursive: true });
    fs.symlinkSync('../vitest/index.js', path.join(wt, 'node_modules', '.bin', 'vitest'));
    fs.mkdirSync(path.join(wt, 'packages', 'shared', 'node_modules', 'typescript'), { recursive: true });
    return { exit: 0 };
  };
}

describe('provisionWarmDeps', () => {
  it('miss → the normal install, stored under sha256(lockfile); hit → a copy, no install; links point into the new worktree', () => {
    const root = tmp('djimitflo-wd-'); const cache = path.join(root, 'cache'); const calls: string[] = [];
    const a = worktree(root, 'a');
    const miss = provisionWarmDeps(a, fakeInstall(a, calls), { root: cache })!;
    const hash = createHash('sha256').update(LOCK).digest('hex');
    expect(miss).toMatchObject({ deps_source: 'fresh', cache_hit: false, cache_stored: true, cache_error: null, lockfile_sha256: hash,
      paths: ['node_modules', 'packages/shared/node_modules'] });
    expect(fs.existsSync(path.join(cache, hash, 'READY.json'))).toBe(true);

    const b = worktree(root, 'b');
    const hit = provisionWarmDeps(b, () => { throw new Error('install must not run on a hit'); }, { root: cache })!;
    expect(hit).toMatchObject({ deps_source: 'cache', cache_hit: true, paths: ['node_modules', 'packages/shared/node_modules'] });
    expect(calls).toEqual([a]);
    expect(fs.readFileSync(path.join(b, 'node_modules', 'vitest', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(fs.existsSync(path.join(b, 'packages', 'shared', 'node_modules', 'typescript'))).toBe(true);
    expect(fs.readlinkSync(path.join(b, 'node_modules', '@djimitflo', 'shared'))).toBe('../../packages/shared');
    expect(fs.realpathSync(path.join(b, 'node_modules', '@djimitflo', 'shared'))).toBe(fs.realpathSync(path.join(b, 'packages', 'shared')));
    // a copy, never a hardlink: a write in one worktree does not reach the cache or the next worktree
    fs.writeFileSync(path.join(b, 'node_modules', 'vitest', 'index.js'), 'tampered');
    const c = worktree(root, 'c');
    provisionWarmDeps(c, () => ({ exit: 1 }), { root: cache });
    expect(fs.readFileSync(path.join(c, 'node_modules', 'vitest', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
  });

  it('nothing to do without a lockfile or with node_modules already present', () => {
    const root = tmp('djimitflo-wd-');
    const a = worktree(root, 'a'); fs.mkdirSync(path.join(a, 'node_modules'));
    expect(provisionWarmDeps(a, () => ({ exit: 0 }), { root: path.join(root, 'cache') })).toBeNull();
    const b = worktree(root, 'b'); fs.rmSync(path.join(b, 'package-lock.json'));
    expect(provisionWarmDeps(b, () => ({ exit: 0 }), { root: path.join(root, 'cache') })).toBeNull();
  });

  it('fallback: a broken cache entry is removed from the worktree and the normal install runs (deps_source fresh)', () => {
    const root = tmp('djimitflo-wd-'); const cache = path.join(root, 'cache'); const calls: string[] = [];
    const hash = createHash('sha256').update(LOCK).digest('hex');
    fs.mkdirSync(path.join(cache, hash), { recursive: true });
    fs.writeFileSync(path.join(cache, hash, 'READY.json'), JSON.stringify({ paths: ['node_modules'], node_abi: process.versions.modules })); // tree/ missing
    const a = worktree(root, 'a');
    const r = provisionWarmDeps(a, fakeInstall(a, calls), { root: cache })!;
    expect(r.deps_source).toBe('fresh');
    expect(r.cache_hit).toBe(false);
    expect(r.cache_error).toMatch(/^cp -a failed/);
    expect(calls).toEqual([a]);
    expect(fs.existsSync(path.join(a, 'node_modules', 'vitest', 'index.js'))).toBe(true);
  });

  it('an entry written under another Node ABI is a miss and is replaced', () => {
    const root = tmp('djimitflo-wd-'); const cache = path.join(root, 'cache'); const calls: string[] = [];
    const hash = createHash('sha256').update(LOCK).digest('hex');
    fs.mkdirSync(path.join(cache, hash, 'tree', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(cache, hash, 'READY.json'), JSON.stringify({ paths: ['node_modules'], node_abi: 'other' }));
    const a = worktree(root, 'a');
    expect(provisionWarmDeps(a, fakeInstall(a, calls), { root: cache })).toMatchObject({ deps_source: 'fresh', cache_error: 'node_abi_mismatch', cache_stored: true });
    expect(JSON.parse(fs.readFileSync(path.join(cache, hash, 'READY.json'), 'utf8')).node_abi).toBe(process.versions.modules);
  });

  it('a failed install is deps_source failed and stores nothing', () => {
    const root = tmp('djimitflo-wd-'); const cache = path.join(root, 'cache');
    const a = worktree(root, 'a');
    expect(provisionWarmDeps(a, () => ({ exit: 1 }), { root: cache })).toMatchObject({ deps_source: 'failed', cache_stored: false });
    expect(fs.existsSync(cache) ? fs.readdirSync(cache).filter((n) => !n.startsWith('.')) : []).toEqual([]);
  });

  it(`keeps the newest ${WARM_DEPS_KEEP} lockfile hashes`, () => {
    const root = tmp('djimitflo-wd-'); const cache = path.join(root, 'cache'); const calls: string[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const lock = `{"lockfileVersion":3,"n":${i}}`;
      hashes.push(createHash('sha256').update(lock).digest('hex'));
      const wt = worktree(root, `w${i}`, lock);
      provisionWarmDeps(wt, fakeInstall(wt, calls), { root: cache });
      const t = new Date(Date.now() - (10 - i) * 60_000); fs.utimesSync(path.join(cache, hashes[i], 'READY.json'), t, t);
    }
    pruneWarmDepsCache(cache);
    expect(fs.readdirSync(cache).sort()).toEqual(hashes.slice(2).sort());
  });
});

describe('MAKER_WARM_DEPS state', () => {
  it('off unless on; blocked_by_experiment while MAKER_DEPS_001_MODE=on', () => {
    expect(warmDepsState({})).toBe('off');
    expect(warmDepsState({ MAKER_WARM_DEPS: 'true' })).toBe('off');
    expect(warmDepsState({ MAKER_WARM_DEPS: 'on' })).toBe('on');
    expect(warmDepsState({ MAKER_WARM_DEPS: 'on', MAKER_DEPS_001_MODE: 'on' })).toBe('blocked_by_experiment');
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'MAKER_WARM_DEPS', acting: true });
  });
});

/** A fake `npm` on PATH: `ci` installs (node_modules/vitest), `run` builds shared dist. */
function fakeNpm(root: string) {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const log = path.join(root, 'npm-calls.log');
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  --version) echo "12.0.2"; exit 0 ;;
  ci) mkdir -p node_modules/vitest; exit 0 ;;
  run) mkdir -p packages/shared/dist && echo "export {}" > packages/shared/dist/index.js; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
}

const goalIn = (arm: 'A' | 'B') => { for (let i = 0; ; i++) if (makerDepsArm(`wd-goal-${i}`) === arm) return `wd-goal-${i}`; };

function makerFixture(root: string, runId: string, goalId: string) {
  const repo = worktree(root, `repo-${runId}`);
  fs.mkdirSync(path.join(repo, 'packages', 'shared', 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

async function runMakers(arms: Array<'A' | 'B'>, env: Record<string, string>) {
  const root = tmp('djimitflo-wd-maker-');
  vi.stubEnv('LOOP_WORKTREE_ROOT', path.join(root, 'worktrees'));
  vi.stubEnv('MAKER_WARM_DEPS_CACHE_DIR', path.join(root, 'cache'));
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const calls = fakeNpm(root);
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); dbs.push(db);
  const loops = new LoopService(db, path.join(root, 'evidence'));
  vi.spyOn(loops, 'getRuntimeContract').mockReturnValue({ available: true, status: 'ok' } as ReturnType<LoopService['getRuntimeContract']>);
  const seen: boolean[] = [];
  vi.spyOn(loops.workerExecutor as unknown as { executeViaEngine: (...a: unknown[]) => Promise<unknown> }, 'executeViaEngine').mockImplementation(async (...a: unknown[]) => {
    seen.push(fs.existsSync(path.join(a[4] as string, 'node_modules')));
    return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '' };
  });
  const assignment = path.join(root, 'assignment.md'); fs.writeFileSync(assignment, 'Fixture assignment');
  const leases = [];
  for (const [i, arm] of arms.entries()) {
    const runId = `wd-run-${i}`; const goalId = goalIn(arm);
    const repo = makerFixture(root, runId, goalId);
    db.prepare("INSERT OR IGNORE INTO goals (id, objective, risk_class, status) VALUES (?, 'x', 'low', 'running')").run(goalId);
    db.prepare(`INSERT INTO loop_runs (id,loop_name,mode,status,repository_path,findings_json,metadata,goal_id) VALUES (?,'doc-drift-and-small-fix-loop','closed','running',?,?,?,?)`).run(
      runId, repo, JSON.stringify([{ id: 'f', type: 'todo_marker', severity: 'low', file: 'README.md', message: 'x', evidence: 'x', suggested_fix: 'y' }]), JSON.stringify({ risk_class: 'low' }), goalId);
    loops.insertWorkerLease({ id: `maker-${i}`, loopRunId: runId, role: 'maker', runtime: 'opencode', findingId: 'f', worktreePath: repo, branchName: null,
      now: new Date().toISOString(), metadata: { assignment_file: assignment } });
    await loops.executeMaker(runId, { lease_id: `maker-${i}` });
    leases.push({ lease: loops.getWorkerLease(`maker-${i}`), events: loops.listLoopEvents(runId) });
  }
  return { db, calls, seen, leases };
}

describe('MAKER_WARM_DEPS in executeMaker', () => {
  it('on (experiment off): the first maker installs fresh and fills the cache, the second starts from the cache', async () => {
    const { calls, seen, leases, db } = await runMakers(['A', 'A'], { MAKER_WARM_DEPS: 'on' });
    expect(seen).toEqual([true, true]);
    expect(leases.map((l) => l.lease.metadata.deps_source)).toEqual(['fresh', 'cache']);
    expect(calls().filter((c) => c.startsWith('ci'))).toHaveLength(1);
    expect(leases.map((l) => l.events.filter((e) => e.event_type === 'maker_warm_deps').length)).toEqual([1, 1]);
    expect(leases.every((l) => l.lease.metadata.maker_deps_001 === undefined)).toBe(true);
    expect(makerWarmDepsEvidence(db, '2000-01-01', { MAKER_WARM_DEPS: 'on' })).toMatchObject({ state: 'on', by_source: { cache: 1, fresh: 1, failed: 0 } });
  });

  it('blocked while MAKER-DEPS-001 runs: arm A installs nothing, arm B is the pre-registered npm ci, neither records deps_source', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { calls, seen, leases, db } = await runMakers(['A', 'B', 'B'], { MAKER_WARM_DEPS: 'on', MAKER_DEPS_001_MODE: 'on' });
    expect(seen).toEqual([false, true, true]);
    expect(calls().filter((c) => c.startsWith('ci'))).toHaveLength(2); // every arm-B maker runs its own npm ci: no cache
    for (const { lease, events } of leases) {
      expect(lease.metadata.deps_source).toBeUndefined();
      expect(lease.metadata.warm_deps).toBeUndefined();
      expect(events.filter((e) => e.event_type === 'maker_warm_deps')).toHaveLength(0);
    }
    const prep = leases[1].events.find((e) => e.event_type === 'maker_worktree_prepared')!;
    expect(prep.metadata).not.toHaveProperty('warm_deps');
    expect(prep.metadata.warm_deps).toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/blocked_by_experiment/);
    expect(buildEvolutionEvidence(db).maker_deps_001.warm_deps).toMatchObject({ state: 'blocked_by_experiment', by_source: { cache: 0, fresh: 0, failed: 0 } });
  });

  it('off (default): no preparation, no deps_source', async () => {
    const { calls, seen, leases } = await runMakers(['A'], {});
    expect(seen).toEqual([false]);
    expect(calls()).toEqual([]);
    expect(leases[0].lease.metadata.deps_source).toBeUndefined();
  });
});
