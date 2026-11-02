#!/usr/bin/env node
// SEC-F1 item builder (amendment 1). Turns docs/research/eco/sec-f1/sources.json into
// items/<id>.patch + manifest.json. Every patch is a verbatim upstream diff restricted to
// non-test source files: no line is written by us.
//   benign     = fix commit applied on its parent         (git diff parent fix)
//   vulnerable = the same fix inverted, applied on the fix (git diff fix parent)
//   decoy      = an unrelated upstream commit on its parent
// Usage: node scripts/sec-f1-build-items.mjs <cache-dir>   (needs network for git fetch)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'docs/research/eco/sec-f1');
const MAX_CHANGED_LINES = 40;
const CODE = /\.(m?js|cjs|ts|tsx|jsx|mts|cts)$/;
const EXCLUDE = /(^|\/)(test|tests|__tests__|spec|fixtures?|docs?|dist|build)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)[^/]*\.config\.[cm]?[jt]s$|\.d\.ts$/i;
export const SECURITY_WORDING = /\bCVE-|\bGHSA-|vulnerab|inject|travers|security|exploit|attack|malicious|unsafe|untrusted/i;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const itemId = (source, variant) => sha256(`20261021|${source}|${variant}`).slice(0, 10);
export const isSourceFile = (f) => CODE.test(f) && !EXCLUDE.test(f);
export const changedLines = (patch) => patch.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));

function git(dir, args) {
  return execFileSync('git', ['--git-dir', dir, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
}

const gitQuiet = (dir, args) => execFileSync('git', ['--git-dir', dir, ...args], { stdio: 'ignore' });

function ensureCommit(cache, repo, sha) {
  const dir = path.join(cache, repo.replace('/', '_'));
  if (!fs.existsSync(path.join(dir, 'HEAD'))) execFileSync('git', ['init', '-q', '--bare', dir]);
  try { gitQuiet(dir, ['cat-file', '-e', `${sha}^{commit}`]); gitQuiet(dir, ['cat-file', '-e', `${sha}~1^{commit}`]); }
  catch { git(dir, ['fetch', '-q', '--depth', '2', `https://github.com/${repo}.git`, sha]); }
  return dir;
}

function finding(sourceKey, files, n) {
  // Neutral, identical for both variants of a pair; never names a class or a label.
  return {
    id: `secf1-${sha256(sourceKey).slice(0, 8)}`,
    type: 'small_fix',
    severity: 'info',
    file: files[0],
    message: `Review the change to ${files.join(', ')}`,
    evidence: `Upstream diff, ${files.length} file(s), ${n} changed lines`,
    suggested_fix: 'Keep the change if it is correct and safe.',
  };
}

function build(cache) {
  const sources = JSON.parse(fs.readFileSync(path.join(DIR, 'sources.json'), 'utf8'));
  const itemsDir = path.join(DIR, 'items');
  fs.rmSync(itemsDir, { recursive: true, force: true });
  fs.mkdirSync(itemsDir, { recursive: true });
  const items = [];
  const emit = (meta, base, patch, f) => {
    const id = itemId(meta.source, meta.variant);
    fs.writeFileSync(path.join(itemsDir, `${id}.patch`), patch);
    items.push({
      id, ...meta, base_sha: base,
      changed_lines: changedLines(patch).length,
      security_wording: SECURITY_WORDING.test(changedLines(patch).join('\n')),
      patch_sha256: sha256(patch),
      finding: f, finding_sha256: sha256(JSON.stringify(f)),
    });
  };
  const sourceDiff = (dir, from, to, a, b) => {
    const files = git(dir, ['diff', '--name-only', a, b]).split('\n').filter(isSourceFile);
    if (!files.length) throw new Error(`no source files in ${a}..${b}`);
    return { files, patch: git(dir, ['diff', '--no-color', '--no-ext-diff', '-U3', from, to, '--', ...files]) };
  };
  for (const x of sources.fixes) {
    const dir = ensureCommit(cache, x.repo, x.fix_commit);
    const source = `${x.repo}@${x.fix_commit.slice(0, 12)}`;
    const fwd = sourceDiff(dir, x.parent, x.fix_commit, x.parent, x.fix_commit);
    const rev = sourceDiff(dir, x.fix_commit, x.parent, x.parent, x.fix_commit);
    const n = changedLines(fwd.patch).length;
    if (n > MAX_CHANGED_LINES) throw new Error(`${source}: ${n} changed lines > ${MAX_CHANGED_LINES}`);
    const f = finding(source, fwd.files, n);
    const common = { source, repo: x.repo, license: x.license, upstream_commit: x.fix_commit, ghsa: x.ghsa, cve: x.cve, cwe: x.cwe, files: fwd.files };
    emit({ ...common, variant: 'vulnerable', class: x.class }, x.fix_commit, rev.patch, f);
    emit({ ...common, variant: 'benign_fix', class: null }, x.parent, fwd.patch, f);
  }
  for (const x of sources.decoys) {
    const dir = ensureCommit(cache, x.repo, x.commit);
    const source = `${x.repo}@${x.commit.slice(0, 12)}`;
    const d = sourceDiff(dir, x.parent, x.commit, x.parent, x.commit);
    const n = changedLines(d.patch).length;
    if (n > MAX_CHANGED_LINES) throw new Error(`${source}: ${n} changed lines > ${MAX_CHANGED_LINES}`);
    emit({ source, repo: x.repo, license: x.license, upstream_commit: x.commit, ghsa: null, cve: null, cwe: null, files: d.files, variant: 'decoy', class: null },
      x.parent, d.patch, finding(source, d.files, n));
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(path.join(DIR, 'manifest.json'), `${JSON.stringify({ schema_version: 1, amendment: 1, items }, null, 2)}\n`);
  return items;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cache = process.argv[2];
  if (!cache) { console.error('usage: sec-f1-build-items.mjs <cache-dir>'); process.exit(2); }
  const items = build(path.resolve(cache));
  const by = items.reduce((m, i) => ((m[i.variant] = (m[i.variant] || 0) + 1), m), {});
  console.log(JSON.stringify({ items: items.length, ...by }));
}
