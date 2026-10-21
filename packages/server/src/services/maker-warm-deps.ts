import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import type { Database } from 'better-sqlite3';
import { makerDeps001On } from './maker-deps-001';

/**
 * MAKER_WARM_DEPS (off | on, default off; docs/research/di-001/MAKER_WARM_DEPS_DESIGN.md). MAKER-DEPS-001 arm B runs the
 * checks' own `npm ci` before a local opencode maker starts; a fresh install per worktree is the slow part. With this flag the
 * same preparation takes node_modules from a cache keyed by sha256(package-lock.json): the first maker on a lockfile builds it
 * through the existing `npm ci` path, later makers get a copy (`cp -a`, copy-on-write where the filesystem has it — never
 * hardlinks, which would let one worktree's write corrupt every later one). Any cache error falls back to the normal install.
 * The lease records `deps_source: cache | fresh | failed`. The cache keeps the newest 3 lockfile hashes.
 *
 * While MAKER_DEPS_001_MODE=on it refuses to act (logged once; evidence state 'blocked_by_experiment'): it would change arm A
 * (prepared at all) and arm B (how). It is the candidate default once MAKER-DEPS-001 reads out.
 */
export type WarmDepsState = 'off' | 'on' | 'blocked_by_experiment';
export type DepsSource = 'cache' | 'fresh' | 'failed';
export const WARM_DEPS_KEEP = 3;
const READY = 'READY.json';
const TREE = 'tree';

export const makerWarmDepsOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.MAKER_WARM_DEPS === 'on';
export function warmDepsState(env: NodeJS.ProcessEnv = process.env): WarmDepsState {
  if (!makerWarmDepsOn(env)) return 'off';
  return makerDeps001On(env) ? 'blocked_by_experiment' : 'on';
}
export const warmDepsCacheRoot = (env: NodeJS.ProcessEnv = process.env): string => env.MAKER_WARM_DEPS_CACHE_DIR || '/data/maker-deps-cache';

let blockLogged = false;
/** Logged once per process: the flag is on but MAKER-DEPS-001 is running, so nothing changes. */
export function makerWarmDepsBlocked(): void {
  if (blockLogged) return;
  blockLogged = true;
  console.warn('[maker-warm-deps] MAKER_WARM_DEPS=on is blocked_by_experiment: MAKER_DEPS_001_MODE=on, both arms run unchanged');
}

export interface WarmDepsResult {
  deps_source: DepsSource;
  lockfile_sha256: string;
  cache_hit: boolean;
  /** the stored entry was written by this install */
  cache_stored: boolean;
  /** why the cache was not used or not written (the install still ran); null when it worked */
  cache_error: string | null;
  /** paths restored or stored, relative to the worktree (node_modules and each workspace's own) */
  paths: string[];
  ms: number;
}

/** node_modules of the root and of every workspace (`dir/*` or `dir` entries of package.json workspaces) that exists. */
function nodeModulesPaths(worktree: string): string[] {
  const out = fs.existsSync(path.join(worktree, 'node_modules')) ? ['node_modules'] : [];
  let workspaces: unknown = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(worktree, 'package.json'), 'utf8')) as { workspaces?: unknown };
    workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces as { packages?: unknown } | undefined)?.packages ?? [];
  } catch { /* no workspaces */ }
  for (const ws of Array.isArray(workspaces) ? workspaces.filter((w): w is string => typeof w === 'string') : []) {
    const dirs = ws.endsWith('/*') ? (() => { try { return fs.readdirSync(path.join(worktree, ws.slice(0, -2))).map((d) => `${ws.slice(0, -2)}/${d}`); } catch { return []; } })() : [ws];
    for (const dir of dirs) if (!dir.includes('..') && fs.existsSync(path.join(worktree, dir, 'node_modules'))) out.push(`${dir}/node_modules`);
  }
  return out;
}

/** `cp -a` keeps symlinks verbatim (npm's relative workspace links point into the new worktree) and reflinks where it can. */
function copyTree(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const r = spawnSync('cp', ['-a', from, to], { encoding: 'utf8', timeout: 600_000 });
  if (r.status !== 0) throw new Error(`cp -a failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).slice(0, 200)}`);
}

/** Newest first by READY mtime; drop entries past `keep` and abandoned temp dirs older than an hour. Never throws. */
export function pruneWarmDepsCache(root: string, keep = WARM_DEPS_KEEP, now = Date.now()): void {
  try {
    const entries = fs.readdirSync(root).map((name) => ({ name, dir: path.join(root, name) }));
    for (const t of entries.filter((e) => e.name.startsWith('.tmp-'))) {
      try { if (now - fs.statSync(t.dir).mtimeMs > 3_600_000) fs.rmSync(t.dir, { recursive: true, force: true }); } catch { /* next prune */ }
    }
    const ready = entries.filter((e) => !e.name.startsWith('.') && fs.existsSync(path.join(e.dir, READY)))
      .map((e) => ({ ...e, at: fs.statSync(path.join(e.dir, READY)).mtimeMs })).sort((a, b) => b.at - a.at);
    for (const old of ready.slice(keep)) fs.rmSync(old.dir, { recursive: true, force: true });
  } catch { /* the cache is an optimisation */ }
}

/**
 * Provision node_modules for a worktree with a lockfile and none installed: copy from the cache (hit), else run `install`
 * (the existing `npm ci` path) and store its result (miss). A cache error removes any partial copy and installs normally.
 * Returns null when there is nothing to provision (no lockfile, or node_modules already there).
 */
export function provisionWarmDeps(worktree: string, install: () => { exit: number | null }, opts: { root: string; keep?: number }): WarmDepsResult | null {
  const lock = path.join(worktree, 'package-lock.json');
  if (!fs.existsSync(lock) || fs.existsSync(path.join(worktree, 'node_modules'))) return null;
  const started = Date.now();
  const hash = createHash('sha256').update(fs.readFileSync(lock)).digest('hex');
  const entry = path.join(opts.root, hash);
  const result: WarmDepsResult = { deps_source: 'failed', lockfile_sha256: hash, cache_hit: false, cache_stored: false, cache_error: null, paths: [], ms: 0 };
  const done = (r: WarmDepsResult) => ({ ...r, ms: Date.now() - started });

  let manifest: { paths?: unknown; node_abi?: unknown } | null = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(entry, READY), 'utf8')); } catch { /* miss */ }
  // a native module built for another Node ABI would load wrongly: an entry from another Node is a miss and is replaced
  if (manifest && manifest.node_abi !== process.versions.modules) { result.cache_error = 'node_abi_mismatch'; manifest = null; }
  const cached = Array.isArray(manifest?.paths) ? (manifest!.paths as unknown[]).filter((p): p is string => typeof p === 'string' && !p.includes('..')) : [];
  if (cached.length) {
    try {
      for (const rel of cached) { fs.rmSync(path.join(worktree, rel), { recursive: true, force: true }); copyTree(path.join(entry, TREE, rel), path.join(worktree, rel)); }
      const now = new Date(); fs.utimesSync(path.join(entry, READY), now, now);
      return done({ ...result, deps_source: 'cache', cache_hit: true, paths: cached });
    } catch (err) {
      result.cache_error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      for (const rel of cached) fs.rmSync(path.join(worktree, rel), { recursive: true, force: true });
    }
  }

  const installed = install();
  if (installed.exit !== 0 || !fs.existsSync(path.join(worktree, 'node_modules'))) return done(result);
  result.deps_source = 'fresh';
  result.paths = nodeModulesPaths(worktree);
  const tmp = path.join(opts.root, `.tmp-${hash.slice(0, 12)}-${randomUUID().slice(0, 8)}`);
  try {
    for (const rel of result.paths) copyTree(path.join(worktree, rel), path.join(tmp, TREE, rel));
    fs.writeFileSync(path.join(tmp, READY), JSON.stringify({ paths: result.paths, node_abi: process.versions.modules, created_at: new Date().toISOString() }));
    if (fs.existsSync(entry) && !manifest) fs.rmSync(entry, { recursive: true, force: true }); // an incomplete or other-ABI entry
    try { fs.renameSync(tmp, entry); result.cache_stored = true; } catch { /* another maker stored the same lockfile first */ }
    pruneWarmDepsCache(opts.root, opts.keep ?? WARM_DEPS_KEEP);
  } catch (err) {
    result.cache_error ??= (err instanceof Error ? err.message : String(err)).slice(0, 200);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return done(result);
}

/** evolution-evidence `maker_deps_001.warm_deps`: the flag's state and maker leases per deps_source (window). */
export function makerWarmDepsEvidence(db: Database, since: string, env: NodeJS.ProcessEnv = process.env) {
  const by_source: Record<DepsSource, number> = { cache: 0, fresh: 0, failed: 0 };
  try {
    for (const r of db.prepare(`SELECT json_extract(metadata, '$.deps_source') AS s, COUNT(*) AS n FROM worker_leases
      WHERE role = 'maker' AND json_extract(metadata, '$.deps_source') IS NOT NULL AND created_at >= ? GROUP BY 1`).all(since) as Array<{ s: string; n: number }>) {
      if (r.s in by_source) by_source[r.s as DepsSource] += r.n;
    }
  } catch { /* missing table */ }
  return { mode: env.MAKER_WARM_DEPS ?? null, state: warmDepsState(env), keep: WARM_DEPS_KEEP, by_source,
    note: 'MAKER_WARM_DEPS: arm B\'s preparation with node_modules from a sha256(package-lock.json) cache (cp -a; any error → npm ci). blocked_by_experiment while MAKER_DEPS_001_MODE=on; the candidate default once MAKER-DEPS-001 reads out.' };
}
