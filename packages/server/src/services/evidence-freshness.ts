import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';

/**
 * Evidence freshness (dream-machine ADR-0010 pattern, Batch-8): a check passes against the files it READ, not only the
 * files the maker EDITED. A loop PR can merge cleanly and still break main when a lockfile, config or imported module it
 * depended on changed on main in the meantime (the checkout is shared with concurrent agent loops). At check time the
 * read set is fingerprinted at the worktree's base commit; before the draft PR opens it is re-fingerprinted at the
 * current main. LOOP_EVIDENCE_FRESHNESS_MODE=off (default, unchanged) | shadow (record) | enforce (do not open).
 */
export type FreshnessMode = 'off' | 'shadow' | 'enforce';
export const freshnessMode = (env: NodeJS.ProcessEnv = process.env): FreshnessMode =>
  env.LOOP_EVIDENCE_FRESHNESS_MODE === 'shadow' || env.LOOP_EVIDENCE_FRESHNESS_MODE === 'enforce' ? env.LOOP_EVIDENCE_FRESHNESS_MODE : 'off';

export interface ReadSet { base: string; files: Record<string, string> }

const CONFIG_RE = /^(package\.json|package-lock\.json|tsconfig[^/]*\.json|vitest[^/]*\.config\.[cm]?[jt]s)$/;
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

/** Repo-relative paths the checks depend on but the maker did not change: configs + lockfile at the root and in each
 *  touched package, plus the direct relative imports of the changed source files. Pure over a file reader. */
export function readSetPaths(changed: string[], read: (rel: string) => string | null, list: (relDir: string) => string[]): string[] {
  const out = new Set<string>();
  const dirs = new Set<string>(['']);
  for (const f of changed) { const m = /^(packages\/[^/]+)\//.exec(f); if (m) dirs.add(m[1]); }
  for (const d of dirs) for (const name of list(d)) if (CONFIG_RE.test(name)) out.add(d ? `${d}/${name}` : name);
  for (const f of changed.filter((c) => /\.[cm]?[jt]sx?$/.test(c))) {
    const src = read(f); if (!src) continue;
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2]; const base = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec)).replace(/\.js$/, '');
      const hit = [`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`].find((c) => read(c) !== null);
      if (hit) out.add(hit);
    }
  }
  for (const f of changed) out.delete(f); // only what the maker did NOT change
  return [...out].sort();
}

const sha = (s: string | null) => (s === null ? 'missing' : createHash('sha256').update(s).digest('hex'));

/** Read set at a git ref of the worktree (`git show <ref>:<path>`; 'missing' when the path is absent there). */
export function fingerprintAt(worktree: string, ref: string, paths: string[]): Record<string, string> {
  const show = (p: string) => { try { return execFileSync('git', ['-C', worktree, 'show', `${ref}:${p}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 20 * 1024 * 1024 }); } catch { return null; } };
  return Object.fromEntries(paths.map((p) => [p, sha(show(p))]));
}

/** Computed when deterministic checks run: base = the worktree HEAD (the maker's changes are not committed yet). */
export function captureReadSet(worktree: string, changed: string[]): ReadSet {
  const git = (...a: string[]) => execFileSync('git', ['-C', worktree, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const base = git('rev-parse', 'HEAD');
  const read = (rel: string) => { try { return fs.readFileSync(path.join(worktree, rel), 'utf8'); } catch { return null; } };
  const list = (rel: string) => { try { return fs.readdirSync(path.join(worktree, rel)); } catch { return []; } };
  const paths = readSetPaths(changed, read, list);
  return { base, files: fingerprintAt(worktree, base, paths) };
}

/** Paths whose content at `ref` differs from the captured read set (empty = fresh). */
export function staleAgainst(worktree: string, rs: ReadSet, ref: string): string[] {
  const now = fingerprintAt(worktree, ref, Object.keys(rs.files));
  return Object.keys(rs.files).filter((p) => now[p] !== rs.files[p]);
}
