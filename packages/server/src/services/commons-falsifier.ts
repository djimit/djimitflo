import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from './secret-patterns';
import { assessAssertionStrength } from './test-assertion-strength';
import { SkillEvolutionEngine } from './skill-evolution-engine';
import { WorktreeManager } from './worktree-manager';
import { EVIDENCE_ROOM_AUTHOR, EVIDENCE_ROOM_PREFIX } from './commons-evidence-room';
import { guardTick, markRun, noteScheduler } from './scheduler-registry';
import type { LoopService } from './loop-service';

/**
 * Plan AR5, Commons falsifier niche. An agent earns fitness by producing a test that FAILS on main and that a later commit on
 * main makes pass. The oracle is the executed test (red at base → green after), never an LLM judgement.
 *
 * Submission: an evidence-room reply (commons-evidence-room.ts replyToEvidenceRoom) whose typed artefact is
 * `{ kind: 'test', test_file, command, content }`. The submitted command is stored, never executed: the test runs with the
 * repo's own runner (`npx --no-install vitest run <file>` from the test's package, as the gym oracle does).
 * Tick (hourly, at most COMMONS_FALSIFIER_MAX_PER_DAY executions per 24 h, default 5), in a throwaway worktree
 * (WorktreeManager + LoopService.prepareMakerWorktree, the deterministic checks' own `npm ci`) at origin/main:
 *  - base: write the test (a new file under a test directory, nothing else), run it → red / green / unknown (with reason);
 *  - settle: a red-at-base test is re-run when main has moved, for 14 days; green on a later main, with a change between the
 *    two commits to a module the test imports, settles it (green_after = that main sha; the fix lies in (last red, green]).
 * Fitness: one skill_outcomes row (skill `falsifier:<agent>`, domain `falsifier`, success 1) per settled red→green test. A
 * test green at base earns nothing (not a negative); infra errors, timeouts and suites that did not run are unknown, never a
 * negative (E2). No reader of skill_outcomes selects this skill or domain, so no gate, maker, checker or experiment changes.
 * Guards: content must survive redactSecrets unchanged, the path must be a test file under packages/<pkg>/…/(__tests__|test|tests)/,
 * the test must import a repo module and carry assertions (test-assertion-strength), and only agents listed in
 * COMMONS_FALSIFIER_AGENTS ('*' = any runtime agent; unset = none) are evaluated: the test is agent-written code run on this
 * host, with a minimal environment (no model keys, no database path).
 *   COMMONS_FALSIFIER_MODE=off (default) | shadow — needs COMMONS_EVIDENCE_ROOM_MODE=on for submissions to exist.
 */
export type FalsifierMode = 'off' | 'shadow';
export const falsifierMode = (env: NodeJS.ProcessEnv = process.env): FalsifierMode => (env.COMMONS_FALSIFIER_MODE === 'shadow' ? 'shadow' : 'off');
export const FALSIFIER_DOMAIN = 'falsifier';
export const SETTLE_DAYS = 14;
export const MIN_N = 5;
const WINDOW_DAYS = 30;
const MAX_BASE_ATTEMPTS = 3;
const DAY = 86_400_000;
const TEST_TIMEOUT_MS = 300_000;
export const maxPerDay = (env: NodeJS.ProcessEnv = process.env): number => { const n = Math.trunc(Number(env.COMMONS_FALSIFIER_MAX_PER_DAY)); return n > 0 ? Math.min(n, 24) : 5; };

/** packages/<pkg>/…/(__tests__|test|tests)/….(test|spec).(ts|js…) — the falsifier only ever writes such a file. */
export const FALSIFIER_TEST_PATH = /^packages\/([a-z0-9-]+)\/(?:[A-Za-z0-9_.@-]+\/)*(?:__tests__|tests?)\/(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+\.(?:test|spec)\.[cm]?[jt]sx?$/;

export type Verdict = 'red' | 'green' | 'unknown';
export interface RunResult { verdict: Verdict | 'rejected'; reason: string }
export interface Submission { message_id: string; agent: string; test_file: string; content: string; submitted_at: string }

export interface FalsifierDeps {
  /** origin/main HEAD of the repository, or null */
  mainSha(repo: string): string | null;
  /** whether `file` exists at `sha` */
  exists(repo: string, sha: string, file: string): boolean;
  /** files changed between two commits, or null when unknown */
  changedBetween(repo: string, from: string, to: string): string[] | null;
  /** writes the test into a throwaway worktree at `sha` and runs only it */
  run(repo: string, sha: string, sub: Submission): Promise<RunResult>;
}

const ensureTable = (db: Database) => db.exec(`CREATE TABLE IF NOT EXISTS commons_falsifier_runs (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, agent TEXT NOT NULL, test_file TEXT NOT NULL,
  kind TEXT NOT NULL, sha TEXT, verdict TEXT NOT NULL, reason TEXT NOT NULL, executed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_commons_falsifier_runs_message ON commons_falsifier_runs(message_id, created_at);`);

interface RunRow { message_id: string; agent: string; test_file: string; kind: 'base' | 'recheck' | 'rejected'; sha: string | null; verdict: string; reason: string; executed: number; created_at: string }

/** Agents whose tests may run here: COMMONS_FALSIFIER_AGENTS ('*' = any); never operators or Djimitflo's own authors. */
export function agentAllowed(agent: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (agent.startsWith('operator:') || agent.startsWith('djimitflo:') || agent === EVIDENCE_ROOM_AUTHOR) return false;
  const list = String(env.COMMONS_FALSIFIER_AGENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes('*') || list.includes(agent);
}

/** Repo paths (without extension) a test imports: relative specifiers resolved against the test, and @djimitflo/<pkg> packages. */
export function repoImports(testFile: string, content: string): string[] {
  const specs = [...content.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"\n]+)['"]/gm)].map((m) => m[1]);
  const out = new Set<string>();
  for (const s of specs) {
    if (s.startsWith('./') || s.startsWith('../')) {
      const p = path.posix.normalize(path.posix.join(path.posix.dirname(testFile), s)).replace(/\.[cm]?[jt]sx?$/, '');
      if (!p.startsWith('..') && p.startsWith('packages/')) out.add(p);
    } else {
      const pkg = /^@djimitflo\/([a-z0-9-]+)/.exec(s)?.[1];
      if (pkg) out.add(`packages/${pkg}`);
    }
  }
  return [...out];
}

/** Cheap guards before anything runs; a string is the rejection reason. */
export function guardSubmission(sub: Submission): string | null {
  if (!FALSIFIER_TEST_PATH.test(sub.test_file) || sub.test_file.includes('..')) return 'test_file is not a test file under a package test directory';
  if (!sub.content.trim()) return 'no test content';
  if (redactSecrets(sub.content).redacted !== sub.content) return 'test content contains a secret pattern';
  if (!repoImports(sub.test_file, sub.content).length) return 'test imports nothing from the repository';
  const strength = assessAssertionStrength([{ path: sub.test_file, text: sub.content }], null);
  if (strength.status === 'fail') return `weak test: ${strength.reasons.join('; ')}`;
  // the TypeScript parser is absent in the prod image: the worktree run repeats the check there; a textual floor here
  if (strength.status === 'skipped' && !/\bexpect\s*\(|\bassert\b/.test(sub.content)) return 'test has no assertions';
  return null;
}

const iso = (t: number) => new Date(t).toISOString();

/** Test artefact replies with content from evaluable agents, oldest first (30 d). */
export function listSubmissions(db: Database, now: number, env: NodeJS.ProcessEnv = process.env): Submission[] {
  let rows: Array<{ id: string; from_agent: string; timestamp: string; artefact: string | null }> = [];
  try {
    rows = db.prepare(`SELECT id, from_agent, timestamp, json_extract(payload_json, '$.params.artefact') AS artefact FROM agent_messages
      WHERE ((json_extract(payload_json, '$.params.evidence_room_kind') = 'reply' AND json_extract(payload_json, '$.thread_id') LIKE ? || '%')
          -- AC-06: a test artefact on a Commons investigation thread, only while COMMONS_INVESTIGATION_MODE=on
          OR (? = 'on' AND json_extract(payload_json, '$.params.artefact_origin') = 'investigation' AND json_extract(payload_json, '$.params.evidence_status') = 'artefact'))
        AND json_extract(payload_json, '$.params.artefact.kind') = 'test' AND json_type(payload_json, '$.params.artefact.content') = 'text'
        AND timestamp >= ? ORDER BY timestamp, rowid`).all(EVIDENCE_ROOM_PREFIX, env.COMMONS_INVESTIGATION_MODE === 'on' ? 'on' : 'off', iso(now - WINDOW_DAYS * DAY)) as typeof rows;
  } catch { return []; } // agent_messages absent
  return rows.flatMap((r) => {
    if (!agentAllowed(r.from_agent, env)) return [];
    try {
      const a = JSON.parse(r.artefact || '{}') as { test_file?: unknown; content?: unknown };
      return typeof a.test_file === 'string' && typeof a.content === 'string'
        ? [{ message_id: r.id, agent: r.from_agent, test_file: a.test_file, content: a.content, submitted_at: r.timestamp }] : [];
    } catch { return []; }
  });
}

export type SubmissionState = 'new' | 'rejected' | 'unknown' | 'red_at_base' | 'green_at_base' | 'settled_green' | 'unrelated_green' | 'expired';
export interface SubmissionView { message_id: string; agent: string; test_file: string; state: SubmissionState; red_at_base: boolean | null; reason: string | null;
  base_sha: string | null; base_at: string | null; last_sha: string | null; last_red_sha: string | null; green_sha: string | null; base_attempts: number }

/** The state of one submission from its run rows (oldest first). */
export function viewOf(sub: { message_id: string; agent: string; test_file: string }, runs: RunRow[], now: number): SubmissionView {
  const v: SubmissionView = { ...sub, state: 'new', red_at_base: null, reason: null, base_sha: null, base_at: null, last_sha: null, last_red_sha: null, green_sha: null, base_attempts: 0 };
  const rejected = runs.find((r) => r.verdict === 'rejected');
  if (rejected) return { ...v, state: 'rejected', reason: rejected.reason };
  const bases = runs.filter((r) => r.kind === 'base');
  v.base_attempts = bases.length;
  const base = bases.find((r) => r.verdict === 'red' || r.verdict === 'green');
  if (!base) return bases.length ? { ...v, state: 'unknown', reason: bases[bases.length - 1].reason } : v;
  v.base_sha = base.sha; v.base_at = base.created_at; v.red_at_base = base.verdict === 'red'; v.reason = base.reason;
  const executed = runs.filter((r) => r.executed && r.sha);
  v.last_sha = executed.length ? executed[executed.length - 1].sha : base.sha;
  if (!v.red_at_base) return { ...v, state: 'green_at_base' };
  v.last_red_sha = [...runs].reverse().find((r) => r.verdict === 'red')?.sha ?? base.sha;
  const green = runs.find((r) => r.kind === 'recheck' && r.verdict === 'green');
  if (green) return { ...v, state: 'settled_green', green_sha: green.sha };
  const unrelated = runs.find((r) => r.kind === 'recheck' && r.verdict === 'green_unrelated');
  if (unrelated) return { ...v, state: 'unrelated_green', reason: unrelated.reason, green_sha: unrelated.sha };
  if (now - Date.parse(base.created_at) > SETTLE_DAYS * DAY) return { ...v, state: 'expired' };
  return { ...v, state: 'red_at_base' };
}

function runsByMessage(db: Database): Map<string, RunRow[]> {
  const map = new Map<string, RunRow[]>();
  for (const r of db.prepare('SELECT * FROM commons_falsifier_runs ORDER BY created_at, rowid').all() as RunRow[]) {
    const list = map.get(r.message_id) ?? []; list.push(r); map.set(r.message_id, list);
  }
  return map;
}

export interface FalsifierTick { mode: FalsifierMode; skipped: string | null; executed: number; rejected: number; settled: number }

/** One pass: base runs for new submissions, then re-runs of red-at-base tests on a moved main; bounded per 24 h. */
export async function falsifierTick(db: Database, deps: FalsifierDeps, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<FalsifierTick> {
  const mode = falsifierMode(env);
  const out: FalsifierTick = { mode, skipped: null, executed: 0, rejected: 0, settled: 0 };
  if (mode === 'off') return { ...out, skipped: 'off' };
  const repo = env.LOOP_DAEMON_REPOSITORY_PATH;
  if (!repo) return { ...out, skipped: 'no repository path' };
  ensureTable(db);
  const subs = listSubmissions(db, now, env);
  if (!subs.length) return { ...out, skipped: 'no submissions' };
  const main = deps.mainSha(repo);
  if (!main) return { ...out, skipped: 'origin/main unresolvable' };
  const record = (sub: Submission, kind: RunRow['kind'], sha: string | null, verdict: string, reason: string, executed: boolean) =>
    db.prepare('INSERT INTO commons_falsifier_runs (id, message_id, agent, test_file, kind, sha, verdict, reason, executed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), sub.message_id, sub.agent, sub.test_file, kind, sha, verdict, redactSecrets(reason).redacted.slice(0, 500), executed ? 1 : 0, iso(now));
  const used = (db.prepare('SELECT COUNT(*) AS n FROM commons_falsifier_runs WHERE executed = 1 AND created_at >= ?').get(iso(now - DAY)) as { n: number }).n;
  let budget = maxPerDay(env) - used;
  const runs = runsByMessage(db);
  const views = subs.map((s) => ({ sub: s, view: viewOf(s, runs.get(s.message_id) ?? [], now) }));

  // base: new submissions, and unknown ones (infra) up to MAX_BASE_ATTEMPTS
  for (const { sub } of views.filter(({ view }) => view.state === 'new' || (view.state === 'unknown' && view.base_attempts < MAX_BASE_ATTEMPTS))) {
    const why = guardSubmission(sub) ?? (deps.exists(repo, main, sub.test_file) ? 'test_file already exists on main' : null);
    if (why) { record(sub, 'rejected', main, 'rejected', why, false); out.rejected += 1; continue; }
    if (budget <= 0) break;
    budget -= 1; out.executed += 1;
    const r = await safeRun(deps, repo, main, sub);
    record(sub, r.verdict === 'rejected' ? 'rejected' : 'base', main, r.verdict, r.reason, true);
    if (r.verdict === 'rejected') out.rejected += 1;
  }

  // settle: red at base, not settled, within 14 d, main moved since the last executed run
  for (const { sub, view } of views.filter(({ view }) => view.state === 'red_at_base' && view.last_sha !== main)) {
    if (budget <= 0) break;
    budget -= 1; out.executed += 1;
    const r = await safeRun(deps, repo, main, sub);
    if (r.verdict !== 'green') { record(sub, 'recheck', main, r.verdict === 'rejected' ? 'unknown' : r.verdict, r.reason, true); continue; }
    // the oracle tightened: a pass with no change to an imported module (a time bomb, a flake) is not a fix
    const changed = deps.changedBetween(repo, view.last_red_sha ?? view.base_sha!, main);
    const imports = repoImports(sub.test_file, sub.content);
    const touched = changed?.some((f) => { const p = f.replace(/\.[cm]?[jt]sx?$/, ''); return imports.some((i) => p === i || p.startsWith(`${i}/`)); });
    if (!touched) {
      record(sub, 'recheck', main, 'green_unrelated', changed ? 'green, but no imported module changed since the last red run' : 'green, changed files unknown', true);
      continue;
    }
    record(sub, 'recheck', main, 'green', `red at ${view.last_red_sha ?? view.base_sha}, green at ${main}`, true);
    new SkillEvolutionEngine(db).recordOutcome(`falsifier:${sub.agent}`, { success: true, tokensUsed: 0, durationMs: 0, domain: FALSIFIER_DOMAIN,
      taskId: sub.message_id, agentId: sub.agent, evidenceRefs: [`message:${sub.message_id}`, `test:${sub.test_file}`, `falsifier_red:${view.last_red_sha ?? view.base_sha}`, `falsifier_green:${main}`] });
    out.settled += 1;
  }
  return out;
}

async function safeRun(deps: FalsifierDeps, repo: string, sha: string, sub: Submission): Promise<RunResult> {
  try { return await deps.run(repo, sha, sub); } catch (e) { return { verdict: 'unknown', reason: `infra: ${e instanceof Error ? e.message : String(e)}` }; }
}

/** vitest's JSON report → verdict. Only an executed, failing test is red; a suite that did not run is unknown. */
export function classifyReport(report: unknown, exitCode: number | null, timedOut: boolean): RunResult {
  if (timedOut) return { verdict: 'unknown', reason: 'timeout' };
  const r = (report && typeof report === 'object' ? report : null) as { numTotalTests?: number; numFailedTests?: number; numPassedTests?: number; numFailedTestSuites?: number } | null;
  if (!r || typeof r.numTotalTests !== 'number') return { verdict: 'unknown', reason: `no test report (exit ${exitCode ?? 'signal'})` };
  if (r.numTotalTests === 0) return { verdict: 'unknown', reason: 'no test ran (suite failed to load or file not collected)' };
  if ((r.numFailedTests ?? 0) > 0) return { verdict: 'red', reason: `${r.numFailedTests} of ${r.numTotalTests} test(s) failed` };
  if ((r.numFailedTestSuites ?? 0) > 0) return { verdict: 'unknown', reason: 'suite error outside the tests' };
  if (exitCode === 0 && (r.numPassedTests ?? 0) > 0) return { verdict: 'green', reason: `${r.numPassedTests} test(s) passed` };
  return { verdict: 'unknown', reason: `inconclusive report (exit ${exitCode ?? 'signal'})` };
}

const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });

/** The production dependencies: WorktreeManager worktree at the sha, the checks' own install, the repo's vitest. */
export function defaultFalsifierDeps(db: Database, loops: Pick<LoopService, 'prepareMakerWorktree'>): FalsifierDeps {
  return {
    mainSha: (repo) => { try { return git(repo, ['rev-parse', '--verify', 'origin/main^{commit}']).trim() || null; } catch { return null; } },
    exists: (repo, sha, file) => { try { git(repo, ['cat-file', '-e', `${sha}:${file}`]); return true; } catch { return false; } },
    changedBetween: (repo, from, to) => { try { return git(repo, ['diff', '--name-only', `${from}..${to}`]).split('\n').filter(Boolean); } catch { return null; } },
    run: async (repo, sha, sub) => {
      const key = `${sub.message_id.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 40)}-${sha.slice(0, 10)}-${Date.now()}`;
      const branch = `agent/falsifier/${key}`;
      const wm = new WorktreeManager(db);
      let wt: string | null = null;
      try {
        wt = wm.createWorktree(repo, 'falsifier', key, branch, true);
        git(wt, ['reset', '--hard', sha]);
        const prep = loops.prepareMakerWorktree('falsifier', key, wt);
        if (prep.install_failed || prep.shared_failed) return { verdict: 'unknown', reason: `infra: dependency preparation failed (install ${prep.install_exit}, shared ${prep.shared_exit})` };
        const strength = assessAssertionStrength([{ path: sub.test_file, text: sub.content }], null, { worktree: wt });
        if (strength.status === 'fail') return { verdict: 'rejected', reason: `weak test: ${strength.reasons.join('; ')}` };
        const target = path.join(wt, sub.test_file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const realDir = fs.realpathSync(path.dirname(target)); const realWt = fs.realpathSync(wt);
        if (!realDir.startsWith(realWt + path.sep)) return { verdict: 'rejected', reason: 'test directory resolves outside the worktree' };
        // a later main may carry a file at this path (the fix PR's own test): the submitted content wins in this throwaway tree
        fs.writeFileSync(target, sub.content, 'utf8');
        const pkg = FALSIFIER_TEST_PATH.exec(sub.test_file)![1];
        const cwd = path.join(wt, 'packages', pkg);
        const reportPath = path.join(wt, '.djimitflo', `falsifier-${key}.json`);
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        const rel = sub.test_file.slice(`packages/${pkg}/`.length);
        const res = await runChild('npx', ['--no-install', 'vitest', 'run', rel, '--reporter=json', `--outputFile=${reportPath}`], cwd, TEST_TIMEOUT_MS);
        let report: unknown = null;
        try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { /* no report */ }
        return classifyReport(report, res.code, res.timedOut);
      } finally {
        if (wt) { try { git(repo, ['worktree', 'remove', '--force', wt]); } catch { fs.rmSync(wt, { recursive: true, force: true }); } }
        try { git(repo, ['branch', '-D', branch]); } catch { /* never created */ }
      }
    },
  };
}

/** Async child with a minimal environment: agent-written code never sees model keys, tokens or the database path. */
export function runChild(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', CI: 'true', TZ: 'UTC', RUNTIME_SANDBOX: '1', DJIMITFLO_RUNTIME_CHILD: '1' };
    const child = spawn(cmd, args, { cwd, env, stdio: 'ignore' });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve({ code: null, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut }); });
  });
}

type Counts = { submitted: number; rejected: number; red_at_base: number; green_at_base: number; unknown: number; settled_green: number; expired: number; pending: number };

/** evolution-evidence `falsifier`: counts per state and per agent (30 d); insufficient below MIN_N submissions; nulls while off. */
export function falsifierEvidence(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const mode = falsifierMode(env);
  const note = `evidence-room test artefacts (30 d) run at origin/main: red at base, then re-run on later main for ${SETTLE_DAYS} d; settled_green = red→green with an imported module changed (one skill_outcomes row, domain falsifier). unknown = infra / not run / unrelated green, never a negative`;
  const empty = { mode, status: 'insufficient' as const, min_n: MIN_N, window_days: WINDOW_DAYS, cap_per_day: maxPerDay(env), executions_24h: null as number | null,
    totals: null as Counts | null, settle_rate: null as number | null, by_agent: null as Array<Counts & { agent: string }> | null, note };
  if (mode === 'off') return empty;
  let runs: Map<string, RunRow[]>;
  let executions: number;
  try { runs = runsByMessage(db); executions = (db.prepare('SELECT COUNT(*) AS n FROM commons_falsifier_runs WHERE executed = 1 AND created_at >= ?').get(iso(now - DAY)) as { n: number }).n; }
  catch { return { ...empty, note: `${note}; no falsifier run recorded yet (table absent)` }; }
  const zero = (): Counts => ({ submitted: 0, rejected: 0, red_at_base: 0, green_at_base: 0, unknown: 0, settled_green: 0, expired: 0, pending: 0 });
  const totals = zero(); const per = new Map<string, Counts>();
  for (const s of listSubmissions(db, now, env)) {
    const v = viewOf(s, runs.get(s.message_id) ?? [], now);
    const c = per.get(s.agent) ?? zero(); per.set(s.agent, c);
    for (const t of [totals, c]) {
      t.submitted += 1;
      if (v.state === 'rejected') t.rejected += 1;
      if (v.red_at_base === true) t.red_at_base += 1;
      if (v.red_at_base === false) t.green_at_base += 1;
      if (v.state === 'unknown' || v.state === 'unrelated_green') t.unknown += 1;
      if (v.state === 'settled_green') t.settled_green += 1;
      if (v.state === 'expired') t.expired += 1;
      if (v.state === 'new' || v.state === 'red_at_base') t.pending += 1;
    }
  }
  const status = totals.submitted >= MIN_N ? 'ok' as const : 'insufficient' as const;
  return { ...empty, status, executions_24h: executions, totals,
    settle_rate: totals.red_at_base >= MIN_N ? +(totals.settled_green / totals.red_at_base).toFixed(3) : null,
    by_agent: [...per.entries()].map(([agent, c]) => ({ agent, ...c })).sort((a, b) => b.submitted - a.submitted || a.agent.localeCompare(b.agent)) };
}

export function startCommonsFalsifier(db: Database, loops: Pick<LoopService, 'prepareMakerWorktree'>): (() => void) | null {
  const intervalMs = 3_600_000;
  if (!noteScheduler('commons_falsifier', 'COMMONS_FALSIFIER_MODE', falsifierMode() !== 'off', 3_600_000)) return null;
  const deps = defaultFalsifierDeps(db, loops);
  let running = false;
  const tick = guardTick('commons_falsifier', async () => {
    if (running) return; running = true;
    try { const r = await falsifierTick(db, deps); markRun('commons_falsifier'); if (r.executed || r.settled) console.log(`🧪 falsifier: ${r.executed} run(s), ${r.settled} settled, ${r.rejected} rejected`); }
    finally { running = false; }
  });
  const first = setTimeout(tick, 600_000); first.unref?.();
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
