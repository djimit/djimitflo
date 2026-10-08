#!/usr/bin/env node
// Dead-code lane oracle (packages/server/src/services/dead-code-source-service.ts). In the maker worktree:
//   1. every changed path is one of DEAD_CODE_REMOVE / DEAD_CODE_ALLOW (comma lists), every DEAD_CODE_REMOVE file is gone;
//   2. the diff is deletion-dominant: lines added <= 10 % of lines removed (DEAD_CODE_MAX_ADD_RATIO);
//   3. the full test suite of every touched package passes (lint and type-check run as the usual daemon checks).
// Without DEAD_CODE_REMOVE it is a no-op, so hosts can list it in LOOP_DAEMON_CHECK_SCRIPTS for every lane.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const IGNORED = (p) => p === 'package-lock.json' || p.startsWith('.djimitflo/');

/** `git diff --numstat` lines → { path, added, removed } (binary files count as one changed line each way). */
export function parseNumstat(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const [a, r, ...rest] = line.split('\t');
    return { path: rest.join('\t'), added: a === '-' ? 1 : Number(a), removed: r === '-' ? 1 : Number(r) };
  });
}

export function deletionGate({ changes, remove, allow = [], maxAddRatio = 0.1, exists = (p) => fs.existsSync(p) }) {
  const scope = new Set([...remove, ...allow]);
  const relevant = changes.filter((c) => !IGNORED(c.path));
  const added = relevant.reduce((n, c) => n + c.added, 0);
  const removed = relevant.reduce((n, c) => n + c.removed, 0);
  const outOfScope = relevant.filter((c) => !scope.has(c.path)).map((c) => c.path);
  const notRemoved = remove.filter((p) => exists(p));
  const reasons = [
    outOfScope.length && `changed outside the named files: ${outOfScope.join(', ')}`,
    notRemoved.length && `named files still present: ${notRemoved.join(', ')}`,
    !removed && 'nothing removed',
    added > maxAddRatio * removed && `not deletion-dominant: ${added} line(s) added > ${Math.round(maxAddRatio * 100)} % of ${removed} removed`,
  ].filter(Boolean);
  return { pass: reasons.length === 0, added, removed, outOfScope, notRemoved, reasons };
}

export const touchedPackages = (paths) => [...new Set(paths.map((p) => p.match(/^packages\/([^/]+)\//)?.[1]).filter(Boolean))].sort();

function main() {
  const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const remove = list(process.env.DEAD_CODE_REMOVE);
  if (!remove.length) { console.log('dead-code-gate: skipped (no DEAD_CODE_REMOVE)'); return 0; }
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const changes = parseNumstat(git('diff', 'HEAD', '--numstat', '--no-renames', '--', '.'));
  for (const p of git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean)) {
    changes.push({ path: p, added: fs.readFileSync(p, 'utf8').split('\n').length, removed: 0 });
  }
  const ratio = Number(process.env.DEAD_CODE_MAX_ADD_RATIO);
  const gate = deletionGate({ changes, remove, allow: list(process.env.DEAD_CODE_ALLOW), ...(ratio >= 0 && ratio < 1 ? { maxAddRatio: ratio } : {}) });
  const packages = touchedPackages(changes.filter((c) => !IGNORED(c.path)).map((c) => c.path));
  console.log(JSON.stringify({ dead_code_gate: { ...gate, packages } }));
  if (!gate.pass) return 1;
  for (const pkg of packages) {
    if (!fs.existsSync(`packages/${pkg}/package.json`)) continue;
    const r = spawnSync('npx', ['vitest', 'run', '--passWithNoTests'], { cwd: `packages/${pkg}`, stdio: 'inherit' });
    if (r.status !== 0) { console.error(`dead-code-gate: full test suite of packages/${pkg} failed`); return 1; }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
