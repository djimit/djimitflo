import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { SURVIVAL_DAYS, loopPrSettlements, survivalCounts, type LoopPrSettlement } from './merge-survival';
import { parsePrUrl } from './repo-registry';
import { classifyReport, runChild } from './commons-falsifier';
import { GRADED_KILL_BUDGET_MS, GRADED_TEST, gradedTarget, killShare, roundGraded, vitestRunner, type KillRunner } from './graded-fitness';
import { WRITE_TEST_MUTANTS, laneOf, targetMutants } from './gym-failure-tasks';
import { WorktreeManager } from './worktree-manager';
import { guardTick, markRun, noteScheduler } from './scheduler-registry';
import type { LoopService } from './loop-service';

/**
 * L3-v2 §5 bottlenecks 1–2 (operator 22-10): merge survival only asks whether ≥ 50 % of a loop PR's added lines are still on
 * main — it never re-runs a test, so it cannot fail (22/22 survived) — and the graded mutant-kill score is computed per run
 * but read by nothing. This is an execution-based settlement check, shadow only:
 *   For every merged loop PR at or after its 14-day settlement point (merge-survival's SURVIVAL_DAYS and loopPrSettlements →
 *   settlementState; primary repo only), once per day, in ONE throwaway worktree at origin/main of LOOP_DAEMON_REPOSITORY_PATH
 *   (WorktreeManager + LoopService.prepareMakerWorktree, as the falsifier does; no fetch — the deploy clone's ref):
 *    - test files = the maker's changed test files (fallback: the proposal's artifactPath). None → no_test_files. Every test file
 *      gone from main → removed (distinct from failing; no execution). Otherwise only the files still on main run with the repo's
 *      own runner (`npx --no-install vitest run <files>` per package, vitest JSON report → falsifier classifyReport): pass | fail
 *      | unknown (+reason). Timeouts, a suite that did not load and infra errors are unknown, never negative (E2).
 *    - pass + a packages/server unit test → re-score test quality with the graded machinery (graded-fitness killShare) against
 *      FRESH seeded mutants of the target (targetMutants with a settlement seed, minus the maker-time mutants: those are
 *      re-derived from the run id on today's target, an approximation when the target changed since) → kill share now vs the
 *      maker-time `metadata.graded` score when it is a mutant_kill score.
 *   One `settlement_execution` judgments row (mode shadow) per PR, decision pass | fail | removed | unknown | no_test_files;
 *   unknown is retried on later ticks up to MAX_ATTEMPTS rows. ≤ MAX_PER_TICK executed PRs per tick (removed / no_test_files
 *   cost no execution and are not counted).
 * Nothing reads it for a decision: Gate B, merge-survival scoring, the bandit, auto-merge and R2 are unchanged.
 * Evidence `settlement_execution` (evolution-evidence): counts, kill-share drift, insufficient below MIN_N; plus a read-only
 * graded-score vs verified / survived comparison so the operator can judge promoting graded to a primary label later.
 *   SETTLEMENT_EXECUTION_MODE=off (default) | shadow.
 */
export type SettlementExecutionMode = 'off' | 'shadow';
export const settlementExecutionMode = (env: NodeJS.ProcessEnv = process.env): SettlementExecutionMode => (env.SETTLEMENT_EXECUTION_MODE === 'shadow' ? 'shadow' : 'off');
export const SETTLEMENT_JUDGMENT = 'settlement_execution';
// ponytail: prepareMakerWorktree (npm ci when node_modules is absent) and the kill runs (vitestRunner, ≤ GRADED_KILL_BUDGET_MS per
// PR) are spawnSync and block the event loop; the ceiling is MAX_PER_TICK PRs once a day. Upgrade trigger: more than ~20 settled
// PRs a week waiting, or a cockpit stall alarm during the tick → move the kill runner to the async runChild.
export const MAX_PER_TICK = 4;
export const MAX_ATTEMPTS = 3;
export const MIN_N = 10;
const DAY = 86_400_000;
const TEST_TIMEOUT_MS = 300_000;
/** packages/<pkg>/….(test|spec).(ts|js…) — any test file of a workspace package. */
export const SETTLEMENT_TEST_FILE = /^packages\/([a-z0-9-]+)\/(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+\.(?:test|spec)\.[cm]?[jt]sx?$/;

export type ExecutionVerdict = 'pass' | 'fail' | 'removed' | 'unknown' | 'no_test_files';
const DECISIVE = new Set<ExecutionVerdict>(['pass', 'fail', 'removed', 'no_test_files']);
export interface TestRun { verdict: 'pass' | 'fail' | 'unknown'; reason: string }

export interface SettlementExecutionDeps {
  /** origin/main HEAD of the repository, or null */
  mainSha(repo: string): string | null;
  /** whether `file` exists at `sha` */
  exists(repo: string, sha: string, file: string): boolean;
  /** the main commit that merged PR #n (squash "(#n)" or "Merge pull request #n"), or null */
  mergeSha(repo: string, prNumber: number): string | null;
  /** a throwaway worktree at `sha` with dependencies prepared, or why there is none */
  openWorktree(repo: string, sha: string): { path: string; dispose(): void } | { error: string };
  /** runs only `files` (repo paths) in the worktree with the repo's own vitest */
  runTests(worktree: string, files: string[]): Promise<TestRun>;
  /** the graded kill runner (default: graded-fitness vitestRunner) */
  kill: KillRunner;
}

export interface Candidate {
  run_id: string; pr_url: string; pr_number: number | null; merged_at: string; settlement_state: string; settlement_reason: string;
  test_files: string[]; target: string | null; maker_kill_share: number | null; maker_kill_reason: string | null; attempts: number;
}

interface Prior { decisive: boolean; attempts: number }
function priorJudgments(db: Database): Map<string, Prior> {
  const out = new Map<string, Prior>();
  let rows: Array<{ sid: string; decision: string }> = [];
  try { rows = db.prepare('SELECT subject_id AS sid, decision FROM judgments WHERE judgment = ?').all(SETTLEMENT_JUDGMENT) as typeof rows; } catch { /* table absent */ }
  for (const r of rows) {
    const p = out.get(r.sid) ?? { decisive: false, attempts: 0 };
    p.attempts++; if (DECISIVE.has(r.decision as ExecutionVerdict)) p.decisive = true;
    out.set(r.sid, p);
  }
  return out;
}

/**
 * Merged loop PRs at/after merged_at + SURVIVAL_DAYS without a decisive settlement_execution row and with fewer than
 * MAX_ATTEMPTS unknown rows; never-tried first, then oldest merge first. Read-only.
 */
export function settlementCandidates(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Candidate[] {
  let prs: ReturnType<typeof loopPrSettlements> = [];
  try { prs = loopPrSettlements(db, now, undefined, env); } catch { return []; }
  const prior = priorJudgments(db);
  const out: Candidate[] = [];
  for (const p of prs) {
    const merged = Date.parse(String(p.outcome?.merged_at ?? ''));
    if (p.outcome?.state !== 'merged' || !Number.isFinite(merged) || now - merged < SURVIVAL_DAYS * DAY) continue;
    const seen = prior.get(p.run_id);
    if (seen?.decisive || (seen?.attempts ?? 0) >= MAX_ATTEMPTS) continue;
    let lease: { metadata: string | null } | undefined; let proposal: { artifact: string | null; target: string | null } | undefined;
    try {
      lease = db.prepare(`SELECT metadata FROM worker_leases WHERE loop_run_id = ? AND role = 'maker' AND status = 'completed'
        AND json_extract(metadata, '$.superseded_by_maker_lease_id') IS NULL ORDER BY updated_at DESC LIMIT 1`).get(p.run_id) as typeof lease;
      proposal = db.prepare(`SELECT json_extract(s.grounding_json, '$.artifactPath') AS artifact, json_extract(s.grounding_json, '$.target') AS target
        FROM loop_runs r JOIN goals g ON g.id = r.goal_id JOIN self_improvements s ON s.id = g.improvement_id WHERE r.id = ?`).get(p.run_id) as typeof proposal;
    } catch { /* tables absent: no test files known */ }
    let meta: { changed_files?: unknown; graded?: { score?: unknown; kind?: unknown; skipped?: unknown } } = {};
    try { meta = JSON.parse(lease?.metadata || '{}'); } catch { /* unreadable lease metadata */ }
    const changed = Array.isArray(meta.changed_files) ? meta.changed_files.map(String) : [];
    let tests = changed.filter((f) => SETTLEMENT_TEST_FILE.test(f));
    if (!tests.length && proposal?.artifact && SETTLEMENT_TEST_FILE.test(proposal.artifact)) tests = [proposal.artifact];
    const g = meta.graded;
    const makerScore = g && g.kind === 'mutant_kill' && typeof g.score === 'number' && Number.isFinite(g.score) ? roundGraded(g.score) : null;
    out.push({
      run_id: p.run_id, pr_url: p.pr_url, pr_number: parsePrUrl(p.pr_url)?.number ?? null, merged_at: String(p.outcome.merged_at),
      settlement_state: p.settlement.state, settlement_reason: p.settlement.reason, test_files: [...new Set(tests)], target: proposal?.target ?? null,
      maker_kill_share: makerScore,
      maker_kill_reason: makerScore !== null ? null : !lease ? 'no completed maker lease' : !g ? 'not recorded (GRADED_FITNESS_MODE off at maker time, or no graded test)'
        : typeof g.skipped === 'string' ? `skipped at maker time: ${g.skipped}` : `graded kind ${String(g.kind)} is not a mutant kill share`,
      attempts: seen?.attempts ?? 0,
    });
  }
  return out.sort((a, b) => (a.attempts === 0 ? 0 : 1) - (b.attempts === 0 ? 0 : 1) || Date.parse(a.merged_at) - Date.parse(b.merged_at));
}

export interface KillNow { score: number | null; killed?: number; total?: number; mutants?: string[]; reason: string | null }

/**
 * Kill share of the PR's server unit test on today's target against fresh seeded mutants: targetMutants seeded with
 * `S<main sha>` (an offset no uuid run id produces), minus the mutants the maker-time seed (the run id) gives on this content.
 */
export function rescoreKillShare(worktree: string, c: Pick<Candidate, 'run_id' | 'target'>, present: string[], mainSha: string, run: KillRunner, budgetMs = GRADED_KILL_BUDGET_MS): KillNow {
  const test = present.find((f) => GRADED_TEST.test(f));
  if (!test) return { score: null, reason: 'no packages/server/src/__tests__ unit test (the graded kill share covers those only)' };
  const target = gradedTarget(test, c.target);
  const file = path.join(worktree, target);
  let original: string;
  try { original = fs.readFileSync(file, 'utf8'); } catch { return { score: null, reason: `target missing on main: ${target}` }; }
  const used = new Set(targetMutants(original, c.run_id, target).map((m) => m.content));
  const fresh = targetMutants(original, `S${mainSha}`, target, WRITE_TEST_MUTANTS * 3).filter((m) => !used.has(m.content)).slice(0, WRITE_TEST_MUTANTS);
  if (!fresh.length) return { score: null, reason: 'no fresh mutant of the target' };
  const k = killShare(path.join(worktree, 'packages/server'), test.replace(/^packages\/server\//, ''), file, original, fresh, run, budgetMs);
  if ('skipped' in k) return { score: null, mutants: fresh.map((m) => m.key), reason: k.skipped };
  return { score: roundGraded(k.killed / k.total), killed: k.killed, total: k.total, mutants: fresh.map((m) => m.key), reason: null };
}

export interface SettlementExecutionTick { mode: SettlementExecutionMode; skipped: string | null; candidates: number; executed: number; recorded: number; by_verdict: Record<string, number> }

/** One daily pass: at most MAX_PER_TICK executed PRs, one judgments row per PR handled. Never throws for a single PR. */
export async function settlementExecutionTick(db: Database, deps: SettlementExecutionDeps, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<SettlementExecutionTick> {
  const mode = settlementExecutionMode(env);
  const out: SettlementExecutionTick = { mode, skipped: null, candidates: 0, executed: 0, recorded: 0, by_verdict: {} };
  if (mode === 'off') return { ...out, skipped: 'off' };
  const repo = env.LOOP_DAEMON_REPOSITORY_PATH;
  if (!repo) return { ...out, skipped: 'no repository path' };
  const candidates = settlementCandidates(db, now, env);
  out.candidates = candidates.length;
  if (!candidates.length) return { ...out, skipped: 'no candidates' };
  const main = deps.mainSha(repo);
  if (!main) return { ...out, skipped: 'origin/main unresolvable' };
  const at = new Date(now).toISOString();
  const record = (c: Candidate, verdict: ExecutionVerdict, reason: string, extra: Record<string, unknown> = {}) => {
    let mergeSha: string | null = null;
    try { mergeSha = c.pr_number ? deps.mergeSha(repo, c.pr_number) : null; } catch { /* unknown */ }
    const killNow = (extra.kill_now as KillNow | undefined)?.score ?? null;
    const answers = {
      pr_url: c.pr_url, pr_number: c.pr_number, run_id: c.run_id, merged_at: c.merged_at, merge_sha: mergeSha, ...(mergeSha ? {} : { merge_sha_reason: 'no main commit names this PR' }),
      main_sha: main, settlement_state: c.settlement_state, settlement_reason: c.settlement_reason, test_files: c.test_files, verdict, reason,
      kill_share_maker: c.maker_kill_share, kill_share_maker_reason: c.maker_kill_reason, kill_share_now: killNow,
      kill_share_drift: killNow !== null && c.maker_kill_share !== null ? +(killNow - c.maker_kill_share).toFixed(3) : null, attempt: c.attempts + 1, ...extra,
    };
    try {
      db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
        VALUES (?, ?, 'loop_pr', ?, ?, 'shadow', ?, ?, ?, ?)`).run(randomUUID(), SETTLEMENT_JUDGMENT, c.run_id, main.slice(0, 16), verdict, reason.slice(0, 300), JSON.stringify(answers), at);
      out.recorded++; out.by_verdict[verdict] = (out.by_verdict[verdict] ?? 0) + 1;
    } catch { /* judgments table absent: evidence only */ }
  };
  let wt: { path: string; dispose(): void } | null = null;
  try {
    for (const c of candidates) {
      if (!c.test_files.length) { record(c, 'no_test_files', 'the PR changed no test file'); continue; }
      const present = c.test_files.filter((f) => { try { return deps.exists(repo, main, f); } catch { return true; } });
      const removed = c.test_files.filter((f) => !present.includes(f));
      if (!present.length) { record(c, 'removed', `every test file is gone from main (${removed.length})`, { removed_files: removed }); continue; }
      if (out.executed >= MAX_PER_TICK) continue;
      out.executed++;
      if (!wt) {
        let opened: ReturnType<SettlementExecutionDeps['openWorktree']>;
        try { opened = deps.openWorktree(repo, main); } catch (e) { opened = { error: e instanceof Error ? e.message : String(e) }; }
        if ('error' in opened) { record(c, 'unknown', `infra: ${opened.error}`.slice(0, 300), { removed_files: removed }); break; }
        wt = opened;
      }
      let t: TestRun;
      try { t = await deps.runTests(wt.path, present); } catch (e) { t = { verdict: 'unknown', reason: `infra: ${e instanceof Error ? e.message : String(e)}` }; }
      const kill: KillNow = t.verdict === 'pass' ? rescoreKillShare(wt.path, c, present, main, deps.kill) : { score: null, reason: `tests ${t.verdict}: no re-score` };
      record(c, t.verdict, t.reason, { removed_files: removed, kill_now: kill, kill_share_now_reason: kill.reason });
    }
  } finally {
    try { wt?.dispose(); } catch { /* best effort */ }
  }
  return out;
}

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });

/** vitest per package for the given repo test files; any failing test → fail, else any unknown → unknown, else pass. */
export async function runVitestFiles(worktree: string, files: string[], run = runChild): Promise<TestRun> {
  const byPkg = new Map<string, string[]>();
  for (const f of files) { const pkg = SETTLEMENT_TEST_FILE.exec(f)?.[1]; if (pkg) byPkg.set(pkg, [...(byPkg.get(pkg) ?? []), f.slice(`packages/${pkg}/`.length)]); }
  if (!byPkg.size) return { verdict: 'unknown', reason: 'no runnable test file' };
  const results: Array<{ pkg: string; verdict: string; reason: string }> = [];
  for (const [pkg, rels] of byPkg) {
    // a fresh name per run: a report left by an earlier run must never be read as this run's verdict
    const report = path.join(worktree, '.djimitflo', `settlement-${pkg}-${randomUUID()}.json`);
    fs.mkdirSync(path.dirname(report), { recursive: true });
    const res = await run('npx', ['--no-install', 'vitest', 'run', ...rels, '--reporter=json', `--outputFile=${report}`], path.join(worktree, 'packages', pkg), TEST_TIMEOUT_MS);
    let parsed: unknown = null;
    try { parsed = JSON.parse(fs.readFileSync(report, 'utf8')); } catch { /* no report */ }
    const r = classifyReport(parsed, res.code, res.timedOut);
    results.push({ pkg, verdict: r.verdict === 'red' ? 'fail' : r.verdict === 'green' ? 'pass' : 'unknown', reason: `${pkg}: ${r.reason}` });
  }
  const reason = results.map((r) => r.reason).join('; ');
  return { verdict: results.some((r) => r.verdict === 'fail') ? 'fail' : results.some((r) => r.verdict === 'unknown') ? 'unknown' : 'pass', reason };
}

/** The production dependencies: the falsifier's WorktreeManager + prepareMakerWorktree path at origin/main, the repo's vitest. */
export function defaultSettlementExecutionDeps(db: Database, loops: Pick<LoopService, 'prepareMakerWorktree'>): SettlementExecutionDeps {
  return {
    mainSha: (repo) => { try { return git(repo, ['rev-parse', '--verify', 'origin/main^{commit}']).trim() || null; } catch { return null; } },
    exists: (repo, sha, file) => { try { git(repo, ['cat-file', '-e', `${sha}:${file}`]); return true; } catch { return false; } },
    mergeSha: (repo, n) => {
      try { return git(repo, ['log', 'origin/main', '-1', '--format=%H', '-E', `--grep=(\\(#${n}\\)$|^Merge pull request #${n} )`]).trim() || null; } catch { return null; }
    },
    openWorktree: (repo, sha) => {
      const key = `${sha.slice(0, 10)}-${Date.now()}`;
      const branch = `agent/settlement-exec/${key}`;
      let wt: string | null = null;
      const dispose = () => {
        if (wt) { try { git(repo, ['worktree', 'remove', '--force', wt]); } catch { fs.rmSync(wt, { recursive: true, force: true }); } }
        try { git(repo, ['branch', '-D', branch]); } catch { /* never created */ }
      };
      try {
        wt = new WorktreeManager(db).createWorktree(repo, 'settlement-exec', key, branch, true);
        git(wt, ['reset', '--hard', sha]);
        const prep = loops.prepareMakerWorktree('settlement-exec', key, wt);
        if (prep.install_failed || prep.shared_failed) { dispose(); return { error: `dependency preparation failed (install ${prep.install_exit}, shared ${prep.shared_exit})` }; }
        return { path: wt, dispose };
      } catch (e) { dispose(); return { error: `worktree: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` }; }
    },
    runTests: (wt, files) => runVitestFiles(wt, files),
    kill: vitestRunner,
  };
}

type Stat = { n: number; mean: number | null; zero_share: number | null };
const stat = (xs: number[]): Stat => ({ n: xs.length, mean: xs.length ? roundGraded(xs.reduce((a, b) => a + b, 0) / xs.length) : null, zero_share: xs.length ? roundGraded(xs.filter((x) => x === 0).length / xs.length) : null });

/**
 * Read-only: the graded score of each run's deciding maker lease (latest completed, not superseded — the lease merge survival
 * attributes) against the run's labels: proposal verified or not, and pr_outcome.survived (survived / regressed / unsettled).
 */
export function gradedVsLabels(db: Database) {
  let rows: Array<{ run: string; score: number; kind: string | null; status: string | null; survived: number | null }> = [];
  try {
    rows = db.prepare(`SELECT l.loop_run_id AS run, json_extract(l.metadata, '$.graded.score') AS score, json_extract(l.metadata, '$.graded.kind') AS kind,
        s.status AS status, json_extract(r.metadata, '$.pr_outcome.survived') AS survived
      FROM worker_leases l JOIN loop_runs r ON r.id = l.loop_run_id LEFT JOIN goals g ON g.id = r.goal_id LEFT JOIN self_improvements s ON s.id = g.improvement_id
      WHERE l.role = 'maker' AND l.status = 'completed' AND json_extract(l.metadata, '$.superseded_by_maker_lease_id') IS NULL
        AND json_type(l.metadata, '$.graded.score') IN ('integer', 'real') ORDER BY l.updated_at LIMIT 20000`).all() as typeof rows;
  } catch { return { n: null, by_kind: null, note: 'worker_leases unreadable' }; }
  const perRun = new Map<string, (typeof rows)[number]>();
  for (const r of rows) perRun.set(r.run, r); // ordered by updated_at: the last lease per run wins
  const kinds = new Map<string, Record<'verified' | 'not_verified' | 'survived' | 'regressed' | 'unsettled', number[]>>();
  for (const r of perRun.values()) {
    const k = String(r.kind ?? 'unknown');
    const b = kinds.get(k) ?? { verified: [], not_verified: [], survived: [], regressed: [], unsettled: [] }; kinds.set(k, b);
    const s = Number(r.score);
    (r.status === 'verified' ? b.verified : b.not_verified).push(s);
    (r.survived === 1 ? b.survived : r.survived === 0 ? b.regressed : b.unsettled).push(s);
  }
  return {
    n: perRun.size,
    by_kind: [...kinds.entries()].map(([kind, b]) => ({ kind, verified: stat(b.verified), not_verified: stat(b.not_verified), survived: stat(b.survived), regressed: stat(b.regressed), unsettled: stat(b.unsettled) })),
    note: 'one graded score per run (deciding maker lease); labels: proposal status verified, pr_outcome.survived. Report only',
  };
}

/** evolution-evidence `settlement_execution`: latest row per PR, counts, kill-share drift (insufficient below MIN_N), graded vs labels. */
export function settlementExecutionEvidence(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const mode = settlementExecutionMode(env);
  const note = `merged loop PRs ≥ ${SURVIVAL_DAYS} d: their test files re-run at origin/main (removed = every test file gone; unknown = infra / timeout / not run, never a negative), then a kill share against fresh seeded mutants of the target vs the maker-time score. Shadow: nothing reads it for a decision`;
  let rows: Array<{ sid: string; decision: string; answers: string | null; at: string }> = [];
  try { rows = db.prepare('SELECT subject_id AS sid, decision, answers_json AS answers, created_at AS at FROM judgments WHERE judgment = ? ORDER BY created_at, rowid').all(SETTLEMENT_JUDGMENT) as typeof rows; } catch { /* table absent */ }
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) latest.set(r.sid, r);
  const counts = { pass: 0, fail: 0, removed: 0, unknown: 0, no_test_files: 0 };
  const now_: number[] = []; const paired: Array<[number, number]> = [];
  for (const r of latest.values()) {
    if (r.decision in counts) counts[r.decision as keyof typeof counts]++;
    let a: { kill_share_now?: unknown; kill_share_maker?: unknown } = {};
    try { a = JSON.parse(r.answers || '{}'); } catch { /* unreadable */ }
    if (typeof a.kill_share_now === 'number') {
      now_.push(a.kill_share_now);
      if (typeof a.kill_share_maker === 'number') paired.push([a.kill_share_now, a.kill_share_maker]);
    }
  }
  const n = counts.pass + counts.fail + counts.removed;
  const mean = (xs: number[]) => (xs.length ? roundGraded(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
  let pending: number | null = null;
  try { pending = settlementCandidates(db, now, env).length; } catch { /* unknown, stays null */ }
  return {
    mode, status: n >= MIN_N ? 'ok' as const : 'insufficient' as const, min_n: MIN_N, cap_per_tick: MAX_PER_TICK, n, counts, pending,
    pass_rate: n >= MIN_N && counts.pass + counts.fail ? roundGraded(counts.pass / (counts.pass + counts.fail)) : null,
    kill_share: {
      n_now: now_.length, mean_now: now_.length >= MIN_N ? mean(now_) : null, n_paired: paired.length,
      mean_maker: paired.length >= MIN_N ? mean(paired.map((p) => p[1])) : null,
      mean_drift: paired.length >= MIN_N ? +(paired.reduce((s, [a, b]) => s + (a - b), 0) / paired.length).toFixed(3) : null,
    },
    last_run_at: rows.length ? rows[rows.length - 1].at : null,
    graded_vs_labels: gradedVsLabels(db),
    note,
  };
}

/** Daily (first run 20 min after boot); SETTLEMENT_EXECUTION_MODE=shadow. */
export function startSettlementExecution(db: Database, loops: Pick<LoopService, 'prepareMakerWorktree'>): (() => void) | null {
  if (!noteScheduler('settlement_execution', 'SETTLEMENT_EXECUTION_MODE', settlementExecutionMode() !== 'off', DAY)) return null;
  const deps = defaultSettlementExecutionDeps(db, loops);
  let running = false;
  const tick = guardTick('settlement_execution', async () => {
    if (running) return; running = true;
    try {
      const r = await settlementExecutionTick(db, deps); markRun('settlement_execution');
      if (r.recorded) console.log(`🧪 settlement execution: ${r.recorded} PR(s) judged (${Object.entries(r.by_verdict).map(([k, v]) => `${k} ${v}`).join(', ')}), ${r.executed} executed`);
    } finally { running = false; }
  });
  const first = setTimeout(tick, 1_200_000); first.unref?.();
  const timer = setInterval(tick, DAY); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}

/**
 * U1 (B-intelligence 10-29): merge survival cannot fail on test-only PRs (49/49 survived, 0 regressed) and the settlement
 * re-run cannot either (49/49 pass) — but the fresh-mutant kill share the re-run already records does vary. Report only:
 * `settlement_value` = per lane the kill share now of each PR's latest settlement_execution row (null = not re-scored, not
 * counted): n, median, how many are below SETTLEMENT_VALUE_THRESHOLD, with a Wilson CI on that share. And the survival section
 * says per lane whether it can carry information: 0 regressions over ≥ SURVIVAL_INFORMATIVE_MIN_N settled PRs is
 * informative:false. Nothing reads either for a decision: fitness, Gate B and auto-merge are unchanged.
 */
export const SETTLEMENT_VALUE_THRESHOLD = 0.2;
export const SURVIVAL_INFORMATIVE_MIN_N = 30;

/** The oracle lane of every loop run with a proposal: mutation-gap → mutation, test-gap#exports → exports, test-gap, else other. */
export function runLanes(db: Database): Map<string, string> {
  const out = new Map<string, string>();
  let rows: Array<{ id: string; ev: string | null }> = [];
  try {
    rows = db.prepare(`SELECT r.id, s.evidence_refs_json AS ev FROM loop_runs r JOIN goals g ON g.id = r.goal_id JOIN self_improvements s ON s.id = g.improvement_id
      WHERE json_extract(r.metadata, '$.pr_url') IS NOT NULL`).all() as typeof rows;
  } catch { /* tables absent: every run is 'other' */ }
  for (const r of rows) { const ev = r.ev ?? ''; out.set(r.id, /"mutation-gap:/.test(ev) ? 'mutation' : laneOf(ev) ?? 'other'); }
  return out;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return roundGraded(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};

/** evolution-evidence `settlement_value` (report only). `ci` = a binomial interval (the evidence passes Wilson). */
export function settlementValueEvidence(db: Database, ci: (k: number, n: number) => [number, number], lanes = runLanes(db)) {
  let rows: Array<{ sid: string; answers: string | null }> = [];
  try { rows = db.prepare('SELECT subject_id AS sid, answers_json AS answers FROM judgments WHERE judgment = ? ORDER BY created_at, rowid').all(SETTLEMENT_JUDGMENT) as typeof rows; } catch { /* table absent */ }
  const latest = new Map<string, string | null>();
  for (const r of rows) latest.set(r.sid, r.answers);
  const byLane = new Map<string, number[]>();
  for (const [sid, answers] of latest) {
    let k: unknown = null;
    try { k = (JSON.parse(answers || '{}') as { kill_share_now?: unknown }).kill_share_now; } catch { /* unreadable */ }
    if (typeof k !== 'number' || !Number.isFinite(k)) continue;
    const lane = lanes.get(sid) ?? 'other';
    byLane.set(lane, [...(byLane.get(lane) ?? []), k]);
  }
  return {
    threshold: SETTLEMENT_VALUE_THRESHOLD,
    by_lane: [...byLane.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([lane, xs]) => {
      const below = xs.filter((x) => x < SETTLEMENT_VALUE_THRESHOLD).length;
      return { lane, n: xs.length, kill_share_now_median: median(xs), below, share_below: roundGraded(below / xs.length), ci: ci(below, xs.length) };
    }),
    note: `per lane: the fresh-mutant kill share at settlement (settlement_execution kill_share_now, latest row per PR; not re-scored = not counted); below = kill share < ${SETTLEMENT_VALUE_THRESHOLD}, Wilson 95 %. Report only: fitness, Gate B and auto-merge do not read it`,
  };
}

/** Survival per lane over settled PRs only; informative:false when a lane has 0 regressions at ≥ SURVIVAL_INFORMATIVE_MIN_N settled. */
export function survivalByLane(prs: LoopPrSettlement[], lanes: Map<string, string>) {
  const byLane = new Map<string, LoopPrSettlement['settlement']['state'][]>();
  for (const p of prs) { const lane = lanes.get(p.run_id) ?? 'other'; byLane.set(lane, [...(byLane.get(lane) ?? []), p.settlement.state]); }
  return [...byLane.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([lane, states]) => {
    const c = survivalCounts(states);
    const vacuous = c.settled >= SURVIVAL_INFORMATIVE_MIN_N && c.regressed === 0;
    return { lane, survived: c.survived, regressed: c.regressed, settled: c.settled, survival_rate: c.rate, informative: !vacuous,
      informative_reason: vacuous ? `0 regressions in ${c.settled} settled PRs: line-retention survival cannot fail on this lane (test-only PRs); see settlement_value` : null };
  });
}

