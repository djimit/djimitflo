#!/usr/bin/env node
// test-changed-direct.mjs — `npm run test:changed:direct`: the bounded local form of `test:changed`.
//
// Why (prod 2026-11-22): `vitest --changed` follows the import graph to the end. A change to a widely imported service
// selects ~575 of 897 test files, which a 2-core host cannot run inside the 600 s check cap, so 13 of 18 failed lint-fix
// makers died on the timeout with lint, type-check and the finding check green — and only test-only changes (1 file) ever
// verified. This runs the changed test files plus the test files that import a changed source file DIRECTLY. The whole
// suite still runs in CI on the PR head, which is the merge gate (merge-train.sh merges only a green pinned head).
//
// Anything it cannot reason about (a change outside packages/<ws>/src, a package.json, a config) falls back to
// `npm run test:changed`, so the selection is never narrower than vitest's own for those.
// ponytail: distance-1 by regex over import specifiers, no module resolution (tsconfig paths, barrels re-exporting the
// file are missed — CI catches those). Raise to distance 2 if LOOP_CHECK_DIRECT_TESTS_MODE=shadow shows misses.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_RE = /\.test\.[cm]?[jt]sx?$/;
const SRC_RE = /^packages\/([^/]+)\/src\/.+\.[cm]?[jt]sx?$/;
const SPEC_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|vi\.(?:do)?[mM]ock\s*\(\s*|importActual\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const noExt = (p) => p.replace(/\.[cm]?[jt]sx?$/, '');

/** select(changed, testFiles, read) → { fallback: reason } | { byWorkspace: { <ws>: [test paths relative to the repo] } } */
export function select(changed, testFiles, read) {
  const odd = changed.find((f) => !SRC_RE.test(f));
  if (odd) return { fallback: `not a workspace source file: ${odd}` };
  const targets = new Set(changed.filter((f) => !TEST_RE.test(f)).map(noExt));
  const picked = new Set(changed.filter((f) => TEST_RE.test(f)));
  if (targets.size) for (const t of testFiles) {
    if (picked.has(t)) continue;
    for (const m of read(t).matchAll(SPEC_RE)) {
      const hit = noExt(path.posix.normalize(path.posix.join(path.posix.dirname(t), m[1])));
      if (targets.has(hit) || targets.has(`${hit}/index`)) { picked.add(t); break; }
    }
  }
  const byWorkspace = {};
  for (const t of picked) (byWorkspace[t.split('/')[1]] ??= []).push(t);
  return { byWorkspace };
}

function main() {
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).split('\n').filter(Boolean);
  const npm = (...a) => spawnSync('npm', a, { stdio: 'inherit' }).status ?? 1;
  // same change set as `vitest --changed`: uncommitted and untracked files
  const changed = [...new Set([...git('diff', '--name-only', 'HEAD'), ...git('ls-files', '--others', '--exclude-standard')])];
  const tests = git('ls-files', '--cached', '--others', '--exclude-standard', 'packages').filter((f) => TEST_RE.test(f));
  const sel = select(changed, tests, (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } });
  if (sel.fallback) { console.log(`direct-tests: fallback to test:changed (${sel.fallback})`); process.exit(npm('run', 'test:changed')); }
  const n = Object.values(sel.byWorkspace).flat().length;
  console.log(`direct-tests: ${n} test file(s) for ${changed.length} changed file(s)`);
  if (!n) return; // like --passWithNoTests; the full suite runs in CI
  for (const ws of ['shared', 'agent-catalog']) if (npm('run', 'build', '-w', `packages/${ws}`)) process.exit(1);
  for (const [ws, files] of Object.entries(sel.byWorkspace)) {
    const status = npm('run', 'test', '-w', `packages/${ws}`, '--', ...files.map((f) => f.slice(`packages/${ws}/`.length)));
    if (status) process.exit(status);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
