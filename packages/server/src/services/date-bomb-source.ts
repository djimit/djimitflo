import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { AuditEventType, RiskLevel } from '@djimitflo/shared';
import { AuditService } from './audit-service';
import { SelfImprovementService } from './self-improvement-service';
import { guardTick, markRun, noteScheduler } from './scheduler-registry';
import { runChild } from './commons-falsifier';
import { defaultSettlementExecutionDeps, type SettlementExecutionDeps } from './settlement-execution';
import type { LoopService } from './loop-service';

/**
 * Date-bomb lane: Djimitflo finds the server tests that pass today and fail on a later date (a fixed date mixed with code that
 * reads the clock) and proposes a test-only fix per test file. The finding source and the maker gate are the same script,
 * scripts/time-travel-tests.mjs (#1286: the suite with only Date moved N days; a suspect is re-run once and kept only when it
 * repeats, so a flaky test is reported apart; a test red at +0 is an ordinary failure, never a date bomb).
 * DATE_BOMB_LANE = off | shadow | on (default off):
 *   off    — nothing runs, nothing is recorded;
 *   shadow — one `date_bomb_scan` judgments row per scan and one `date_bomb_candidate` row per detected bomb (file, test,
 *            horizon, the detector's error line; cause_class is null: the detector does not classify). No proposal;
 *   on     — one proposal per test file with bombs (the acceptance and the scope are per file), <= DATE_BOMB_MAX_PER_DAY per
 *            24 h, through generateFromGroundedGap: the panel stays, the maker approval is human (the `date-bomb:` refs match
 *            neither oracleLaneSkipsPanel nor testGapAutoApproveScope, so ORACLE_LANES_SKIP_PANEL / ORACLE_LANES_AUTO_APPROVE
 *            do not cover this lane), the merge is human. Each bomb still gets its `date_bomb_candidate` row (mode act).
 * Every date-bomb run gets the in-code check `test:date-bomb`: the maker may change only the test file, then the worktree's
 * detector with --strict on that file must exit 0 at +0 d and +N d and every bombed test must still pass at +0 (a deleted,
 * renamed or skipped test fails). A missing detector, report or input FAILS it (never skipped).
 *
 * ponytail: where the detector runs in prod. The daily CI job's report (#1286) is a GitHub artifact the VPS cannot fetch, and
 * the VPS never calls the workstation, so the lane runs the detector itself, through the settlement-execution path that
 * already does this on prod: a throwaway worktree at origin/main with its dependencies prepared (prepareMakerWorktree), the
 * worktree's own scripts/time-travel-tests.mjs in a minimal-env async child (runChild: no keys, no DB path). Ceiling (2-core
 * VPS): one scan per DATE_BOMB_SCAN_EVERY_MS (7 d, persisted as the scan row, so restarts do not rescan), at most
 * DATE_BOMB_MAX_FILES server test files changed in the last DATE_BOMB_COMMITS commits, horizons +7/+30 d, killed after
 * DATE_BOMB_WALL_MS. A bomb in a test file nobody touched in those commits is not seen here (the daily CI job still sees it).
 * Upgrade trigger: a date bomb turns main red in a file outside that window, or the scan row is `insufficient` twice in a
 * row → deliver the CI report through the gym worker pull path (the workstation pulls, the VPS never calls out).
 */
export type DateBombMode = 'off' | 'shadow' | 'on';
export const dateBombMode = (env: NodeJS.ProcessEnv = process.env): DateBombMode =>
  env.DATE_BOMB_LANE === 'on' ? 'on' : env.DATE_BOMB_LANE === 'shadow' ? 'shadow' : 'off';
export const DATE_BOMB_CHECK = 'test:date-bomb';
export const DATE_BOMB_DAYS = [7, 30];
export const DATE_BOMB_MAX_PER_DAY = 2;
export const DATE_BOMB_SCAN_EVERY_MS = 7 * 86_400_000;
export const DATE_BOMB_COMMITS = 50;
export const DATE_BOMB_MAX_FILES = 15;
export const DATE_BOMB_WALL_MS = 15 * 60_000;
const CHECK_TIMEOUT_MS = 10 * 60_000;
const DAY = 86_400_000;
const DETECTOR = 'scripts/time-travel-tests.mjs';
/** a server test file (the detector's default workspace) */
export const DATE_BOMB_TEST_FILE = /^packages\/server\/src\/(?:[\w.@-]+\/)*[\w.@-]+\.test\.ts$/;
const WORKSPACE = 'packages/server/';
/** the child environment of every detector run (as commons-falsifier runChild): no keys, no tokens, no database path */
const CHILD_ENV = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', CI: 'true', TZ: 'UTC', RUNTIME_SANDBOX: '1', DJIMITFLO_RUNTIME_CHILD: '1' });

export interface TimeTravelOutcome { file: string; test: string; status: string; error?: string | null }
export interface TimeTravelReport {
  baseline: { passed: number; failed: number; tests?: TimeTravelOutcome[] };
  horizons: Array<{ days: number; dateBombs: TimeTravelOutcome[]; flaky: TimeTravelOutcome[] }>;
}
export interface DateBomb { file: string; test: string; days: number; status: string; error: string | null }

const repoPath = (workspaceFile: string) => (workspaceFile.startsWith(WORKSPACE) ? workspaceFile : `${WORKSPACE}${workspaceFile}`);

/** Confirmed bombs of a report (flaky and red-at-+0 tests are not bombs), each at the first horizon it fails, as repo paths. */
export function dateBombsOf(report: TimeTravelReport): DateBomb[] {
  const out = new Map<string, DateBomb>();
  for (const h of [...(report.horizons ?? [])].sort((a, b) => a.days - b.days)) {
    for (const b of h.dateBombs ?? []) {
      const file = repoPath(b.file);
      if (!DATE_BOMB_TEST_FILE.test(file) || out.has(`${file} > ${b.test}`)) continue;
      out.set(`${file} > ${b.test}`, { file, test: b.test, days: h.days, status: b.status, error: b.error ?? null });
    }
  }
  return [...out.values()];
}

export interface DateBombDeps extends Pick<SettlementExecutionDeps, 'mainSha' | 'openWorktree'> {
  /** repo paths of the server test files the scan covers (newest change first, bounded) */
  recentTestFiles(worktree: string): string[];
  /** the worktree's own detector on those files: its report, or why there is none */
  detect(worktree: string, files: string[]): Promise<{ report: TimeTravelReport } | { error: string }>;
}

/** Server test files changed in the last DATE_BOMB_COMMITS commits that still exist, newest change first, at most DATE_BOMB_MAX_FILES. */
export function recentServerTestFiles(worktree: string): string[] {
  const log = execFileSync('git', ['-C', worktree, 'log', '-n', String(DATE_BOMB_COMMITS), '--name-only', '--format=', '--', 'packages/server/src'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  const files = [...new Set(log.split('\n').map((l) => l.trim()))].filter((f) => DATE_BOMB_TEST_FILE.test(f) && fs.existsSync(path.join(worktree, f)));
  return files.slice(0, DATE_BOMB_MAX_FILES);
}

/** The worktree's scripts/time-travel-tests.mjs at DATE_BOMB_DAYS on `files` (async, minimal env, killed after DATE_BOMB_WALL_MS). */
export async function runDetector(worktree: string, files: string[], run = runChild): Promise<{ report: TimeTravelReport } | { error: string }> {
  const script = path.join(worktree, DETECTOR);
  if (!fs.existsSync(script)) return { error: `detector missing: ${DETECTOR}` };
  // a fresh name per run: a report left by an earlier run must never be read as this run's result
  const out = path.join(worktree, '.djimitflo', `time-travel-${randomUUID()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const res = await run(process.execPath, [script, '--days', DATE_BOMB_DAYS.join(','), '--out', out, ...files], worktree, DATE_BOMB_WALL_MS);
  if (res.timedOut) return { error: `detector timed out after ${DATE_BOMB_WALL_MS / 60_000} min` };
  if (res.code !== 0 && res.code !== 1) return { error: `detector could not measure (exit ${res.code ?? 'signal'})` };
  try { return { report: JSON.parse(fs.readFileSync(out, 'utf8')) as TimeTravelReport }; } catch { return { error: `detector wrote no report (exit ${res.code})` }; }
}

/** The date-bomb inputs of a goal's proposal (file, horizon, bombed tests), else null. */
export function dateBombInputs(db: Database, goalId: string | null | undefined): { file: string; days: number; tests: string[] } | null {
  if (!goalId) return null;
  let refs: unknown;
  try {
    const row = db.prepare('SELECT s.evidence_refs_json AS refs FROM goals g JOIN self_improvements s ON s.id = g.improvement_id WHERE g.id = ?').get(goalId) as { refs: string | null } | undefined;
    refs = JSON.parse(row?.refs || '[]');
  } catch { return null; }
  const strings = Array.isArray(refs) ? refs.filter((r): r is string => typeof r === 'string') : [];
  const file = strings.find((r) => r.startsWith('date-bomb:primary/'))?.slice('date-bomb:primary/'.length);
  if (file === undefined) return null;
  return {
    file, days: Number(strings.find((r) => r.startsWith('date-bomb-days:'))?.slice('date-bomb-days:'.length)),
    tests: strings.filter((r) => r.startsWith('date-bomb-test:')).map((r) => r.slice('date-bomb-test:'.length)),
  };
}

export const dateBombCommand = (file: string, days: number): string => `node ${DETECTOR} --strict --days ${days} ${file}`;

/** The deterministic check record of a date-bomb run (null for every other run): scope, then the detector at +0 and +N. */
export function dateBombCheck(db: Database, goalId: string | null | undefined, worktree: string, outputDir: string, changedFiles: unknown): Record<string, unknown> | null {
  const inputs = dateBombInputs(db, goalId);
  if (!inputs) return null;
  const stdoutPath = path.join(outputDir, `${DATE_BOMB_CHECK}.stdout.log`);
  const stderrPath = path.join(outputDir, `${DATE_BOMB_CHECK}.stderr.log`);
  const fail = (reason: string) => {
    fs.writeFileSync(stdoutPath, '', 'utf8'); fs.writeFileSync(stderrPath, `${reason}\n`, 'utf8');
    return { name: DATE_BOMB_CHECK, status: 'fail', reason, exit_status: null, stdout_path: stdoutPath, stderr_path: stderrPath };
  };
  if (!DATE_BOMB_TEST_FILE.test(inputs.file) || !Number.isInteger(inputs.days) || inputs.days <= 0 || !inputs.tests.length) return fail('missing_input');
  const outside = (Array.isArray(changedFiles) ? changedFiles.map(String) : []).filter((f) => f !== inputs.file);
  if (outside.length) return fail(`out_of_scope: ${outside.slice(0, 5).join(', ')} (a date-bomb fix changes only ${inputs.file})`);
  const script = path.join(worktree, DETECTOR);
  if (!fs.existsSync(script)) return fail('missing_detector');
  const reportPath = path.join(outputDir, `${DATE_BOMB_CHECK}.report.json`);
  fs.rmSync(reportPath, { force: true });
  const r = spawnSync(process.execPath, [script, '--strict', '--days', String(inputs.days), '--out', reportPath, inputs.file],
    { cwd: worktree, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: CHILD_ENV() });
  const exit = typeof r.status === 'number' ? r.status : null;
  let report: TimeTravelReport | null = null;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as TimeTravelReport; } catch { /* no report: fails below */ }
  const passedAtZero = new Set((report?.baseline.tests ?? []).filter((t) => t.status === 'passed').map((t) => `${repoPath(t.file)} > ${t.test}`));
  const missing = inputs.tests.filter((t) => !passedAtZero.has(`${inputs.file} > ${t}`));
  fs.writeFileSync(stdoutPath, r.stdout || '', 'utf8');
  fs.writeFileSync(stderrPath, `${r.stderr || r.error?.message || ''}${missing.length ? `\nbombed test(s) not passing at +0 d (deleted, renamed or skipped?): ${missing.join(' | ')}\n` : ''}`, 'utf8');
  const pass = exit === 0 && Boolean(report) && !missing.length;
  return { name: DATE_BOMB_CHECK, status: pass ? 'pass' : 'fail', ...(pass ? {} : { reason: !report ? 'no_report' : missing.length ? 'bombed_test_missing' : 'fails_at_a_horizon' }),
    exit_status: exit, stdout_path: stdoutPath, stderr_path: stderrPath };
}

type Scan = { sha: string | null; files: string[]; report: TimeTravelReport } | { sha: string | null; files: string[]; error: string };

export class DateBombSourceService {
  private running = false;
  constructor(private readonly db: Database, private readonly deps: DateBombDeps) {}

  async run(now = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<{ created: number; skipped: string; bombs: number | null }> {
    const mode = dateBombMode(env);
    if (mode === 'off') return { created: 0, skipped: 'disabled', bombs: null };
    const repo = env.TEST_GAP_REPO_PATH || env.LOOP_DAEMON_REPOSITORY_PATH;
    if (!repo) return { created: 0, skipped: 'no repository path', bombs: null };
    const last = this.db.prepare("SELECT created_at AS at FROM judgments WHERE judgment = 'date_bomb_scan' ORDER BY created_at DESC LIMIT 1").get() as { at: string } | undefined;
    if (last && now.getTime() - Date.parse(last.at) < DATE_BOMB_SCAN_EVERY_MS) return { created: 0, skipped: `scanned ${last.at}`, bombs: null };
    if (this.running) return { created: 0, skipped: 'scan running', bombs: null };
    this.running = true;
    try {
      const scan = await this.scan(repo);
      const bombs = 'report' in scan ? dateBombsOf(scan.report) : [];
      this.recordScan(scan, bombs, mode, now);
      if ('error' in scan) return { created: 0, skipped: scan.error, bombs: null };
      if (mode === 'shadow') {
        for (const b of bombs) this.recordCandidate(b, scan.sha, 'shadow', 'recorded', 'shadow: no proposal', null, now);
        return { created: 0, skipped: 'shadow', bombs: bombs.length };
      }
      return { ...this.propose(bombs, scan.sha, now), bombs: bombs.length };
    } finally { this.running = false; }
  }

  private async scan(repo: string): Promise<Scan> {
    const sha = this.deps.mainSha(repo);
    if (!sha) return { sha, files: [], error: 'no origin/main' };
    const wt = this.deps.openWorktree(repo, sha);
    if ('error' in wt) return { sha, files: [], error: wt.error };
    try {
      const files = this.deps.recentTestFiles(wt.path);
      if (!files.length) return { sha, files, report: { baseline: { passed: 0, failed: 0 }, horizons: [] } };
      const r = await this.deps.detect(wt.path, files);
      return 'report' in r ? { sha, files, report: r.report } : { sha, files, error: r.error };
    } catch (e) {
      return { sha, files: [], error: `scan: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
    } finally {
      try { wt.dispose(); } catch { /* best effort */ }
    }
  }

  /** on: one proposal per test file with bombs, the daily cap, never twice for a file with an open or recent (14 d) proposal. */
  private propose(bombs: DateBomb[], sha: string | null, now: Date): { created: number; skipped: string } {
    const createdToday = (this.db.prepare("SELECT COUNT(*) n FROM self_improvements WHERE evidence_refs_json LIKE '%\"date-bomb:%' AND created_at >= ?")
      .get(new Date(now.getTime() - DAY).toISOString()) as { n: number }).n;
    let room = Math.max(0, DATE_BOMB_MAX_PER_DAY - createdToday);
    const byFile = new Map<string, DateBomb[]>();
    for (const b of bombs) byFile.set(b.file, [...(byFile.get(b.file) ?? []), b]);
    const improvements = new SelfImprovementService(this.db);
    let created = 0;
    for (const [file, list] of byFile) {
      const open = this.db.prepare(`SELECT id FROM self_improvements WHERE evidence_refs_json LIKE ?
          AND (status IN ('proposed', 'scheduled', 'executing', 'evaluating', 'needs_grounding') OR created_at >= ?) LIMIT 1`)
        .get(`%"date-bomb:primary/${file}"%`, new Date(now.getTime() - 14 * DAY).toISOString()) as { id: string } | undefined;
      let decision = 'skipped'; let reason: string; let proposalId: string | null = null;
      if (open) reason = `open or recent proposal ${open.id}`;
      else if (room <= 0) reason = 'daily cap reached';
      else {
        const p = this.proposal(improvements, file, list);
        if (p) {
          decision = 'proposed'; proposalId = p.id; reason = `proposal ${p.id}`; created += 1; room -= 1;
          try {
            new AuditService(this.db).record({ event_type: AuditEventType.TASK_CREATED, action: 'date_bomb_proposal', resource_type: 'self_improvement', resource_id: p.id,
              agent_id: 'date-bomb-lane', risk_level: RiskLevel.LOW, metadata: { file, main_sha: sha, tests: list.map((b) => b.test), acceptance: dateBombCommand(file, Math.min(...list.map((b) => b.days))) } });
          } catch { /* the judgment rows below are the evidence either way */ }
        } else reason = 'duplicate proposal';
      }
      for (const b of list) this.recordCandidate(b, sha, 'act', decision, reason, proposalId, now);
    }
    return { created, skipped: created ? '' : bombs.length ? 'no new date bomb' : 'no date bomb' };
  }

  private proposal(improvements: SelfImprovementService, file: string, list: DateBomb[]) {
    const days = Math.min(...list.map((b) => b.days));
    const command = dateBombCommand(file, days);
    const budget = 'one maker lease, <= 10 minutes, <= 30k tokens, one checker lease; one test file';
    const tests = list.map((b) => `\`${b.test}\` (fails at +${b.days} d${b.error ? `: ${b.error}` : ''})`).join('; ');
    const description = `Test-only fix of a date bomb in ${file}: ${list.length} test(s) pass today and fail when only Date is moved ${days} days ahead — ${tests}. `
      + 'The test mixes a fixed date (a seeded row, a literal ISO string, a registry date) with code that reads the clock. Make the test independent of today: '
      + "pin the clock for it (vi.useFakeTimers({ toFake: ['Date'] }) + vi.setSystemTime, restored in afterEach), seed relative to the clock the code reads, or pass an explicit now. "
      + `Edit only ${file}. Do not touch product code, other tests, configs, ${DETECTOR} or the time-travel harness, and do not delete, rename or skip the tests. `
      + `RUNTIME COMMAND: from the repository root run \`${command}\` — it exits 0 when every test in the file passes at +0 d and at +${days} d. `
      + `ARTIFACT: the command's summary plus the one-file diff. BUDGET: ${budget}.`;
    return improvements.generateFromGroundedGap({
      type: 'bug_fix',
      title: `Fix the date bomb in ${file} (red from +${days} d)`,
      description,
      rationale: `${DETECTOR} (#1286) confirmed ${list.length} test(s) in ${file} that pass at +0 d and fail at +${days} d on a re-run; one test file, verified by the same script at both horizons.`,
      evidenceRef: `date-bomb:primary/${file}`,
      extraEvidenceRefs: [`date-bomb-days:${days}`, ...list.map((b) => `date-bomb-test:${b.test}`)],
      grounding: { target: file, acceptanceTest: command, runtimeCommand: command, artifactPath: file, budget },
    });
  }

  private recordScan(scan: Scan, bombs: DateBomb[], mode: DateBombMode, now: Date): void {
    try {
      const ok = 'report' in scan;
      const flaky = ok ? [...new Set((scan.report.horizons ?? []).flatMap((h) => (h.flaky ?? []).map((f) => `${repoPath(f.file)} > ${f.test}`)))] : null;
      const answers = { main_sha: scan.sha, files: scan.files, days: DATE_BOMB_DAYS, commits: DATE_BOMB_COMMITS,
        baseline: ok ? { passed: scan.report.baseline?.passed ?? null, failed: scan.report.baseline?.failed ?? null } : null,
        bombs: ok ? bombs.map((b) => ({ file: b.file, test: b.test, days: b.days })) : null, flaky, error: ok ? null : scan.error };
      this.db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
        VALUES (?, 'date_bomb_scan', 'repo', 'primary', ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), scan.sha ?? 'no-sha', mode === 'on' ? 'act' : 'shadow', ok ? 'recorded' : 'insufficient',
          ok ? `${bombs.length} date bomb(s) in ${scan.files.length} test file(s) at +${DATE_BOMB_DAYS.join('/+')} d` : `scan failed: ${scan.error}`,
          JSON.stringify(answers), now.toISOString());
    } catch { /* evidence only */ }
  }

  private recordCandidate(b: DateBomb, sha: string | null, mode: 'shadow' | 'act', decision: string, reason: string, proposalId: string | null, now: Date): void {
    try {
      this.db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
        VALUES (?, 'date_bomb_candidate', 'test_file', ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), b.file, sha ?? 'no-sha', mode, decision, reason,
          JSON.stringify({ file: b.file, test: b.test, horizon_days: b.days, status: b.status, error: b.error, cause_class: null, main_sha: sha, proposal_id: proposalId,
            acceptance: dateBombCommand(b.file, b.days) }), now.toISOString());
    } catch { /* evidence only */ }
  }
}

/** Daily tick (first 25 min after boot); the lane itself scans once per DATE_BOMB_SCAN_EVERY_MS. DATE_BOMB_LANE=shadow|on. */
export function startDateBombLane(db: Database, loops: Pick<LoopService, 'prepareMakerWorktree'>): (() => void) | null {
  if (!noteScheduler('date_bomb_lane', 'DATE_BOMB_LANE', dateBombMode() !== 'off', DAY)) return null;
  // the settlement re-run's worktree (origin/main, dependencies prepared); its branch is named agent/settlement-exec/* and removed after
  const { mainSha, openWorktree } = defaultSettlementExecutionDeps(db, loops);
  const lane = new DateBombSourceService(db, { mainSha, openWorktree, recentTestFiles: recentServerTestFiles, detect: (wt, files) => runDetector(wt, files) });
  const tick = guardTick('date_bomb_lane', async () => {
    const r = await lane.run(); markRun('date_bomb_lane');
    if (r.created || r.bombs) console.log(`💣 date-bomb lane: ${r.bombs ?? 0} bomb(s), ${r.created} proposal(s) created`);
  });
  const first = setTimeout(tick, 1_500_000); first.unref?.();
  const timer = setInterval(tick, DAY); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
