#!/usr/bin/env node
// SEC-F1 deterministic baseline (docs/research/eco/SEC-F1_PROTOCOL.md "Deterministic baseline", unchanged by amendment 1).
// A baseline FLAG on an item is any of:
//   1. secrets: gitleaks (`gitleaks detect --no-git` over the added lines) when on PATH, else every prod SECRET_PATTERNS
//      entry except "High Entropy String", per added line. Which one ran is recorded;
//   2. finding-fix ESLint pack v1 (scripts/finding-fix-gate.mjs loadScanner/makeLinter): a pack finding id present after
//      the patch and absent before it, in any changed file. Scanner missing → recorded unavailable, the rest still counts;
//   3. R1..R5 (scripts/sec-f1-lib.mjs RULES) on an added line.
// Offline apart from the shallow git fetch of the base (shared cache with the runner). No model, no network check.
// Usage: node scripts/sec-f1-baseline.mjs --dist <packages/server/dist> --work <dir> --out <baseline.jsonl> [--items <dir>] [--only id,id]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadScanner, makeLinter } from './finding-fix-gate.mjs';
import {
  DEFAULT_ITEMS_DIR, addedLines, assertSafeOutput, git, parseArgs, prepareCheckout, readManifest, readPatch, regexHits,
} from './sec-f1-lib.mjs';

/** The prod detection patterns minus the redaction-only entropy rule, compiled without the global flag (no lastIndex state). */
export function detectionPatterns(SECRET_PATTERNS) {
  return SECRET_PATTERNS.filter((p) => p.name !== 'High Entropy String')
    .map((p) => ({ name: p.name, re: new RegExp(p.pattern.source, p.pattern.flags.replace('g', '')) }));
}
export const patternHits = (patterns, lines) => patterns.filter((p) => lines.some((l) => p.re.test(l))).map((p) => p.name);

function gitleaksAvailable() {
  try { execFileSync('gitleaks', ['version'], { stdio: 'ignore', timeout: 30_000 }); return true; } catch { return false; }
}

function gitleaksHits(lines) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-f1-gitleaks-'));
  const src = path.join(tmp, 'src');
  try {
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'added.txt'), `${lines.join('\n')}\n`);
    const report = path.join(tmp, 'report.json');
    execFileSync('gitleaks', ['detect', '--no-git', '--no-banner', '--source', src, '--report-format', 'json', '--report-path', report, '--exit-code', '0'], { stdio: 'ignore', timeout: 120_000 });
    return JSON.parse(fs.readFileSync(report, 'utf8') || '[]').map((f) => f.RuleID || f.Description || 'gitleaks');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** The files the patch changes, as the working tree shows them (tracked edits + new files). */
function changedFiles(checkout) {
  const tracked = git(['-C', checkout, 'diff', '--name-only', '--', '.']).split('\n').filter(Boolean);
  const untracked = git(['-C', checkout, 'ls-files', '--others', '--exclude-standard', '--', '.']).split('\n').filter(Boolean);
  return [...new Set([...tracked, ...untracked])].filter((f) => !f.startsWith('.djimitflo/'));
}

async function eslintNew(linter, checkout, files) {
  const errors = []; const fresh = [];
  for (const file of files) {
    let before = []; let after = [];
    try {
      const text = git(['-C', checkout, 'show', `HEAD:${file}`]);
      const r = await linter.scan(text, file); if (r.error) { errors.push(`${file} before: ${r.error}`); continue; } before = r.findings;
    } catch { /* new file: no findings before */ }
    const abs = path.join(checkout, file);
    if (fs.existsSync(abs)) {
      const r = await linter.scan(fs.readFileSync(abs, 'utf8'), file); if (r.error) { errors.push(`${file} after: ${r.error}`); continue; } after = r.findings;
    }
    const was = new Set(before.map((f) => f.id));
    fresh.push(...after.filter((f) => !was.has(f.id)).map((f) => ({ id: f.id, rule: f.rule, file: f.file, line: f.line })));
  }
  return { fresh, errors };
}

async function main(argv) {
  const o = parseArgs(argv, { dist: 'v', work: 'v', out: 'v', items: 'v', only: 'v', 'keep-checkouts': 'flag' });
  if (!o.dist || !o.work || !o.out) throw new Error('usage: sec-f1-baseline.mjs --dist <server dist> --work <dir> --out <baseline.jsonl>');
  const itemsDir = path.resolve(o.items || DEFAULT_ITEMS_DIR);
  const work = assertSafeOutput(o.work, { itemsDir });
  const out = assertSafeOutput(o.out, { itemsDir });
  const dist = path.resolve(o.dist);
  const { SECRET_PATTERNS } = createRequire(path.join(dist, 'index.js'))(path.join(dist, 'services/secret-patterns.js'));
  const patterns = detectionPatterns(SECRET_PATTERNS);
  const useGitleaks = gitleaksAvailable();
  const scanner = await loadScanner(process.env);
  const manifest = readManifest(itemsDir);
  const lines = [];
  const only = o.only ? new Set(o.only.split(',')) : null;
  for (const item of [...manifest.items].sort((a, b) => a.id.localeCompare(b.id)).filter((i) => !only || only.has(i.id))) {
    const patch = readPatch(itemsDir, item);
    const added = addedLines(patch);
    const secrets = useGitleaks ? { tool: 'gitleaks', hits: gitleaksHits(added) } : { tool: 'secret-patterns.ts', hits: patternHits(patterns, added) };
    let eslint;
    if (scanner.error) eslint = { available: false, reason: scanner.error, flag: false };
    else {
      const checkout = prepareCheckout(work, item, patch);
      const linter = makeLinter(scanner, checkout);
      const r = await eslintNew(linter, checkout, changedFiles(checkout));
      eslint = { available: true, version: linter.version, pack_sha: linter.packSha, new_findings: r.fresh, errors: r.errors, flag: r.fresh.length > 0 };
      if (!o['keep-checkouts']) fs.rmSync(checkout, { recursive: true, force: true });
    }
    const regex = regexHits(patch);
    const rec = { schema: 'sec-f1-baseline/1', id: item.id, secrets: { ...secrets, flag: secrets.hits.length > 0 }, eslint, regex: { hits: regex, flag: regex.length > 0 } };
    rec.flag = rec.secrets.flag || rec.eslint.flag || rec.regex.flag;
    lines.push(JSON.stringify(rec));
    console.log(JSON.stringify({ id: item.id, flag: rec.flag }));
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${lines.join('\n')}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
