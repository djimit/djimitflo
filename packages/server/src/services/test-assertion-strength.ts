import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Database } from 'better-sqlite3';
import { loadTsParser, type TsLike } from './shipped-code-scan';

/**
 * Deterministic assertion-strength check for the test-writing lanes (test-gap, exports, mutation-gap).
 * F1 experiment 09-10: the LLM checker accepted 3/7 maker diffs whose matchers were swapped for toBeDefined(), while it
 * rejected every diff with the assertions removed or the target import dropped. This check parses each changed test file
 * with the TypeScript compiler API (the shipped-code scan's loader; in the prod image, which has no TypeScript JS API, a child
 * node in the worker tree with that tree's typescript) and measures it; no model, no test run.
 *
 * Pre-registered thresholds (09-10, before any production data): the check FAILS when
 *   - no changed test file imports the target module (value import, export-from, import() or require(); a type-only
 *     import or vi.mock() does not count; skipped when the target is unknown), or
 *   - a changed test file has 0 expect() assertions, or
 *   - a changed test file's weak-matcher share is > WEAK_SHARE_MAX (0.5).
 * Weak matchers: toBeDefined, toBeTruthy, toBeFalsy, not.toBeUndefined, toBeInstanceOf(Object).
 * Assertions per test are recorded, not thresholded.
 *
 * WEAK_ASSERTION_CHECK_MODE=off|shadow|enforce (default off). shadow records the check (status 'skipped', verdict in
 * shadow_status) so the reviewers' check summary and the evidence show it but no gate fails; enforce records status
 * pass|fail and a fail fails the deterministic checks like any other.
 */
export type WeakAssertionMode = 'off' | 'shadow' | 'enforce';
export const weakAssertionCheckMode = (env: NodeJS.ProcessEnv = process.env): WeakAssertionMode =>
  env.WEAK_ASSERTION_CHECK_MODE === 'shadow' || env.WEAK_ASSERTION_CHECK_MODE === 'enforce' ? env.WEAK_ASSERTION_CHECK_MODE : 'off';
export const ASSERTION_STRENGTH_CHECK = 'test:assertion-strength';
export const WEAK_SHARE_MAX = 0.5;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_NAME = /^packages\/server\/src\/__tests__\/([\w-]+)(?:\.[\w-]+)?\.test\.ts$/;
const SERVICE = /^packages\/server\/src\/services\/[\w-]+\.ts$/;

export interface FileStrength { path: string; expects: number; weak: number; weak_share: number; tests: number; assertions_per_test: number; target_imported: boolean | null }
export interface StrengthResult { status: 'pass' | 'fail' | 'skipped'; reasons: string[]; target: string | null; files: FileStrength[] }

interface Node { kind: number; [k: string]: any }
type Posix = { dirname(p: string): string; join(...p: string[]): string; normalize(p: string): string };

/**
 * Per-file metrics. Self-contained (no outer references) on purpose: when the server has no TypeScript JS API (the prod
 * image installs --omit=dev) the same function runs as source in a child `node` inside the maker worktree, against the
 * worktree's own typescript — like the scripted checks, which already execute the worktree's code there.
 */
function analyzeSource(ts: TsLike, posix: Posix, file: { path: string; text: string }, target: string | null): FileStrength {
  const K = ts.SyntaxKind;
  const sf = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, file.path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const id = (n: Node | undefined, name?: string) => !!n && n.kind === K.Identifier && (name === undefined || n.text === name);
  const str = (n: Node | undefined): string | null => (n && (n.kind === K.StringLiteral || n.kind === K.NoSubstitutionTemplateLiteral) ? String(n.text) : null);
  // innermost callee of a.b().c() chains
  const root = (n: Node): Node => { let e = n; while (e.kind === K.CallExpression || e.kind === K.PropertyAccessExpression || e.kind === K.NonNullExpression || e.kind === K.ParenthesizedExpression || e.kind === K.AwaitExpression) e = e.expression; return e; };
  const isExpectCall = (n: Node) => n.kind === K.CallExpression && (id(n.expression, 'expect') || (n.expression.kind === K.PropertyAccessExpression && id(n.expression.expression, 'expect') && n.expression.name.text === 'soft'));
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const noExt = (p: string) => p.replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
  const specs: string[] = [];
  let expects = 0; let weak = 0; let tests = 0;
  const visit = (n: Node): void => {
    if (n.kind === K.ImportDeclaration) {
      const clause = n.importClause as Node | undefined;
      if (!clause?.isTypeOnly && str(n.moduleSpecifier)) specs.push(str(n.moduleSpecifier)!);
      return;
    }
    if (n.kind === K.ExportDeclaration && !n.isTypeOnly && str(n.moduleSpecifier)) specs.push(str(n.moduleSpecifier)!);
    if (n.kind === K.CallExpression) {
      const callee = n.expression as Node;
      if ((callee.kind === K.ImportKeyword || id(callee, 'require')) && str(n.arguments[0])) specs.push(str(n.arguments[0])!);
      // a matcher call: <expect(x)>[.not|.resolves|.rejects]*.<matcher>(...)
      if (callee.kind === K.PropertyAccessExpression) {
        const mods: string[] = []; let e: Node = callee.expression;
        while (e.kind === K.PropertyAccessExpression) { mods.unshift(e.name.text); e = e.expression; }
        if (isExpectCall(e)) {
          const matcher = callee.name.text as string; const not = mods.includes('not'); expects++;
          if (matcher === 'toBeTruthy' || matcher === 'toBeFalsy' || (matcher === 'toBeDefined' && !not) || (matcher === 'toBeUndefined' && not)
            || (matcher === 'toBeInstanceOf' && id(n.arguments[0], 'Object'))) weak++;
        }
      }
      // a test: it(...) / test(...) / it.each(...)(...) / it.only(...) with a function body
      const r = root(callee);
      if ((id(r, 'it') || id(r, 'test')) && n.arguments.some((a: Node) => a.kind === K.ArrowFunction || a.kind === K.FunctionExpression)) tests++;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const dir = posix.dirname(file.path);
  const targetImported = target ? specs.some((s) => s.startsWith('.') && noExt(posix.normalize(posix.join(dir, s))) === noExt(target)) : null;
  return { path: file.path, expects, weak, weak_share: expects ? round(weak / expects) : 0, tests, assertions_per_test: round(expects / Math.max(1, tests)), target_imported: targetImported };
}

/** The same analysis in a child `node` in the worktree, with the worktree's typescript; null when that is not possible. */
function analyzeInWorktree(worktree: string, files: Array<{ path: string; text: string }>, target: string | null): FileStrength[] | null {
  const script = `const ts = require(require.resolve('typescript', { paths: [process.cwd()] }));
if (typeof ts.createSourceFile !== 'function') process.exit(3);
const analyzeSource = (${analyzeSource.toString()});
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(input.files.map((f) => analyzeSource(ts, require('path').posix, f, input.target))));`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: worktree, input: JSON.stringify({ files, target }), encoding: 'utf8', timeout: 30_000,
    maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH ?? '' } });
  if (r.status !== 0) return null;
  try { const out = JSON.parse(r.stdout) as FileStrength[]; return Array.isArray(out) && out.length === files.length ? out : null; } catch { return null; }
}

/** Pure: the pre-registered verdict over the changed test files (repo-relative paths) and the lane's target module. */
export function assessAssertionStrength(files: Array<{ path: string; text: string }>, target: string | null,
  opts: { parser?: TsLike | null; worktree?: string } = {}): StrengthResult {
  if (!files.length) return { status: 'skipped', reasons: ['no changed test file'], target, files: [] };
  const parser = opts.parser === undefined ? loadTsParser() : opts.parser;
  const measured = parser ? files.map((f) => analyzeSource(parser, path.posix, f, target)) : opts.worktree ? analyzeInWorktree(opts.worktree, files, target) : null;
  if (!measured) return { status: 'skipped', reasons: ['typescript parser unavailable'], target, files: [] };
  const reasons: string[] = [];
  for (const f of measured) {
    if (f.expects === 0) reasons.push(`${f.path}: 0 expect() assertions`);
    else if (f.weak_share > WEAK_SHARE_MAX) reasons.push(`${f.path}: weak-matcher share ${f.weak_share} > ${WEAK_SHARE_MAX}`);
  }
  if (target && !measured.some((f) => f.target_imported)) reasons.push(`no changed test file imports the target ${target}`);
  return { status: reasons.length ? 'fail' : 'pass', reasons, target, files: measured };
}

/** The lane's target module: a services/*.ts grounding target, the mutation-gap service, else the test file's name (as graded-fitness does). */
function laneTarget(evidence: string, grounding: { target?: unknown; artifactPath?: unknown }, tests: string[]): string | null {
  if (typeof grounding.target === 'string' && SERVICE.test(grounding.target)) return grounding.target;
  const service = evidence.match(/"mutation-gap:([A-Za-z0-9_-]+)"/)?.[1];
  if (service) return `packages/server/src/services/${service}.ts`;
  const named = [grounding.artifactPath, ...tests].find((t): t is string => typeof t === 'string' && TEST_NAME.test(t));
  return named ? `packages/server/src/services/${TEST_NAME.exec(named)![1]}.ts` : null;
}

/**
 * The deterministic check record for a maker lease, or null when the mode is off or the run is not a test-writing lane.
 * Writes the per-file metrics + reasons to <outputDir>/test:assertion-strength.stdout.log (the reviewers read its tail).
 */
export function assertionStrengthCheck(db: Database, goalId: string | null | undefined, worktree: string, changedFiles: unknown, outputDir: string,
  env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  const mode = weakAssertionCheckMode(env);
  if (mode === 'off' || !goalId) return null;
  let row: { evidence: string | null; grounding: string | null } | undefined;
  try {
    row = db.prepare('SELECT s.evidence_refs_json AS evidence, s.grounding_json AS grounding FROM goals g JOIN self_improvements s ON s.id = g.improvement_id WHERE g.id = ?').get(goalId) as typeof row;
  } catch { return null; }
  const evidence = row?.evidence ?? '';
  // the test-writing lanes: test-gap (incl. #exports) and mutation-gap evidence refs (gym-failure-tasks laneOf + mutation)
  if (!/"(?:test|mutation)-gap:/.test(evidence)) return null;
  let grounding: { target?: unknown; artifactPath?: unknown } = {};
  try { grounding = JSON.parse(row?.grounding || '{}'); } catch { /* no grounding */ }
  const tests = (Array.isArray(changedFiles) ? changedFiles.map(String) : []).filter((f) => TEST_FILE.test(f) && !f.split('/').includes('node_modules')).slice(0, 20);
  const files = tests.flatMap((f) => { try { return [{ path: f, text: fs.readFileSync(path.join(worktree, f), 'utf8').slice(0, 500_000) }]; } catch { return []; } });
  const result = assessAssertionStrength(files, laneTarget(evidence, grounding, tests), { worktree });
  const stdoutPath = path.join(outputDir, `${ASSERTION_STRENGTH_CHECK}.stdout.log`);
  const stderrPath = path.join(outputDir, `${ASSERTION_STRENGTH_CHECK}.stderr.log`);
  fs.writeFileSync(stdoutPath, `${JSON.stringify({ mode, verdict: result.status, reasons: result.reasons, target: result.target, files: result.files, thresholds: { weak_share_max: WEAK_SHARE_MAX, min_expects: 1, target_import: true } })}\n`, 'utf8');
  fs.writeFileSync(stderrPath, result.reasons.join('\n'), 'utf8');
  const base = { name: ASSERTION_STRENGTH_CHECK, mode, reasons: result.reasons, files: result.files, stdout_path: stdoutPath, stderr_path: stderrPath };
  return mode === 'enforce' && result.status !== 'skipped'
    ? { ...base, status: result.status, exit_status: result.status === 'pass' ? 0 : 1 }
    : { ...base, status: 'skipped', shadow_status: result.status, exit_status: null };
}

/**
 * The check's real verdict from a maker lease's deterministic_checks. In shadow mode the record's `status` is 'skipped' by
 * design (no gate fails) and the verdict lives in `shadow_status` — prod 10-10: all post-#730 records read 'skipped' while
 * every shadow_status was a measured 'pass'. Readers must use this, not `status`. null = no check recorded.
 */
export function assertionStrengthVerdict(checks: unknown): 'pass' | 'fail' | 'skipped' | null {
  const c = (Array.isArray(checks) ? checks : []).find((x) => (x as { name?: unknown })?.name === ASSERTION_STRENGTH_CHECK) as { status?: unknown; shadow_status?: unknown } | undefined;
  if (!c) return null;
  const v = c.shadow_status ?? c.status;
  return v === 'pass' || v === 'fail' || v === 'skipped' ? v : null;
}
