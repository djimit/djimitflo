#!/usr/bin/env node
// F1-R item builder: a reproducible rebuild of the F1 checker test (EVAL_PROTOCOL.md §2 slice G, step G0). The 09-10 / 14-10
// case files and mutate.py were never committed and are gone (ocr/CAPABILITY_INVENTORY.md A6), so the old verdicts are context
// only; this script is the committed, deterministic replacement. Items:
//   good      = the merged loop PR's squash commit applied on its parent (git diff <parent> <commit>), verbatim;
//   defective = the same diff weakened by the kind recorded on 14-10, applied to the PR's ADDED lines only:
//               A expects removed (every statement starting at an `expect(` line, up to its balanced end),
//               B matchers changed to `.toBeDefined()` (every single-line matcher call),
//               C the import of the module under test dropped (the service named in the PR title).
// Only test files change: no vulnerable code, nothing executable beyond the PR's own tests. Uses the local git history
// (the 20 commits are on main); writes docs/research/eco/f1/items/<id>.patch + manifest.json.
// Usage: node scripts/f1-build-items.mjs [--check]   (--check: rebuild in memory and fail on any drift from the files)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const F1_DIR = path.join(ROOT, 'docs/research/eco/f1');
export const F1_REPO = 'djimit/djimitflo';

/** The 20 F1 PRs (EVAL_PROTOCOL §2 G), their squash commits on main and the defect kind recorded on 14-10. */
export const F1_SOURCES = Object.freeze([
  { pr: 474, commit: 'a5be844daa10b93b72a5ac7895d55416a2e49fe2', kind: 'B' },
  { pr: 475, commit: '727a5bfedaba8a0cdae57069bfcf3b2ee846e629', kind: 'A' },
  { pr: 537, commit: '2ffae63a8177c726c6dbedf4e6113d3751218c3f', kind: 'C' },
  { pr: 552, commit: '012f8d40f5ab263e0d3e73e3313868ab7a47c26e', kind: 'B' },
  { pr: 571, commit: '1e84fed99e3580ab8efafeed9a442c1d1271aa19', kind: 'A' },
  { pr: 574, commit: '4de6c80b43fdd5f187eaa9165de24746b887ffa2', kind: 'C' },
  { pr: 582, commit: '257f32a12fc3405efe11f425b3f7ebb95676e326', kind: 'B' },
  { pr: 587, commit: 'da94d80e13e67cf30949e735bcf9327028544120', kind: 'A' },
  { pr: 588, commit: '961f965142f93b4a3a4d9d6288995671a4772e18', kind: 'C' },
  { pr: 590, commit: '033c023492e50d17086f833d136fb6e358866446', kind: 'B' },
  { pr: 591, commit: 'fbe3978d965c3b9ba130457661831af4dd470da4', kind: 'A' },
  { pr: 592, commit: 'ef21255e590e07e9b5535a589a04acdecd4e1e72', kind: 'C' },
  { pr: 593, commit: 'f82d204896224a97bf5db27e4a2c8e94aaee822d', kind: 'B' },
  { pr: 594, commit: '8ff784f3a74ee71bf11357baa6faee06e9ecd618', kind: 'A' },
  { pr: 605, commit: 'c5d13f043da5edada4b3739234a5478dd9bc7a90', kind: 'C' },
  { pr: 606, commit: 'd3f09ddc4c378e10b1d9b38e7bdcadaa3c452ed5', kind: 'B' },
  { pr: 610, commit: '6cd18043ff667bdd4a450b677e9ddfab11ae7b4d', kind: 'A' },
  { pr: 611, commit: '2d803a2b0e89109a216b8939405c0a0106659617', kind: 'C' },
  { pr: 612, commit: 'db14757895e0dbddb317bc2de1290b721e5e885c', kind: 'B' },
  { pr: 616, commit: 'c7bec59e3ecb62a2aa61844b5fdb6e24416feb0c', kind: 'A' },
]);

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const itemId = (pr, side) => sha256(`f1r|${pr}|${side}`).slice(0, 10);

/** Bracket balance of one line, string and template literals on the line ignored. */
export function balance(line) {
  const code = line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '');
  let b = 0;
  for (const ch of code) { if ('([{'.includes(ch)) b += 1; else if (')]}'.includes(ch)) b -= 1; }
  return b;
}

/** A: every statement that starts on an added line containing `expect(` is removed, through its balanced end. */
export function removeExpects(lines, added) {
  const out = []; const removed = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!added.has(i + 1) || !/\bexpect\s*\(/.test(lines[i])) { out.push(lines[i]); continue; }
    let depth = balance(lines[i]); removed.push(i + 1);
    // the statement ends where the brackets balance and the next line does not continue the chain (`.toThrow(...)`)
    while (i + 1 < lines.length && (depth > 0 || /^\s*\./.test(lines[i + 1]))) { i += 1; depth += balance(lines[i]); removed.push(i + 1); }
  }
  return { lines: out, changed: removed };
}

const MATCHER = /\.(?:not\.)?(?:resolves\.|rejects\.)?(?:not\.)?to[A-Z]\w*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g;
/** B: every single-line matcher call on an added line becomes `.toBeDefined()`. */
export function weakenMatchers(lines, added) {
  const changed = [];
  const out = lines.map((l, i) => {
    if (!added.has(i + 1)) return l;
    const next = l.replace(MATCHER, (m) => (m === '.toBeDefined()' ? m : '.toBeDefined()'));
    if (next !== l) changed.push(i + 1);
    return next;
  });
  return { lines: out, changed };
}

/** The module under test: `services/<name>.ts` in the PR title → `services/<name>`. */
export function targetModule(subject) {
  const m = /\b((?:services|utils|routes|execution|database)\/[\w./-]+?)\.ts\b/.exec(subject);
  return m ? m[1] : null;
}

/** C: the static import (single- or multi-line) of the module under test on added lines is removed. */
export function dropTargetImport(lines, added, target) {
  const re = new RegExp(`from\\s+['"][./]*(?:[\\w-]+/)*${target.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?:\\.js)?['"]`);
  const changed = [];
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (added.has(i + 1) && /^\s*import\b/.test(lines[i])) {
      let j = i; while (j < lines.length - 1 && !/\bfrom\s+['"]/.test(lines[j]) && !/;\s*$/.test(lines[j])) j += 1;
      if (re.test(lines[j])) { for (let k = i; k <= j; k += 1) changed.push(k + 1); i = j; continue; }
    }
    out.push(lines[i]);
  }
  return { lines: out, changed };
}

export function mutate(kind, text, added, subject) {
  const lines = text.split('\n');
  if (kind === 'A') return removeExpects(lines, added);
  if (kind === 'B') return weakenMatchers(lines, added);
  if (kind === 'C') { const t = targetModule(subject); if (!t) throw new Error(`F1_NO_TARGET ${subject}`); return dropTargetImport(lines, added, t); }
  throw new Error(`F1_BAD_KIND ${kind}`);
}

/** Head-side line numbers a unified diff (-U0) adds. */
export function addedLineNumbers(u0) {
  const added = new Set();
  for (const m of String(u0).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]); const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let k = 0; k < count; k += 1) added.add(start + k);
  }
  return added;
}

const git = (args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });

/** A unified diff of one file, base (null = new file) → head, with a canonical a/ b/ header and no index line. */
export function makePatch(file, base, head) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-build-'));
  try {
    const a = path.join(tmp, 'a', file); const b = path.join(tmp, 'b', file);
    fs.mkdirSync(path.dirname(b), { recursive: true }); fs.writeFileSync(b, head);
    if (base !== null) { fs.mkdirSync(path.dirname(a), { recursive: true }); fs.writeFileSync(a, base); }
    let out = '';
    try { execFileSync('git', ['-C', tmp, 'diff', '--no-index', '--no-color', '--', base === null ? '/dev/null' : `a/${file}`, `b/${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { if (e.status !== 1) throw e; out = String(e.stdout); }
    const hunks = out.slice(out.indexOf('\n@@') + 1);
    const header = [`diff --git a/${file} b/${file}`, ...(base === null ? ['new file mode 100644', '--- /dev/null'] : [`--- a/${file}`]), `+++ b/${file}`];
    return `${header.join('\n')}\n${hunks}`;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export function buildItems() {
  const items = []; const patches = new Map();
  for (const s of F1_SOURCES) {
    const base = git(['rev-parse', `${s.commit}^`]).trim();
    const files = git(['diff', '--name-only', base, s.commit]).trim().split('\n').filter(Boolean);
    if (files.length !== 1) throw new Error(`F1_NOT_SINGLE_FILE #${s.pr}`);
    const [file] = files;
    const subject = git(['log', '-1', '--format=%s', s.commit]).trim();
    let baseText = null; // null = the PR added the file
    try { baseText = git(['show', `${base}:${file}`]); } catch { /* new file */ }
    const headText = git(['show', `${s.commit}:${file}`]);
    const added = addedLineNumbers(git(['diff', '-U0', base, s.commit, '--', file]));
    const weakened = mutate(s.kind, headText, added, subject);
    const defective = weakened.lines.join('\n');
    if (defective === headText || !weakened.changed.length) throw new Error(`F1_MUTATION_NOOP #${s.pr} kind ${s.kind}`);
    const task = subject.replace(/^loop:\s*/, '').replace(/\s*\(#\d+\)\s*$/, '');
    const finding = { id: `f1r-${sha256(`finding|${s.pr}`).slice(0, 8)}`, type: 'test_gap', severity: 'info', file, message: task,
      evidence: `Loop PR diff, 1 file (${file})`, suggested_fix: 'Keep the change if the test is correct and actually tests the target.' };
    for (const [side, text] of [['good', headText], ['defective', defective]]) {
      const id = itemId(s.pr, side);
      const patch = makePatch(file, baseText, text);
      patches.set(id, patch);
      items.push({ id, pr: s.pr, side, kind: side === 'defective' ? s.kind : null, commit: s.commit, repo: F1_REPO, base_sha: base, files: [file],
        patch_sha256: sha256(patch), defect_lines: side === 'defective' ? weakened.changed : [], finding, finding_sha256: sha256(JSON.stringify(finding)) });
    }
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  const manifest = { schema_version: 1, benchmark: 'f1', protocol: 'F1-R (EVAL_PROTOCOL.md §2 G0 rebuild, 2026-11-07)', note:
    'Rebuilt deterministically by scripts/f1-build-items.mjs; not byte-identical to the 09-10 / 14-10 case files (lost), so earlier F1 AUCs are context only.',
    items };
  return { manifest, patches };
}

function main(argv) {
  const check = argv.includes('--check');
  for (const a of argv) if (a !== '--check') throw new Error(`unknown option ${a}`);
  const { manifest, patches } = buildItems();
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (check) {
    const drift = [];
    if (fs.readFileSync(path.join(F1_DIR, 'manifest.json'), 'utf8') !== manifestText) drift.push('manifest.json');
    for (const [id, p] of patches) { const f = path.join(F1_DIR, 'items', `${id}.patch`); if (!fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== p) drift.push(`items/${id}.patch`); }
    if (drift.length) { console.error(`F1 items drifted: ${drift.join(', ')}`); process.exit(1); }
    console.log(`F1 items match: ${manifest.items.length} items, manifest sha256 ${sha256(manifestText)}`);
    return;
  }
  fs.rmSync(path.join(F1_DIR, 'items'), { recursive: true, force: true });
  fs.mkdirSync(path.join(F1_DIR, 'items'), { recursive: true });
  for (const [id, p] of patches) fs.writeFileSync(path.join(F1_DIR, 'items', `${id}.patch`), p);
  fs.writeFileSync(path.join(F1_DIR, 'manifest.json'), manifestText);
  console.log(`F1 items: ${manifest.items.length} written, manifest sha256 ${sha256(manifestText)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (err) { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); }
}
