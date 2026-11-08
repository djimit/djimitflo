#!/usr/bin/env node
// Skill test receipt (SKILL_VALIDATION_REQUIRES_TESTS=on, packages/server/src/services/skill-route.ts testReceiptGap).
// Runs a skill's own test files once in a clean checkout and prints the receipt the validate route checks:
//   {"commit","test_files":[{"path","sha256"}],"result":"pass"|"fail","runner","ran_at"}
// It changes nothing: test output goes to stderr, the receipt JSON is the only stdout line. Exit 0 = pass, 1 = a test failed
// or the checkout is dirty (a receipt for a commit must describe that commit), 2 = usage.
// The server never runs tests; an operator/CI runs this in a checkout at the commit the server was built from.
// A test file importing node:test runs as `node --test <file>`; any other runs as `npx vitest run <file>` in its package.
// Usage: node scripts/skill-test-receipt.mjs <test file>... (repo-relative or relative to the cwd)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const USAGE = 'usage: node scripts/skill-test-receipt.mjs <test file>...';
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
const unknown = args.filter((a) => a.startsWith('-'));
if (unknown.length || !args.length) { console.error(unknown.length ? `unknown flag: ${unknown.join(' ')}` : 'no test files'); console.error(USAGE); process.exit(2); }
const fail = (msg) => { console.error(`skill-test-receipt: ${msg}`); process.exit(1); };

const git = (...a) => {
  const r = spawnSync('git', a, { encoding: 'utf8' });
  if (r.status !== 0) fail(`git ${a.join(' ')}: ${(r.stderr || '').trim()}`);
  return r.stdout.trim();
};
const root = fs.realpathSync(git('rev-parse', '--show-toplevel'));
const commit = git('rev-parse', 'HEAD');
const files = [...new Set(args.map((a) => {
  const abs = fs.existsSync(a) ? fs.realpathSync(a) : fail(`${a} does not exist`);
  if (!abs.startsWith(root + path.sep) || !fs.statSync(abs).isFile()) fail(`${a} is not a file inside ${root}`);
  return path.relative(root, abs).split(path.sep).join('/');
}))];
// tracked changes would make the tests (or the skill they exercise) differ from the commit the receipt names
const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).stdout.trim();
if (dirty) fail(`uncommitted changes in ${root}; commit or reset them first:\n${dirty}`);
const untracked = files.filter((f) => spawnSync('git', ['ls-files', '--error-unmatch', f], { cwd: root }).status !== 0);
if (untracked.length) fail(`not committed: ${untracked.join(', ')}`);

const sha256 = (f) => `sha256:${createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')}`;
const isNodeTest = (f) => /from\s+['"]node:test['"]|require\(\s*['"]node:test['"]\s*\)/.test(fs.readFileSync(path.join(root, f), 'utf8'));
/** the nearest package.json above a file, up to the repo root (vitest runs with that package's config) */
const packageDir = (f) => {
  for (let d = path.dirname(path.join(root, f)); d.startsWith(root); d = path.dirname(d)) if (fs.existsSync(path.join(d, 'package.json'))) return d;
  return root;
};

const runs = [];
const nodeFiles = files.filter(isNodeTest);
if (nodeFiles.length) runs.push({ cwd: root, cmd: process.execPath, args: ['--test', ...nodeFiles], label: `node --test ${nodeFiles.join(' ')}` });
const byPkg = new Map();
for (const f of files.filter((x) => !nodeFiles.includes(x))) { const d = packageDir(f); byPkg.set(d, [...(byPkg.get(d) ?? []), path.relative(d, path.join(root, f))]); }
for (const [cwd, rel] of byPkg) runs.push({ cwd, cmd: 'npx', args: ['vitest', 'run', ...rel], label: `(${path.relative(root, cwd) || '.'}) npx vitest run ${rel.join(' ')}` });

const ranAt = new Date().toISOString();
let pass = true;
for (const r of runs) {
  console.error(`$ ${r.label}`);
  const res = spawnSync(r.cmd, r.args, { cwd: r.cwd, stdio: ['ignore', 2, 2] });
  if (res.status !== 0) pass = false;
}
const receipt = { commit, test_files: files.map((f) => ({ path: f, sha256: sha256(f) })), result: pass ? 'pass' : 'fail',
  runner: `${runs.map((r) => r.label).join(' && ')} (node ${process.version})`, ran_at: ranAt };
console.log(JSON.stringify(receipt));
process.exit(pass ? 0 : 1);
