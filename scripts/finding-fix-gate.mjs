#!/usr/bin/env node
// Finding-fix lane oracle (packages/server/src/services/finding-fix-source.ts, design G2.1 §3). Two modes:
//   --discover <repoRoot> [--scope <dir>]  one JSON line: every pack-v1 finding in the production files under <dir>;
//   (default, in the maker worktree)       the gate for FINDING_FIX_ID / _RULE / _FILE / _PACK. Pass requires ALL of:
//     1. the target id is gone AND the target rule's count in the file dropped by >= 1 (a reworded line that keeps the
//        finding has a new id but the same count → fail);
//     2. no new pack finding (any rule) in the file;
//     3. only the target file is modified (no add/delete/rename, no other path), <= 30 changed / <= 15 removed lines;
//     4. no anti-gaming pattern on an added line (suppressions, skipped tests) and no config/lock/test/ignore path;
//     5. the pack hash equals the one pinned at proposal time.
// The repo's own test/lint/type-check run as the usual daemon checks. Missing inputs or a missing scanner FAIL; the gate
// is a no-op only when no FINDING_FIX_* variable is set at all (so hosts may list it for every lane).
// The rule pack lives here, in Djimitflo's install — the daemon runs Djimitflo's copy of this file, never the worktree's.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Pack v1: core rules only (type-agnostic). no-unused-vars only for JS repos — tsc noUnusedLocals covers TS repos. */
export const PACK_V1 = Object.freeze({
  name: 'finding-pack-v1',
  rules: ['preserve-caught-error', 'no-useless-escape', 'no-useless-assignment'],
  jsRepoRules: ['no-unused-vars'],
  options: { 'no-unused-vars': [{ ignoreRestSiblings: true, args: 'after-used' }] },
});
export const RULE_PRIORITY = ['preserve-caught-error', 'no-useless-escape', 'no-unused-vars', 'no-useless-assignment'];
export const MAX_CHANGED = 30;
export const MAX_REMOVED = 15;
export const MAX_FILE_LINES = 600;

/** Added-line patterns that are an immediate fail (design §3 "anti-gaming"). */
export const GAMING_LINE = [
  ['eslint-suppression', /\beslint-(disable|enable)(-next-line|-line)?\b/],
  ['eslint-inline-config', /\/\*\s*eslint\s+[@\w/-]+\s*:/],
  ['eslint-env-globals', /\/\*\s*(eslint-env|globals?)\s/],
  ['ts-suppression', /@ts-(ignore|expect-error|nocheck)\b/],
  ['scanner-suppression', /\b(nosec|nosemgrep|NOSONAR)\b|\blgtm\s*\[|\bcodeql\s*\[|codeql-suppress/i],
  ['security-review-suppression', /\bsecurity-review(-commons)?[-:]?\s*(ignore|disable|suppress)/i],
  ['coverage-pragma', /\b(istanbul|c8|v8)\s+ignore\b/],
  ['test-skip', /\b(it|test|describe)\.(skip|only|todo)\b|\bx(it|test|describe)\s*\(/],
  ['node-test-skip', /\{\s*(skip|todo|only)\s*:\s*(true|['"`])|\bt\.(skip|todo)\s*\(/],
];
/** Paths no finding fix may touch (second line of defence behind "only the target file"). */
export const FORBIDDEN_PATH = [
  ['eslint-config', /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?|\.eslintignore)$/],
  ['tsconfig', /(^|\/)tsconfig[^/]*\.json$/],
  ['package-or-lock', /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|\.npmrc)$/],
  ['security-review-config', /(^|\/)\.security-review\//],
  ['github', /(^|\/)\.github\//],
  ['codeql-config', /(^|\/)codeql[^/]*\.ya?ml$/],
  ['ignore-file', /(^|\/)\.[\w-]*ignore$|(^|\/)\.gitattributes$/],
  ['test-config', /(^|\/)(vitest|jest|stryker|playwright)[^/]*\.(c|m)?[jt]s(on)?$|(^|\/)\.(c8rc|nycrc|mocharc)[^/]*$/],
  ['test-file', /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)tests?\//],
];
const IGNORED = (p) => p.startsWith('.djimitflo/');
/** Not production code: tests, fixtures, corpora, docs, generated reports. */
export const NON_PRODUCTION = /(^|\/)(__tests__|tests?|fixtures?|corpus|benchmarks|docs|openwiki|reports|node_modules|dist|build|coverage)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;
const LINTABLE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

export const normalizeLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const isJsRepo = (repoRoot) => !fs.existsSync(path.join(repoRoot, 'tsconfig.json'));
export const packRules = (jsRepo) => [...PACK_V1.rules, ...(jsRepo ? PACK_V1.jsRepoRules : [])];
/** Pinned per proposal: the pack (rules + options) and the scanner versions. */
export const packSha = (rules, scannerVersion) => crypto.createHash('sha256').update(JSON.stringify({ pack: PACK_V1.name, rules, options: PACK_V1.options, scannerVersion })).digest('hex').slice(0, 16);
/** Stable finding id: sha256(scanner version | rule | path | normalized flagged line | occurrence index). Line numbers excluded. */
export const findingId = ({ scannerVersion, rule, file, snippet, occurrence }) => crypto.createHash('sha256').update(`${scannerVersion}|${rule}|${file}|${snippet}|${occurrence}`).digest('hex').slice(0, 16);

/** ESLint messages of one file → findings with stable ids. Occurrence = k-th identical (rule, normalized line) in the file. */
export function toFindings(messages, text, file, scannerVersion, rules) {
  const lines = String(text).split('\n');
  const seen = new Map();
  return [...messages].filter((m) => m.ruleId && rules.includes(m.ruleId))
    .sort((a, b) => a.line - b.line || a.column - b.column)
    .map((m) => {
      const snippet = normalizeLine(lines[m.line - 1]);
      const key = `${m.ruleId}\u0000${snippet}`;
      const occurrence = seen.get(key) ?? 0; seen.set(key, occurrence + 1);
      return { id: findingId({ scannerVersion, rule: m.ruleId, file, snippet, occurrence }), rule: m.ruleId, file, line: m.line, snippet: snippet.slice(0, 200), occurrence, message: String(m.message ?? '').slice(0, 300) };
    });
}

/** ESLint + typescript-eslint from FINDING_FIX_ESLINT_FROM (a directory) or from this script's own install; null when absent. */
export async function loadScanner(env = process.env) {
  const from = env.FINDING_FIX_ESLINT_FROM ? path.join(path.resolve(env.FINDING_FIX_ESLINT_FROM), 'noop.js') : fileURLToPath(import.meta.url);
  try {
    const req = createRequire(from);
    const eslintPath = req.resolve('eslint'); const tsPath = req.resolve('typescript-eslint');
    const { ESLint } = await import(pathToFileURL(eslintPath).href);
    const tseslint = (await import(pathToFileURL(tsPath).href)).default;
    const version = `eslint@${req('eslint/package.json').version}+typescript-eslint@${req('typescript-eslint/package.json').version}`;
    const { builtinRules } = await import(pathToFileURL(req.resolve('eslint/use-at-your-own-risk')).href);
    const docs = Object.fromEntries(RULE_PRIORITY.map((r) => { const d = builtinRules.get(r)?.meta?.docs; return [r, d ? `${d.description}${d.url ? ` (${d.url})` : ''}` : r]; }));
    return { ESLint, parser: tseslint.parser, version, docs };
  } catch (err) {
    return { error: `scanner_missing: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` };
  }
}

/** A linter over in-memory text: the pack only, inline config ignored, no repo config read. */
export function makeLinter(scanner, repoRoot) {
  const jsRepo = isJsRepo(repoRoot);
  const rules = packRules(jsRepo);
  const on = (list) => Object.fromEntries(list.map((r) => [r, PACK_V1.options[r] ? ['error', ...PACK_V1.options[r]] : 'error']));
  const eslint = new scanner.ESLint({
    cwd: repoRoot, overrideConfigFile: true, allowInlineConfig: false, cache: false,
    overrideConfig: [
      { files: ['**/*.{ts,tsx,mts,cts}'], languageOptions: { parser: scanner.parser, ecmaVersion: 'latest', sourceType: 'module' }, rules: on(PACK_V1.rules) },
      { files: ['**/*.{js,mjs,cjs}'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module' }, rules: on(rules) },
    ],
  });
  const sha = packSha(rules, scanner.version);
  return {
    rules, packSha: sha, version: scanner.version,
    /** findings of `text` as `file`; { error } on a parse failure (never "0 findings"). */
    async scan(text, file) {
      const [res] = await eslint.lintText(text, { filePath: path.join(repoRoot, file) });
      const fatal = res?.messages.find((m) => m.fatal || !m.ruleId);
      if (fatal) return { error: `parse_error: ${fatal.message}` };
      return { findings: toFindings(res?.messages ?? [], text, file, scanner.version, rules) };
    },
  };
}

/** `git diff --numstat` lines → { path, added, removed } (binary = one line each way). */
export function parseNumstat(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const [a, r, ...rest] = line.split('\t');
    return { path: rest.join('\t'), added: a === '-' ? 1 : Number(a), removed: r === '-' ? 1 : Number(r) };
  });
}
/** `git diff --name-status --no-renames` lines → { status, path }. */
export const parseNameStatus = (text) => text.split('\n').filter(Boolean).map((line) => { const [status, ...rest] = line.split('\t'); return { status: status[0], path: rest.join('\t') }; });
/** Added lines of a unified diff (without the leading '+', excluding '+++' headers). */
export const addedLines = (diff) => diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
export const gamingHits = (lines) => [...new Set(lines.flatMap((l) => GAMING_LINE.filter(([, re]) => re.test(l)).map(([n]) => n)))];
export const forbiddenPaths = (paths) => paths.flatMap((p) => FORBIDDEN_PATH.filter(([, re]) => re.test(p)).map(([n]) => `${n}:${p}`));

/** Pure verdict. `before`/`after` are finding lists of the target file (null = not measured → fail). */
export function evaluateGate({ id, rule, file, pack, actualPack, before, after, statuses, numstat, added, maxChanged = MAX_CHANGED, maxRemoved = MAX_REMOVED }) {
  const reasons = [];
  const missing = [['FINDING_FIX_ID', id], ['FINDING_FIX_RULE', rule], ['FINDING_FIX_FILE', file], ['FINDING_FIX_PACK', pack]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) reasons.push(`missing input: ${missing.join(', ')}`);
  if (pack && actualPack && pack !== actualPack) reasons.push(`pack changed: proposal pinned ${pack}, oracle runs ${actualPack}`);
  const relevant = statuses.filter((s) => !IGNORED(s.path));
  const other = relevant.filter((s) => s.path !== file).map((s) => `${s.status} ${s.path}`);
  const self = relevant.find((s) => s.path === file);
  if (other.length) reasons.push(`changed outside the target file: ${other.join(', ')}`);
  if (!self) reasons.push('target file not modified');
  else if (self.status !== 'M') reasons.push(`target file ${self.status === 'D' ? 'deleted' : self.status === 'A' ? 'added' : `status ${self.status}`}`);
  const forbidden = forbiddenPaths(relevant.map((s) => s.path));
  if (forbidden.length) reasons.push(`forbidden path: ${forbidden.join(', ')}`);
  const counted = numstat.filter((c) => !IGNORED(c.path));
  const nAdded = counted.reduce((n, c) => n + c.added, 0); const nRemoved = counted.reduce((n, c) => n + c.removed, 0);
  if (nAdded + nRemoved > maxChanged) reasons.push(`diff too large: ${nAdded + nRemoved} changed lines > ${maxChanged}`);
  if (nRemoved > maxRemoved) reasons.push(`too many removed lines: ${nRemoved} > ${maxRemoved}`);
  const hits = gamingHits(added);
  if (hits.length) reasons.push(...hits.map((h) => `gaming:${h}`));
  let countBefore = null; let countAfter = null; let newIds = [];
  if (!before || !after) reasons.push('scan missing: before/after not measured');
  else {
    const byRule = (list, r) => list.filter((f) => f.rule === r).length;
    countBefore = byRule(before, rule); countAfter = byRule(after, rule);
    const beforeIds = new Set(before.map((f) => f.id));
    newIds = after.filter((f) => !beforeIds.has(f.id)).map((f) => ({ id: f.id, rule: f.rule, line: f.line }));
    if (!beforeIds.has(id)) reasons.push('target finding not present at the base commit');
    if (after.some((f) => f.id === id)) reasons.push('target finding still present');
    if (!(countAfter <= countBefore - 1)) reasons.push(`${rule} count in ${file} did not drop: ${countBefore} → ${countAfter}`);
    if (newIds.length) reasons.push(`new pack finding(s): ${newIds.map((f) => `${f.rule}@${f.line}`).join(', ')}`);
  }
  return { pass: reasons.length === 0, reasons, id, rule, file, before: { count: countBefore }, after: { count: countAfter }, new_ids: newIds, changed: relevant.map((s) => `${s.status} ${s.path}`), added: nAdded, removed: nRemoved, gaming_hits: hits, pack_sha: actualPack ?? null };
}

async function gateMain(env) {
  const input = { id: env.FINDING_FIX_ID || '', rule: env.FINDING_FIX_RULE || '', file: env.FINDING_FIX_FILE || '', pack: env.FINDING_FIX_PACK || '' };
  if (!input.id && !input.rule && !input.file && !input.pack) { console.log('finding-fix-gate: skipped (no FINDING_FIX_ID)'); return 0; }
  const out = (gate) => { console.log(JSON.stringify({ finding_fix_gate: gate })); return gate.pass ? 0 : 1; };
  const fail = (reason, extra = {}) => out({ pass: false, reasons: [reason], ...input, ...extra });
  const root = process.cwd();
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  let statuses; let numstat; let diff;
  try {
    statuses = parseNameStatus(git('diff', 'HEAD', '--name-status', '--no-renames', '--', '.'));
    numstat = parseNumstat(git('diff', 'HEAD', '--numstat', '--no-renames', '--', '.'));
    diff = git('diff', 'HEAD', '--no-renames', '--no-color', '-U0', '--', '.');
    for (const p of git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean)) {
      statuses.push({ status: 'A', path: p });
      let text = ''; try { text = fs.readFileSync(path.join(root, p), 'utf8'); } catch { /* unreadable: counted as one line */ }
      numstat.push({ path: p, added: Math.max(1, text.split('\n').length), removed: 0 });
      diff += text.split('\n').map((l) => `+${l}`).join('\n');
    }
  } catch (err) { return fail(`git failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`); }
  const scanner = await loadScanner(env);
  if (scanner.error) return fail(scanner.error);
  const linter = makeLinter(scanner, root);
  let before = null; let after = null; const scanErrors = [];
  if (input.file) {
    try {
      const b = await linter.scan(git('show', `HEAD:${input.file}`), input.file);
      if (b.error) scanErrors.push(`before: ${b.error}`); else before = b.findings;
    } catch { scanErrors.push('before: file not in the base commit'); }
    try {
      const a = await linter.scan(fs.readFileSync(path.join(root, input.file), 'utf8'), input.file);
      if (a.error) scanErrors.push(`after: ${a.error}`); else after = a.findings;
    } catch { scanErrors.push('after: file missing in the worktree'); }
  }
  const gate = evaluateGate({ ...input, actualPack: linter.packSha, before, after, statuses, numstat, added: addedLines(diff) });
  if (scanErrors.length) { gate.pass = false; gate.reasons.push(...scanErrors); }
  gate.scanner_version = linter.version;
  return out(gate);
}

/** Every pack finding in the production files under `scope`, plus the file sizes the source orders by. */
export async function discover(repoRoot, scope, env = process.env) {
  const scanner = await loadScanner(env);
  if (scanner.error) return { error: scanner.error };
  const linter = makeLinter(scanner, repoRoot);
  const files = execFileSync('git', ['-C', repoRoot, 'ls-files', '--', scope], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter((f) => f && LINTABLE.test(f) && !NON_PRODUCTION.test(f));
  const findings = []; const fileLines = {}; const skipped = [];
  for (const file of files) {
    let text; try { text = fs.readFileSync(path.join(repoRoot, file), 'utf8'); } catch { continue; }
    const loc = text.split('\n').length;
    if (loc > MAX_FILE_LINES) continue;
    const r = await linter.scan(text, file);
    if (r.error) { skipped.push(file); continue; }
    if (r.findings.length) { fileLines[file] = loc; findings.push(...r.findings); }
  }
  return { scanner_version: linter.version, pack_sha: linter.packSha, rules: linter.rules, rule_docs: scanner.docs, scope, files_scanned: files.length, parse_skipped: skipped, file_lines: fileLines, findings };
}

async function main(argv, env) {
  if (argv[0] === '--discover') {
    const repoRoot = path.resolve(argv[1] || '.');
    const i = argv.indexOf('--scope');
    const result = await discover(repoRoot, i > 0 ? argv[i + 1] : '.', env);
    console.log(JSON.stringify(result));
    return result.error ? 1 : 0;
  }
  return gateMain(env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2), process.env).then((c) => process.exit(c), (err) => { console.log(JSON.stringify({ finding_fix_gate: { pass: false, reasons: [`crash: ${err instanceof Error ? err.message : String(err)}`] } })); process.exit(1); });
