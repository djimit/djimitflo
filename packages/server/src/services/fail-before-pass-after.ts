import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import { targetMutants } from './gym-failure-tasks';
import { GRADED_KILL_BUDGET_MS } from './graded-fitness';
import { loopPrSettlements } from './merge-survival';

/**
 * R2 (operator 20-10, docs/research/eco/R2-FBPA_PROTOCOL.md): a shadow deterministic check `test:fail-before-pass-after`
 * for oracle-lane makers (test-gap / exports / mutation-gap / finding-fix) whose diff adds or changes a test:
 *   FAIL-BEFORE   the changed tests fail against the parent source (finding-fix: source restored to HEAD) or, when the
 *                 source is unchanged (test-only lanes), against >= 1 graded-fitness seeded mutant of the target
 *   PASS-AFTER    they pass with the change
 *   PASS_TO_PASS  the package's existing tests that import a changed file or the target still pass (a red one is re-run at
 *                 the parent: red there too = pre-existing, unknown)
 * FAIL_BEFORE_PASS_AFTER_MODE=off|shadow (default off). Never a gate: recorded with status 'skipped', verdict in
 * shadow_status, and hidden from reviewers (withoutHiddenChecks). Unknown components stay null, never pass/fail.
 */
export const FBPA_CHECK = 'test:fail-before-pass-after';
export const failBeforePassAfterMode = (env: NodeJS.ProcessEnv = process.env): 'off' | 'shadow' =>
  (env.FAIL_BEFORE_PASS_AFTER_MODE === 'shadow' ? 'shadow' : 'off');
/** Shadow-experiment checks no checker, judge or PR reader may see (constraint: experiments read the reviewers' input). */
export const withoutHiddenChecks = <T>(checks: T): T =>
  (Array.isArray(checks) ? checks.filter((c) => (c as { name?: unknown } | null)?.name !== FBPA_CHECK) as T : checks);

/** One run of the given test files (package-relative) in the package dir. Injectable for tests. */
export type TestRunner = (cwd: string, tests: string[], timeoutMs: number) => 'pass' | 'fail' | 'timeout';
// --no-install: never fetch vitest from the registry; the worktree checks already run offline with the linked dependencies
const vitestRunner: TestRunner = (cwd, tests, timeoutMs) => {
  const r = spawnSync('npx', ['--no-install', 'vitest', 'run', ...tests], { cwd, timeout: timeoutMs, encoding: 'utf8', stdio: 'ignore', env: process.env });
  if (r.error || r.signal) return 'timeout';
  return r.status === 0 ? 'pass' : 'fail';
};

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const PKG = /^packages\/([\w.-]+)\//;
const SERVICE = /^packages\/server\/src\/services\/[\w-]+\.ts$/;
const TEST_NAME = /^packages\/server\/src\/__tests__\/([\w-]+)(?:\.[\w-]+)?\.test\.ts$/;
const SUPPORT_DIR = /(^|\/)(__tests__|test)\//;
const P2P_MAX = 10;

type Tri = boolean | null;
export interface FbpaRecord { name: string; mode: 'shadow'; status: 'skipped'; shadow_status: 'pass' | 'fail' | 'skipped'; exit_status: null;
  fail_before: Tri; pass_after: Tri; pass_to_pass: Tri; before: 'parent_source' | 'seeded_mutant' | null; tests: string[]; p2p_tests: number; reasons: string[]; ms: number }

const sh = (cwd: string, args: string[]) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const atParent = (wt: string, file: string): string | null => { const r = sh(wt, ['show', `HEAD:${file}`]); return r.status === 0 ? r.stdout : null; };
const read = (wt: string, file: string): string | null => { try { return fs.readFileSync(path.join(wt, file), 'utf8'); } catch { return null; } };
/** Writes each file's content, or removes it when null. */
function apply(wt: string, files: Map<string, string | null>): void {
  for (const [f, content] of files) {
    const p = path.join(wt, f);
    if (content === null) fs.rmSync(p, { force: true });
    else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
  }
}

function laneTarget(evidence: string, grounding: { target?: unknown }, tests: string[]): string | null {
  if (typeof grounding.target === 'string' && SERVICE.test(grounding.target)) return grounding.target;
  const service = evidence.match(/"mutation-gap:([A-Za-z0-9_-]+)"/)?.[1];
  if (service) return `packages/server/src/services/${service}.ts`;
  const named = tests.find((t) => TEST_NAME.test(t));
  return named ? `packages/server/src/services/${TEST_NAME.exec(named)![1]}.ts` : null;
}

/** Existing (at parent) test files of the package that import one of `files` by a relative specifier, minus `exclude`. */
function relatedExistingTests(wt: string, pkg: string, files: string[], exclude: Set<string>): string[] {
  const listed = sh(wt, ['ls-tree', '-r', '--name-only', 'HEAD', '--', `packages/${pkg}/`]).stdout.split('\n').filter((f) => TEST_FILE.test(f) && !exclude.has(f));
  const strip = (p: string) => p.replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
  const wanted = new Set(files.map(strip));
  const out: string[] = [];
  for (const t of listed.sort()) {
    const text = read(wt, t); if (text === null) continue;
    const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]);
    if (specs.some((s) => wanted.has(strip(path.posix.normalize(path.posix.join(path.posix.dirname(t), s)))))) out.push(t);
    if (out.length >= P2P_MAX) break;
  }
  return out;
}

/**
 * Records the check on a completed oracle-lane maker lease (appended to metadata.deterministic_checks). Idempotent, never
 * throws, never changes the lease status or any gate; the worktree is restored in a finally.
 */
export function recordFailBeforePassAfter(db: Database, runId: string, leaseId: string, opts: { env?: NodeJS.ProcessEnv; run?: TestRunner; budgetMs?: number } = {}): FbpaRecord | null {
  if (failBeforePassAfterMode(opts.env ?? process.env) !== 'shadow') return null;
  const started = Date.now();
  let lease: { status: string; worktree_path: string | null; metadata: string } | undefined;
  try { lease = db.prepare("SELECT status, worktree_path, metadata FROM worker_leases WHERE id = ? AND role = 'maker'").get(leaseId) as typeof lease; } catch { return null; }
  if (!lease || lease.status !== 'completed' || !lease.worktree_path) return null;
  let meta: Record<string, unknown>;
  try { meta = JSON.parse(lease.metadata || '{}'); } catch { return null; }
  const checks = Array.isArray(meta.deterministic_checks) ? meta.deterministic_checks as Array<Record<string, unknown>> : [];
  if (checks.some((c) => c?.name === FBPA_CHECK)) return null;
  let proposal: { evidence: string | null; grounding: string | null } | undefined;
  try {
    proposal = db.prepare(`SELECT s.evidence_refs_json AS evidence, s.grounding_json AS grounding FROM loop_runs r JOIN goals g ON g.id = r.goal_id
      JOIN self_improvements s ON s.id = g.improvement_id WHERE r.id = ?`).get(runId) as typeof proposal;
  } catch { return null; }
  const evidence = proposal?.evidence ?? '';
  if (!/"(?:test-gap|mutation-gap|finding-fix):/.test(evidence)) return null; // oracle lanes only
  const changed = (Array.isArray(meta.changed_files) ? (meta.changed_files as unknown[]).map(String) : []).filter((f) => f && !f.split('/').includes('node_modules'));
  const tests = changed.filter((f) => TEST_FILE.test(f));
  if (!tests.length) return null; // the change adds or changes no test
  const wt = lease.worktree_path;
  let grounding: { target?: unknown } = {};
  try { grounding = JSON.parse(proposal?.grounding || '{}'); } catch { /* none */ }

  const reasons: string[] = [];
  let failBefore: Tri = null; let passAfter: Tri = null; let passToPass: Tri = null; let before: FbpaRecord['before'] = null; let p2p: string[] = [];
  const pkgs = new Set(tests.map((t) => PKG.exec(t)?.[1] ?? ''));
  const pkg = pkgs.size === 1 ? [...pkgs][0] : '';
  const run = opts.run ?? vitestRunner; const budget = opts.budgetMs ?? GRADED_KILL_BUDGET_MS;
  const left = () => budget - (Date.now() - started);
  const exec = (files: string[]): Tri | 'timeout' => {
    if (left() <= 0) return 'timeout';
    const r = run(path.join(wt, 'packages', pkg), files.map((f) => f.slice(`packages/${pkg}/`.length)), left());
    return r === 'timeout' ? 'timeout' : r === 'pass';
  };
  const after = new Map(changed.map((f) => [f, read(wt, f)] as [string, string | null]));
  const parent = new Map(changed.map((f) => [f, atParent(wt, f)] as [string, string | null]));
  let targetFile: string | null = null; let targetOriginal: string | null = null;

  if (!pkg) reasons.push(pkgs.size > 1 ? 'tests span more than one package' : 'test outside packages/');
  else try {
    const others = changed.filter((f) => !tests.includes(f) && f.startsWith(`packages/${pkg}/`));
    const source = others.filter((f) => !SUPPORT_DIR.test(f));
    const target = laneTarget(evidence, grounding, tests);

    // PASS-AFTER
    const a = exec(tests);
    if (a === 'timeout') reasons.push('pass-after: timeout'); else { passAfter = a; if (!a) reasons.push('pass-after violated: the changed tests fail with the change'); }

    // FAIL-BEFORE
    if (source.length) {
      before = 'parent_source';
      apply(wt, new Map(source.map((f) => [f, parent.get(f) ?? null])));
      try {
        const b = exec(tests);
        if (b === 'timeout') reasons.push('fail-before: timeout'); else { failBefore = !b; if (b) reasons.push('fail-before violated: the changed tests pass against the parent source'); }
      } finally { apply(wt, new Map(source.map((f) => [f, after.get(f) ?? null]))); }
    } else if (!target) reasons.push('fail-before: no target');
    else {
      before = 'seeded_mutant';
      const graded = meta.graded as { kind?: unknown; killed?: unknown; total?: unknown } | undefined;
      if (graded?.kind === 'mutant_kill' && typeof graded.killed === 'number' && typeof graded.total === 'number' && graded.total > 0) {
        failBefore = graded.killed > 0; // the graded-fitness result of the same seeded mutants (no second run)
        if (!failBefore) reasons.push('fail-before violated: no seeded mutant of the target makes the tests fail (graded)');
      } else {
        targetOriginal = read(wt, target);
        if (targetOriginal === null) reasons.push('fail-before: target missing');
        else {
          targetFile = path.join(wt, target);
          const mutants = targetMutants(targetOriginal, runId, target);
          if (!mutants.length) reasons.push('fail-before: no mutant');
          else {
            let killed = false; let timedOut = false;
            for (const m of mutants) {
              fs.writeFileSync(targetFile, m.content);
              const r = exec(tests);
              if (r === 'timeout') { timedOut = true; break; }
              if (!r) { killed = true; break; } // one kill is enough
            }
            fs.writeFileSync(targetFile, targetOriginal);
            if (killed) failBefore = true;
            else if (timedOut) reasons.push('fail-before: timeout');
            else { failBefore = false; reasons.push('fail-before violated: no seeded mutant of the target makes the tests fail'); }
          }
        }
      }
    }

    // PASS_TO_PASS
    p2p = relatedExistingTests(wt, pkg, [...others, ...(target ? [target] : [])], new Set(tests));
    if (!p2p.length) passToPass = true; // vacuous: no existing test imports a changed file or the target (p2p_tests: 0)
    else {
      const p = exec(p2p);
      if (p === 'timeout') reasons.push('pass-to-pass: timeout');
      else if (p) passToPass = true;
      else {
        apply(wt, parent);
        try {
          const q = exec(p2p);
          if (q === 'timeout') reasons.push('pass-to-pass: timeout at parent');
          else if (q) { passToPass = false; reasons.push(`pass-to-pass violated: existing tests green at parent fail with the change (${p2p.join(', ')})`); }
          else reasons.push('pass-to-pass: existing tests already red at parent');
        } finally { apply(wt, after); }
      }
    }
  } catch (error) {
    reasons.push(`error: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`);
  } finally {
    if (targetFile && targetOriginal !== null) { try { fs.writeFileSync(targetFile, targetOriginal); } catch { /* reviewers see the target */ } }
    try { apply(wt, after); } catch { /* best effort: the change as the maker left it */ }
  }

  const parts = [failBefore, passAfter, passToPass];
  const verdict = parts.includes(false) ? 'fail' : parts.every((p) => p === true) ? 'pass' : 'skipped';
  const record: FbpaRecord = { name: FBPA_CHECK, mode: 'shadow', status: 'skipped', shadow_status: verdict, exit_status: null,
    fail_before: failBefore, pass_after: passAfter, pass_to_pass: passToPass, before, tests, p2p_tests: p2p.length, reasons, ms: Date.now() - started };
  try {
    // re-read: append to the current checks, never overwrite anything written meanwhile
    const cur = db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(leaseId) as { metadata: string } | undefined;
    const m = JSON.parse(cur?.metadata || '{}') as { deterministic_checks?: unknown };
    const list = Array.isArray(m.deterministic_checks) ? m.deterministic_checks as Array<Record<string, unknown>> : [];
    if (list.some((c) => c?.name === FBPA_CHECK)) return null;
    db.prepare("UPDATE worker_leases SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.deterministic_checks', json(?)) WHERE id = ?")
      .run(JSON.stringify([...list, record]), leaseId);
  } catch { return null; }
  return record;
}

export const FBPA_MIN_SETTLED = 40;
export const FBPA_MIN_DIFF_PT = 10;

/** R2 evidence (read-only): verdict counts per run, and once settled 14-d survival per arm; decision only at n >= 40. */
export function failBeforePassAfterEvidence(db: Database, env: NodeJS.ProcessEnv, fisher: (a: number, b: number, c: number, d: number) => number, now = Date.now()) {
  let rows: Array<{ run: string; metadata: string }> = [];
  try {
    rows = db.prepare(`SELECT loop_run_id AS run, metadata FROM worker_leases WHERE role = 'maker' AND metadata LIKE '%"test:fail-before-pass-after"%'
      AND json_extract(metadata, '$.superseded_by_maker_lease_id') IS NULL ORDER BY updated_at, id`).all() as typeof rows;
  } catch { /* no table */ }
  const perRun = new Map<string, FbpaRecord>(); // latest non-superseded maker per run
  for (const r of rows) {
    try {
      const c = ((JSON.parse(r.metadata).deterministic_checks ?? []) as FbpaRecord[]).find((x) => x?.name === FBPA_CHECK);
      if (c) perRun.set(r.run, c);
    } catch { /* unparseable lease */ }
  }
  const counts = { pass: 0, fail: 0, skipped: 0, fail_before_violated: 0, pass_after_violated: 0, pass_to_pass_violated: 0 };
  for (const c of perRun.values()) {
    if (c.shadow_status === 'pass' || c.shadow_status === 'fail' || c.shadow_status === 'skipped') counts[c.shadow_status]++;
    if (c.fail_before === false) counts.fail_before_violated++;
    if (c.pass_after === false) counts.pass_after_violated++;
    if (c.pass_to_pass === false) counts.pass_to_pass_violated++;
  }
  let settlements: ReturnType<typeof loopPrSettlements> = [];
  try { settlements = loopPrSettlements(db, now, undefined, env); } catch { /* no table */ }
  const arms = { pass: { runs: counts.pass, with_pr: 0, settled: 0, pending: 0 }, fail: { runs: counts.fail, with_pr: 0, settled: 0, pending: 0 } };
  const settled: Array<{ run: string; arm: 'pass' | 'fail'; survived: boolean; at: string }> = [];
  for (const s of settlements) {
    const arm = perRun.get(s.run_id)?.shadow_status;
    if (arm !== 'pass' && arm !== 'fail') continue;
    arms[arm].with_pr++;
    if (s.settlement.state === 'SETTLED_SURVIVED' || s.settlement.state === 'SETTLED_REGRESSED') {
      arms[arm].settled++;
      settled.push({ run: s.run_id, arm, survived: s.settlement.state === 'SETTLED_SURVIVED', at: String(s.outcome?.settled_at ?? s.settlement.since ?? '') });
    } else if (s.settlement.state === 'MERGED_SURVIVAL_PENDING') arms[arm].pending++;
  }
  // the pre-registered analysis set: the first 40 settled runs by settlement time, then run id
  settled.sort((x, y) => x.at.localeCompare(y.at) || x.run.localeCompare(y.run));
  const set = settled.slice(0, FBPA_MIN_SETTLED);
  let primary: { n: number; pass: { survived: number; regressed: number; rate: number | null }; fail: { survived: number; regressed: number; rate: number | null }; difference_pt: number | null; fisher_p: number | null } | null = null;
  let verdict: 'INSUFFICIENT' | 'FALSIFIED' | 'SUPPORTED' = 'INSUFFICIENT';
  if (set.length >= FBPA_MIN_SETTLED) { // no rates, difference or p before n = 40 (no peeking)
    const arm = (a: 'pass' | 'fail') => { const s = set.filter((x) => x.arm === a); const ok = s.filter((x) => x.survived).length; return { survived: ok, regressed: s.length - ok, rate: s.length ? +(ok / s.length).toFixed(3) : null }; };
    const p = arm('pass'); const f = arm('fail');
    const diff = p.rate !== null && f.rate !== null ? +((p.rate - f.rate) * 100).toFixed(1) : null;
    const fp = diff !== null ? +fisher(p.survived, p.regressed, f.survived, f.regressed).toPrecision(4) : null;
    primary = { n: set.length, pass: p, fail: f, difference_pt: diff, fisher_p: fp };
    if (diff !== null && fp !== null) verdict = diff >= FBPA_MIN_DIFF_PT && fp < 0.05 ? 'SUPPORTED' : 'FALSIFIED';
  }
  return { experiment: 'R2' as const, protocol: 'docs/research/eco/R2-FBPA_PROTOCOL.md', mode: failBeforePassAfterMode(env), runs: perRun.size, counts, arms,
    settled_runs: settled.length, min_settled: FBPA_MIN_SETTLED, primary, verdict,
    note: 'R2 (FAIL_BEFORE_PASS_AFTER_MODE, shadow): per run its latest non-superseded maker; arms = shadow_status pass vs fail (skipped excluded). 14-d merge survival; decision only on the first 40 settled runs (difference >= 10 pt and two-sided Fisher p < 0.05 = SUPPORTED, else FALSIFIED); below 40 descriptive counts only.' };
}
export type FailBeforePassAfterEvidence = ReturnType<typeof failBeforePassAfterEvidence>;
