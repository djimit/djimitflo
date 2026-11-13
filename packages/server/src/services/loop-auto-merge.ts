import { execFileSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import { AuditEventType, RiskLevel } from '@djimitflo/shared';
import { AuditService } from './audit-service';
import { LoopEventService } from './loop-event-service';
import { testOnlyChange, TEST_ONLY_DIFF_MAX } from './loop-worker-executor-service';
import { pushNotice } from './operator-push';
import { settlementState, SURVIVAL_DAYS, type SettlementOutcome } from './merge-survival';
import { AUDIT_CHECKS_PENDING_HOURS, AUDIT_JUDGMENT, AUDIT_SAMPLE_REASON, auditSampleAutoMode, executedAuditVerdict, isAuditSpotCheck, type AuditInputs, autoMergeMaxPerDay, autoMergeMode, autoMergeRecheck, autoMergeRecheckHours, autoMergeSettlementRevoke, autoMergeValueGate, autoMergeValueGateLanes, autoMergeValueSignal, isAuditSample, isTransientReason, PR_REVIEW_STATUS_CONTEXT,
  readClassState, readLaneRevocations, reasonCode, RECHECK_PER_TICK, revokeClass, revokeLane, SETTLEMENT_REVOKE_JUDGMENT, SETTLEMENT_REVOKE_KILL_BELOW, SETTLEMENT_REVOKE_LANES, SETTLEMENT_REVOKE_SHARE,
  SETTLEMENT_REVOKE_WINDOW, VALUE_GATE_REASONS, VALUE_KILL_SHARE_MIN, valueGateActsOn } from './loop-auto-merge-state';
import { defaultSettlementExecutionDeps, latestSettlements, rescoreKillShare, type KillNow } from './settlement-execution';
import { oracleLane, WRITE_TEST_MUTANTS } from './gym-failure-tasks';
import type { LoopService } from './loop-service';
import { markRun } from './scheduler-registry';
import { assertionStrengthVerdict } from './test-assertion-strength';
import { autoMergeAllowed, parsePrUrl } from './repo-registry';
import { newestRuns, requiredChecksOf, requiredRun, type CheckRun, type ProtectionChecks, type RequiredCheck } from './required-checks';

/**
 * Earned auto-merge for verified test-only loop PRs (operator-approved 2026-10-07: 30 loop PRs, 22 merged by the human,
 * 0 rejected, median 48 h wait). LOOP_AUTO_MERGE_TEST_ONLY: off (default) | shadow (records what it would do) | act.
 *
 * Eligible: a loop draft PR (loop_runs.metadata.pr_url, title 'loop:', head = the maker branch in this repo, never a
 * Dependabot PR) of a run whose proposal is 'verified' with no failed gate; every changed file is a test file
 * (testOnlyChange) and none is deleted; additions + deletions within the maker's lane limit; no outstanding
 * CHANGES_REQUESTED review; the maker's test:assertion-strength verdict is 'pass' (shadow or enforce — skipped, missing or
 * failed is ineligible: F1 09-10, the checker accepted toBeDefined-only tests). A deterministic 10 % (hash of the PR number) stays for the human as an audit sample.
 * Executed audit (AUDIT_SAMPLE_AUTO_MODE off | shadow | act, loop-auto-merge-state): the sample is judged by fresh-mutant kill share,
 * assertion strength and required checks instead of the human; act lets a pass continue below, keeps fail / unknown and a 1-in-5 spot check.
 * Act: mark ready → update the branch when behind (branch protection wants up to date) → wait for every check on the head
 * to be green → squash-merge with the token the draft-PR service uses. Every step is one tick (15 min); nothing blocks.
 * Green (10-26, no false green): the newest run per name decides, and every required context of the base's branch protection
 * needs a success on the head — skipped/neutral/cancelled/stale is 'checks_failed: required_not_success:<name>=<conclusion>';
 * unreadable protection is 'waiting: required_checks_unavailable', never a merge (scripts/merge-train.sh mirrors this).
 * The required producer (protection's app_id) is part of the identity: another app's same-named run never stands in for it.
 * Shadow re-evaluates its would_merge PRs every tick, incl. the merge-conflict check act runs (10-10: #658 went conflicting
 * and stayed 'would_merge'); a decision is rewritten only when it changes.
 * Head binding (P0-6): only the commit the loop verified is merged. The draft-PR service records it as
 * metadata.verified_head_sha when it commits the checked worktree; a run without it is ineligible ('no_verified_head'). The PR
 * head must equal it, or be GitHub's own update-branch merge on top of it (web-flow, signature verified, first parent = the
 * verified head, at most 5 deep); anything else is 'head_moved'. The merge call passes that head as `sha`, so a push between
 * this read and the merge is rejected by GitHub.
 * Value (U2, LOOP_AUTO_MERGE_VALUE_GATE off | shadow | on): after assertion strength, the maker's parent-source FBPA verdict pass or
 * graded kill share / mutation score >= 0.2 (loop-auto-merge-state autoMergeValueSignal); shadow stamps would_block_value, on is ineligible.
 * With LOOP_AUTO_MERGE_VALUE_GATE_LANES set, on blocks only PRs of a listed lane (the proposal's oracle lane, as settlement);
 * other lanes are stamped like shadow.
 * Settled value (B3, LOOP_AUTO_MERGE_SETTLEMENT_REVOKE off | shadow | on): >= 50 % of the last 20 settled exports PRs with a
 * settlement kill share < 0.2 revokes the exports lane (loop-auto-merge-state); in act its PRs are 'revoked_hold'.
 * Cap: LOOP_AUTO_MERGE_MAX_PER_DAY (default 10, rolling 24 h).
 * Revert window: an auto-merged PR that is reverted on main (a commit within 14 d whose message says revert and names the
 * PR or its merge commit), whose added lines merge survival marks removed, or whose merge commit fails a REQUIRED check on
 * main revokes the class (system_state). It then stops acting (decisions become 'revoked_hold') until an operator re-enables it.
 * Required = the merge gate's rule (required-checks.ts: protection context + producer app, newest run per name per app,
 * skipped/neutral is not success, running or missing is not red). A required red must still be red on a later tick's read
 * (auto_merge.checks_red_pending marks the first read; green clears it). A marker set inside the 14 d window is still
 * confirmed after it, and the window does not close while it is unresolved; an unparseable or future marker is re-initialised
 * (never a permanent block). A red first read after the window is not a revocation. A non-required failure (10-26: CodeQL Analyze on
 * #931's merge commit revoked the class; the next commit was green) never revokes: it is an event only.
 * Re-check (LOOP_AUTO_MERGE_RECHECK=on, default off = 'ineligible' is final): an ineligible PR whose reason is TRANSIENT
 * (loop-auto-merge-state) is evaluated again at most once per LOOP_AUTO_MERGE_RECHECK_HOURS (default 6), at most
 * RECHECK_PER_TICK per tick, through every gate above. In act, a re-checked PR whose head checks are still red and that is
 * behind the base gets GitHub's update-branch (expected head = the PR head; the head binding accepts that web-flow merge)
 * and waits as 'rechecking_after_update' while the new CI runs; red again is 'checks_failed' again. Permanent reasons
 * and 'audit_sample' are never re-checked.
 */
/**
 * R12 guard-test list (UXE-00a, operator decision D-UXE-00a): the UX oracle tests. testOnlyChange makes every test file
 * eligible for earned test-only auto-merge, so a loop PR could loosen the oracle that judges UI work; a loop PR touching one
 * of these is ineligible 'oracle_test_file' (permanent: not in TRANSIENT_INELIGIBLE_REASONS, unknown codes fail closed).
 * It only refuses more PRs, never allows more. Exact repo paths; a listed file that does not exist yet is guarded once it does.
 */
export const ORACLE_TEST_FILES = ['packages/server/src/__tests__/ui-fitness.test.ts', 'packages/server/src/__tests__/ux-coverage.test.ts',
  'packages/dashboard/src/RouteSmoke.test.tsx', 'packages/dashboard/src/UX25b.test.tsx', 'packages/dashboard/src/UX4.test.tsx',
  'packages/dashboard/src/UxTasks.test.tsx'] as const;
type Decision = 'merged' | 'would_merge' | 'audit_sample' | 'audit_passed' | 'ineligible' | 'waiting' | 'capped' | 'revoked_hold';
export interface AutoMergeRecord {
  mode: 'shadow' | 'act'; decision: Decision; reason: string; at: string; pr_number: number;
  steps?: string[]; merge_commit_sha?: string; merged_at?: string; window_closed?: boolean; revoked?: string;
  /** revert window: the first read of a required check red on the merge commit (a later tick's red read revokes; green clears) */
  checks_red_pending?: { at: string; reason: string };
  /** revert window: the non-required failures last recorded as an event (never a revocation) */
  non_required_red?: string;
  /** LOOP_AUTO_MERGE_RECHECK: when this PR was last re-checked after a transient ineligible decision, and how often */
  rechecked_at?: string; rechecks?: number;
  /** U2 LOOP_AUTO_MERGE_VALUE_GATE=shadow: the ineligible reason the value gate would have given (the decision is unchanged) */
  would_block_value?: 'value_signal_missing' | 'value_signal_low';
}
interface Pr {
  number: number; state: string; draft?: boolean; title?: string; node_id?: string; mergeable?: boolean | null; mergeable_state?: string;
  user?: { login?: string }; head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null }; base?: { ref?: string };
}
type Checks = 'green' | 'pending' | 'red';
interface MergeCommitChecks { state: Checks; reason?: string; nonRequired: string[] }
const DAY = 86_400_000;
const RED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
/** The newest item per name (by id, then time): a rerun replaces the run it re-ran, an old green never outvotes a newer red. */
const newest = <T extends { id?: number }>(items: T[], name: (t: T) => string, at: (t: T) => string): T[] =>
  [...new Map([...items].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0) || at(a).localeCompare(at(b))).map((t) => [name(t), t] as const)).values()];

/** The executed audit's (a): the fresh-mutant kill share of the PR's server unit test against its target at `head_sha`. */
export type AuditKillExecutor = (c: { run_id: string; head_sha: string; test_files: string[]; target: string | null; maker_mutants: number }) => KillNow | Promise<KillNow>;

export async function runAutoMergeTick(db: Database, fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env, now = new Date(),
  auditKill: AuditKillExecutor | null = null): Promise<{ evaluated: number; merged: number; revoked: boolean }> {
  const mode = autoMergeMode(env);
  const repo = env.GITHUB_REPOSITORY; const token = env.GITHUB_TOKEN;
  if (mode === 'off' || !repo || !token) return { evaluated: 0, merged: 0, revoked: false };
  const base = env.LOOP_DRAFT_PR_BASE || 'main';
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
  // Every call is scoped to the PR's own repo (owner/repo from its URL), never to GITHUB_REPOSITORY by number alone.
  const gh = (slug: string, p: string, method = 'GET', body?: unknown) => fetchImpl(p.startsWith('https://') ? p : `https://api.github.com/repos/${slug}/${p}`,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async <T>(slug: string, p: string): Promise<T | null> => { try { const r = await gh(slug, p); return r.ok ? await r.json() as T : null; } catch { return null; } };
  const events = new LoopEventService(db);
  // `required` (branch protection's checks of the PR head's gate): each needs a success of the newest run from its required
  // producer on this sha — skipped, neutral, cancelled, stale is red ('required_not_success'), running or not reported (by
  // that producer) is pending. Any failing newest run is red here too; the revert window uses mergeCommitChecks (required only).
  const readChecks = async (slug: string, sha: string) => {
    const all = (await json<{ check_runs?: CheckRun[] }>(slug, `commits/${sha}/check-runs?per_page=100`))?.check_runs;
    const status = await json<{ state?: string; total_count?: number; statuses?: Array<{ id?: number; context?: string; state?: string; updated_at?: string }> }>(slug, `commits/${sha}/status`);
    return all ? { all, status, statuses: newest(status?.statuses ?? [], (s) => String(s.context ?? ''), (s) => String(s.updated_at ?? '')) } : null;
  };
  type Read = NonNullable<Awaited<ReturnType<typeof readChecks>>>;
  // a commit status has no app: it can satisfy only a context required from any source
  const statusesFor = (statuses: Read['statuses'], r: RequiredCheck) => (r.app_id === null ? statuses.filter((s) => s.context === r.context) : []);
  const requiredNotSuccess = ({ all, statuses }: Read, required: RequiredCheck[]) => required.flatMap((r) => {
    const c = requiredRun(all, r);
    return [...(c && c.status === 'completed' && c.conclusion !== 'success' ? [`${r.context}=${c.conclusion}`] : []),
      ...statusesFor(statuses, r).filter((s) => s.state !== 'success' && s.state !== 'pending').map((s) => `${r.context}=${s.state}`)];
  });
  const checks = async (slug: string, sha: string, required: RequiredCheck[] = []): Promise<{ state: Checks; reason?: string }> => {
    const read = await readChecks(slug, sha);
    if (!read) return { state: 'pending' };
    const { all, status, statuses } = read;
    const runs = newestRuns(all);
    if (runs.some((c) => c.status === 'completed' && RED.has(String(c.conclusion))) || status?.state === 'failure' || status?.state === 'error') return { state: 'red' };
    const notSuccess = requiredNotSuccess(read, required);
    if (notSuccess.length) return { state: 'red', reason: `required_not_success:${notSuccess.join(',')}` };
    // P0-5: the PR-review heuristic's status is not a check — it can hold a PR (pending / failure) but never makes it green
    const independent = statuses.filter((st) => st.context !== PR_REVIEW_STATUS_CONTEXT);
    if (runs.some((c) => c.status !== 'completed' || c.conclusion === 'cancelled' || c.conclusion === 'stale') || (status?.total_count && status.state === 'pending')) return { state: 'pending' };
    if (required.some((r) => !requiredRun(all, r) && !statusesFor(statuses, r).length)) return { state: 'pending' };
    return { state: runs.length || independent.length ? 'green' : 'pending' }; // no check reported yet = not green
  };
  // branch protection's required checks per repo, read once per tick; null = unreadable (never a remembered list)
  const requiredBySlug = new Map<string, RequiredCheck[] | null>();
  const requiredContexts = async (slug: string): Promise<RequiredCheck[] | null> => {
    if (!requiredBySlug.has(slug)) {
      let ctx = requiredChecksOf(await json<ProtectionChecks>(slug, `branches/${encodeURIComponent(base)}/protection/required_status_checks`));
      // the branch summary carries the same checks and needs read access only
      if (!ctx.length) ctx = requiredChecksOf((await json<{ protection?: { required_status_checks?: ProtectionChecks } }>(slug, `branches/${encodeURIComponent(base)}`))?.protection?.required_status_checks);
      requiredBySlug.set(slug, ctx.length ? ctx : null);
    }
    return requiredBySlug.get(slug) ?? null;
  };

  // P0-6: true when `head` is only GitHub update-branch merges (web-flow, verified signature) stacked on `verified`.
  const updateBranchOnly = async (slug: string, head: string, verified: string): Promise<boolean> => {
    let current = head;
    for (let depth = 0; depth < 5; depth++) {
      const c = await json<{ parents?: Array<{ sha?: string }>; committer?: { login?: string } | null; commit?: { verification?: { verified?: boolean } } }>(slug, `commits/${current}`);
      if (!c || c.parents?.length !== 2 || c.committer?.login !== 'web-flow' || c.commit?.verification?.verified !== true) return false;
      current = String(c.parents[0].sha ?? '');
      if (current === verified) return true;
    }
    return false;
  };

  // behind the base: GitHub says so, or (a draft reports mergeable_state 'draft') the compare of base...head does
  const behind = async (slug: string, pr: Pr, head: string): Promise<boolean> => {
    if (pr.mergeable_state === 'behind') return true;
    const cmp = await json<{ behind_by?: number }>(slug, `compare/${encodeURIComponent(base)}...${head}`);
    return Number(cmp?.behind_by) > 0;
  };

  // The revert window's view of a merge commit on main: only branch protection's required checks can make it red; every
  // other failing newest run / commit status is listed in nonRequired. Unreadable protection or check runs = pending.
  const mergeCommitChecks = async (slug: string, sha: string): Promise<MergeCommitChecks> => {
    const required = await requiredContexts(slug);
    const read = required ? await readChecks(slug, sha) : null;
    if (!required || !read) return { state: 'pending', nonRequired: [] };
    const isRequired = (name: string | undefined, appId: number | undefined) => required.some((r) => r.context === name && (r.app_id === null || r.app_id === appId));
    const nonRequired = [
      ...newestRuns(read.all).filter((c) => c.status === 'completed' && RED.has(String(c.conclusion)) && !isRequired(c.name, c.app?.id)).map((c) => `${c.name}=${c.conclusion}`),
      ...read.statuses.filter((s) => (s.state === 'failure' || s.state === 'error') && !isRequired(s.context, undefined)).map((s) => `${s.context}=${s.state}`)].sort();
    const notSuccess = requiredNotSuccess(read, required);
    if (notSuccess.length) return { state: 'red', reason: notSuccess.join(','), nonRequired };
    // running, or not reported by its required producer, is not red (re-read next tick); a pending required status likewise
    const settled = (r: RequiredCheck) => {
      const c = requiredRun(read.all, r); const st = statusesFor(read.statuses, r);
      return (c ? c.status === 'completed' : st.length > 0) && st.every((x) => x.state !== 'pending');
    };
    return { state: required.every(settled) ? 'green' : 'pending', nonRequired };
  };

  // 1. Revert window over earlier auto-merges (act only produces them; shadow has nothing to revoke).
  const revoked = await checkRevocations(db, json, mergeCommitChecks, events, base, now, env);
  const laneRevokedNow = await settlementRevocation(db, env, now);
  const laneRevocations = readLaneRevocations(db);

  // 2. Candidates: loop PRs without a final decision for this mode.
  const runs = db.prepare(`SELECT r.id, r.status, r.gates_json, r.metadata, s.status AS improvement_status, s.evidence_refs_json AS ev FROM loop_runs r
      LEFT JOIN goals g ON g.id = r.goal_id LEFT JOIN self_improvements s ON s.id = g.improvement_id
    WHERE json_extract(r.metadata, '$.pr_url') IS NOT NULL AND r.created_at >= ? ORDER BY r.created_at`)
    .all(new Date(now.getTime() - 60 * DAY).toISOString()) as Array<{ id: string; status: string; gates_json: string | null; metadata: string; improvement_status: string | null; ev: string | null }>;
  const cap = autoMergeMaxPerDay(env);
  const valueGate = autoMergeValueGate(env);
  const valueLanes = autoMergeValueGateLanes(env);
  const recheckOn = autoMergeRecheck(env); const recheckMs = autoMergeRecheckHours(env) * 3_600_000;
  const auditMode = auditSampleAutoMode(env);
  // the audit judgment of this run's verified head in this mode (one per head and mode), or null when not yet audited
  const audited = (runId: string, head: string) => {
    try { return db.prepare('SELECT decision, reason FROM judgments WHERE id = ?').get(`${AUDIT_JUDGMENT}:${auditMode}:${runId}:${head}`) as { decision: string; reason: string | null } | undefined ?? null; } catch { return null; }
  };
  let evaluated = 0; let merged = 0; let rechecks = 0; let auditsExecuted = 0;
  for (const run of runs) {
    const meta = JSON.parse(run.metadata || '{}') as { pr_url: string; auto_merge?: AutoMergeRecord; verified_head_sha?: string };
    const prev = meta.auto_merge;
    let rechecking = false;
    // the value gate acts on this PR only when on and its lane is listed (or no list is set); otherwise it is shadow for it
    const lane = oracleLane(run.ev);
    const valueActs = valueGateActsOn(valueGate, valueLanes, lane);
    // U2 rollback: a rejection by the value gate alone is final only while the gate acts on the PR — off / shadow / its lane
    // leaving the list re-evaluates it through every gate (every other permanent reason stays final)
    const valueRejectionLifted = prev?.decision === 'ineligible' && !valueActs && (VALUE_GATE_REASONS as readonly string[]).includes(reasonCode(prev.reason));
    // AUDIT_SAMPLE_AUTO_MODE shadow / act: an audit sample is final only once the executed audit judged its verified head
    const auditDue = auditMode !== 'off' && prev?.decision === 'audit_sample' && !audited(run.id, String(meta.verified_head_sha ?? ''));
    if (prev && !valueRejectionLifted && !auditDue && ['merged', 'audit_sample', 'ineligible'].includes(prev.decision)) {
      // final, unless re-check is on and the ineligible reason is transient, its window has passed and this tick has room
      if (!recheckOn || prev.decision !== 'ineligible' || !isTransientReason(prev.reason) || rechecks >= RECHECK_PER_TICK) continue;
      const last = Date.parse(prev.rechecked_at ?? prev.at);
      if (Number.isFinite(last) && now.getTime() - last < recheckMs) continue;
      rechecking = true;
    }
    const ref = parsePrUrl(meta.pr_url);
    if (!ref) continue;
    const { slug, number } = ref;
    if (rechecking && prev) {
      rechecks++;
      // stamped before the evaluation: an unchanged outcome keeps its record, so the window must not hang on a rewrite
      prev.rechecked_at = now.toISOString(); prev.rechecks = (prev.rechecks ?? 0) + 1;
      db.prepare("UPDATE loop_runs SET metadata = json_set(metadata, '$.auto_merge.rechecked_at', ?, '$.auto_merge.rechecks', ?) WHERE id = ?")
        .run(prev.rechecked_at, prev.rechecks, run.id);
    }
    evaluated++;
    // U2 shadow: set once the value gate has looked; every later decision of this PR carries it
    let wouldBlock: AutoMergeRecord['would_block_value'];
    const record = (decision: Decision, reason: string, extra: Partial<AutoMergeRecord> = {}): AutoMergeRecord => {
      // AUDIT_SAMPLE_AUTO_MODE=shadow re-reads a decided audit sample only to audit it: it never rewrites that record
      if (auditDue && auditMode === 'shadow' && prev) return prev;
      // unchanged decision (shadow re-checks every tick): keep the first record, so `at` stays when it was first decided
      if (prev && prev.mode === mode && prev.decision === decision && prev.reason === reason && prev.would_block_value === wouldBlock) return prev;
      // a PR that was ever re-checked keeps its re-check stamp (evidence: re-checks per 24 h); absent otherwise
      const stamp = prev?.rechecked_at ? { rechecked_at: prev.rechecked_at, rechecks: prev.rechecks } : {};
      const rec: AutoMergeRecord = { mode, decision, reason, at: now.toISOString(), pr_number: number, ...stamp, ...(wouldBlock ? { would_block_value: wouldBlock } : {}), ...extra };
      db.prepare("UPDATE loop_runs SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.auto_merge', json(?)) WHERE id = ?").run(JSON.stringify(rec), run.id);
      if (!prev || prev.decision !== decision || prev.reason !== reason) {
        events.recordEvent(run.id, decision === 'merged' ? 'auto_merged' : `auto_merge_${decision}`, 'info', `Auto-merge (${mode}) PR #${number}: ${decision} — ${reason}`,
          { pr_url: meta.pr_url, mode, decision, reason, ...extra });
      }
      return rec;
    };

    // multi-repo: only repos on the explicit LOOP_AUTO_MERGE_REPOS allow-list (default: the primary repo only)
    if (!autoMergeAllowed(slug, env)) { record('ineligible', `repo_not_allowed: ${slug}`); continue; }
    // verified run
    const gates = (() => { try { return JSON.parse(run.gates_json || '[]') as Array<{ status?: string }>; } catch { return [{ status: 'fail' }]; } })();
    if (run.improvement_status !== 'verified' || !['completed', 'ready_for_human_merge'].includes(run.status) || gates.some((g) => g.status === 'fail' || g.status === 'unknown')) {
      record('ineligible', `not_verified: run ${run.status}, proposal ${run.improvement_status ?? 'unlinked'}`); continue;
    }
    const pr = await json<Pr>(slug, `pulls/${number}`);
    if (!pr) { record('waiting', 'github_unavailable'); continue; }
    if (pr.state !== 'open') { record('ineligible', `not_open: ${pr.state}`); continue; }
    const maker = db.prepare(`SELECT branch_name, json_extract(metadata, '$.diff_max_lines') AS diff_max, json_extract(metadata, '$.deterministic_checks') AS checks,
        json_extract(metadata, '$.graded') AS graded FROM worker_leases WHERE loop_run_id = ? AND role = 'maker'
      AND status = 'completed' AND json_extract(metadata, '$.superseded_by_maker_lease_id') IS NULL ORDER BY updated_at DESC LIMIT 1`).get(run.id) as { branch_name: string | null; diff_max: number | null; checks: string | null; graded: string | null } | undefined;
    // never a non-loop or Dependabot PR: the title, the author, the head repo and the maker branch must all match
    if (!String(pr.title ?? '').startsWith('loop:') || /dependabot/i.test(String(pr.user?.login ?? '')) || /^dependabot\//.test(String(pr.head?.ref ?? ''))
      || pr.head?.repo?.full_name !== slug || !maker?.branch_name || pr.head?.ref !== maker.branch_name || pr.base?.ref !== base) {
      record('ineligible', 'not_loop_pr: title, author, head repo, branch or base does not match the loop run'); continue;
    }
    const sha = String(pr.head?.sha ?? '');
    const verifiedHead = typeof meta.verified_head_sha === 'string' ? meta.verified_head_sha : '';
    if (!verifiedHead) { record('ineligible', 'no_verified_head'); continue; }
    if (!sha || (sha !== verifiedHead && !await updateBranchOnly(slug, sha, verifiedHead))) { record('ineligible', 'head_moved', { steps: [`verified ${verifiedHead.slice(0, 12)} ≠ head ${sha.slice(0, 12)}`] }); continue; }
    const files: Array<{ filename: string; status?: string; additions?: number; deletions?: number }> = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await json<typeof files>(slug, `pulls/${number}/files?per_page=100&page=${page}`);
      if (!batch) { files.length = 0; break; }
      files.push(...batch);
      if (batch.length < 100) break;
    }
    if (!files.length) { record('waiting', 'files_unavailable'); continue; }
    const names = files.map((f) => f.filename);
    if (!testOnlyChange(names)) { record('ineligible', `non_test_file: ${names.find((f) => !testOnlyChange([f]))}`); continue; }
    const oracleFile = names.find((f) => (ORACLE_TEST_FILES as readonly string[]).includes(f));
    if (oracleFile) { record('ineligible', `oracle_test_file: ${oracleFile}`); continue; }
    const removed = files.find((f) => f.status === 'removed');
    if (removed) { record('ineligible', `removes_test: ${removed.filename}`); continue; }
    const diff = files.reduce((a, f) => a + (Number(f.additions) || 0) + (Number(f.deletions) || 0), 0);
    const limit = Number(maker.diff_max) > 0 ? Number(maker.diff_max) : TEST_ONLY_DIFF_MAX;
    if (diff > limit) { record('ineligible', `diff_over_limit: ${diff} > ${limit}`); continue; }
    const makerChecks = (() => { try { return JSON.parse(maker.checks || '[]'); } catch { return []; } })();
    const strength = assertionStrengthVerdict(makerChecks);
    if (strength !== 'pass') { record('ineligible', `assertion_strength_${strength ?? 'missing'}`); continue; }
    if (valueGate !== 'off') {
      const value = autoMergeValueSignal(makerChecks, (() => { try { return JSON.parse(maker.graded || 'null'); } catch { return null; } })());
      const block = value === 'pass' ? undefined : value === 'low' ? 'value_signal_low' as const : 'value_signal_missing' as const;
      if (block && valueActs) { record('ineligible', block); continue; }
      wouldBlock = block;
    }
    const reviews = await json<Array<{ user?: { login?: string }; state?: string }>>(slug, `pulls/${number}/reviews?per_page=100`);
    if (!reviews) { record('waiting', 'reviews_unavailable'); continue; }
    const latest = new Map<string, string>();
    for (const r of reviews) if (r.state && r.state !== 'COMMENTED' && r.state !== 'PENDING') latest.set(String(r.user?.login), r.state);
    if ([...latest.values()].includes('CHANGES_REQUESTED')) { record('ineligible', 'changes_requested'); continue; }
    if (isAuditSample(number) && auditMode === 'off') { record('audit_sample', AUDIT_SAMPLE_REASON); continue; }
    if (isAuditSample(number)) {
      const prior = audited(run.id, verifiedHead);
      // judged: shadow changes nothing; act keeps a failed / unknown / spot-checked PR for the human, a passed one goes on below
      if (prior && (auditMode === 'shadow' || prior.decision !== 'audit_passed')) { record('audit_sample', auditMode === 'act' ? `${prior.decision}: ${prior.reason ?? ''}` : AUDIT_SAMPLE_REASON); continue; }
      if (!prior) {
        // (c) the merge gate's green on the head; pending defers the audit (CI still running) for at most AUDIT_CHECKS_PENDING_HOURS
        const req = await requiredContexts(slug);
        const c = req ? await checks(slug, sha, req) : null;
        const cs: AuditInputs['checks'] = c ? { state: c.state, ...(c.reason ? { reason: c.reason } : {}) } : { state: 'unavailable' };
        const sampledAt = prev?.decision === 'audit_sample' ? Date.parse(prev.at) : now.getTime();
        const young = !Number.isFinite(sampledAt) || now.getTime() - sampledAt < AUDIT_CHECKS_PENDING_HOURS * 3_600_000;
        if (cs.state === 'pending' && young) { record('audit_sample', AUDIT_SAMPLE_REASON); continue; }
        if (cs.state === 'pending') cs.reason = `pending > ${AUDIT_CHECKS_PENDING_HOURS} h`;
        // (a) executed only when (b) and (c) can still pass; at most one execution per tick (the kill runs block)
        const runnable = strength === 'pass' && cs.state === 'green';
        if (runnable && auditKill && auditsExecuted >= 1) { record('audit_sample', AUDIT_SAMPLE_REASON); continue; }
        const graded = (() => { try { return JSON.parse(maker.graded || 'null') as { score?: unknown; kind?: unknown; total?: unknown } | null; } catch { return null; } })();
        const target = (db.prepare(`SELECT json_extract(s.grounding_json, '$.target') AS target FROM loop_runs r JOIN goals g ON g.id = r.goal_id
          JOIN self_improvements s ON s.id = g.improvement_id WHERE r.id = ?`).get(run.id) as { target: string | null } | undefined)?.target ?? null;
        let kill: KillNow | null = null;
        if (runnable) {
          if (!auditKill) kill = { score: null, reason: 'no audit executor (the tick runs without the loop worktree service)' };
          else {
            auditsExecuted++;
            try {
              kill = await auditKill({ run_id: run.id, head_sha: sha, test_files: names, target,
                maker_mutants: typeof graded?.total === 'number' && Number.isInteger(graded.total) && graded.total > 0 ? graded.total : WRITE_TEST_MUTANTS });
            } catch (e) { kill = { score: null, reason: `infra: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` }; }
          }
        }
        const { verdict, why } = executedAuditVerdict({ strength, checks: cs, kill });
        const spot = verdict === 'pass' && isAuditSpotCheck(number);
        const auditDecision = verdict === 'pass' ? (spot ? 'audit_spot_check' : 'audit_passed') : verdict === 'fail' ? 'audit_failed' : 'audit_unknown';
        const auditReason = spot ? `${why}; 1 in 5 passes stays for the human` : why;
        const answers = { pr_url: meta.pr_url, pr_number: number, head_sha: sha, verified_head_sha: verifiedHead, lane, test_files: names, target,
          kill_share: kill?.score ?? null, killed: kill?.killed ?? null, total: kill?.total ?? null, mutants: kill?.mutants ?? null, kill_reason: kill?.reason ?? null,
          kill_share_min: VALUE_KILL_SHARE_MIN, maker_graded: graded, assertion_strength: strength, checks: cs.state, checks_reason: cs.reason ?? null, verdict, spot_check: spot };
        try {
          db.prepare(`INSERT OR IGNORE INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
            VALUES (?, ?, 'loop_pr', ?, ?, ?, ?, ?, ?, ?)`).run(`${AUDIT_JUDGMENT}:${auditMode}:${run.id}:${verifiedHead}`, AUDIT_JUDGMENT, run.id, verifiedHead.slice(0, 16), auditMode,
            auditDecision, auditReason.slice(0, 300), JSON.stringify(answers), now.toISOString());
        } catch { record('audit_sample', AUDIT_SAMPLE_REASON); continue; } // judgments absent: nothing judged, nothing acts
        events.recordEvent(run.id, 'auto_merge_audit', verdict === 'pass' ? 'info' : 'warning', `Executed audit (${auditMode}) PR #${number}: ${auditDecision} — ${auditReason}`, { mode: auditMode, decision: auditDecision, ...answers });
        if (auditMode === 'shadow') { record('audit_sample', AUDIT_SAMPLE_REASON); continue; }
        try {
          new AuditService(db).record({ event_type: AuditEventType.TASK_EXECUTED, action: `loop_pr_${auditDecision}`, resource_type: 'pull_request', resource_id: meta.pr_url,
            risk_level: auditDecision === 'audit_passed' ? RiskLevel.MEDIUM : RiskLevel.LOW, metadata: { actor: 'loop-auto-merge-audit', loop_run_id: run.id, reason: auditReason, ...answers } });
        } catch { /* the judgment and the loop event are the record */ }
        if (auditDecision !== 'audit_passed') { record('audit_sample', `${auditDecision}: ${auditReason}`); continue; }
        record('audit_passed', auditReason); continue; // the next tick takes the normal path below
      }
      // act, audited 'audit_passed': the normal auto-merge path
    }

    const effective = mode === 'act' && readClassState(db).state === 'revoked' ? 'held' : mode;
    if (effective === 'held') { record('revoked_hold', `class revoked: ${readClassState(db).reason ?? 'unknown'}`); continue; }
    const laneRevoked = laneRevocations[lane] ?? laneRevocations['*'];
    if (mode === 'act' && laneRevoked) { record('revoked_hold', `lane ${lane} revoked: ${laneRevoked.reason}`); continue; }
    // a PR already counted as would_merge / merged in this window does not count against its own re-check
    const counted = prev?.mode === mode && prev.decision === (mode === 'act' ? 'merged' : 'would_merge') && Date.parse(prev.at) >= now.getTime() - DAY ? 1 : 0;
    const today = (db.prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.auto_merge.decision') = ? AND json_extract(metadata, '$.auto_merge.at') >= ?`)
      .get(mode === 'act' ? 'merged' : 'would_merge', new Date(now.getTime() - DAY).toISOString()) as { n: number }).n;
    if (today - counted >= cap) { record('capped', `${today} ${mode === 'act' ? 'merged' : 'would merge'} in 24 h ≥ cap ${cap}`); continue; }
    const required = await requiredContexts(slug);
    if (!required) { record('waiting', 'required_checks_unavailable'); continue; }
    const { state, reason: checksReason } = await checks(slug, sha, required);
    if (state === 'red') {
      // re-check in act: red checks on a head that is behind the base (main was red then) — update the branch so CI reruns
      if (rechecking && mode === 'act' && pr.mergeable !== false && pr.mergeable_state !== 'dirty' && await behind(slug, pr, sha)) {
        const r = await gh(slug, `pulls/${number}/update-branch`, 'PUT', { expected_head_sha: sha });
        record('waiting', r.ok ? 'rechecking_after_update' : `update_branch_failed: ${r.status}`, { steps: ['update_branch'] }); continue;
      }
      record('ineligible', checksReason ? `checks_failed: ${checksReason}` : 'checks_failed'); continue;
    }
    if (pr.mergeable === false || pr.mergeable_state === 'dirty') { record('ineligible', 'merge_conflict'); continue; }

    if (mode === 'shadow') {
      const steps = [pr.draft ? 'mark_ready' : null, pr.mergeable_state === 'behind' ? 'update_branch' : null, state === 'pending' ? 'wait_for_checks' : null, 'squash_merge'].filter((s): s is string => !!s);
      record('would_merge', `eligible test-only loop PR (${files.length} file(s), ${diff} line(s))`, { steps });
      continue;
    }
    // act — one step per tick
    // the CI that the re-check's update-branch started is still running: nothing else happens until it settles
    if (state === 'pending' && prev?.decision === 'waiting' && prev.reason === 'rechecking_after_update') { record('waiting', 'rechecking_after_update'); continue; }
    if (pr.draft) {
      const r = await gh(slug, 'https://api.github.com/graphql', 'POST', { query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }', variables: { id: pr.node_id } });
      const body = r.ok ? await r.json().catch(() => null) as { errors?: unknown[] } | null : null;
      record('waiting', r.ok && !body?.errors?.length ? 'marked_ready' : `mark_ready_failed: ${r.status}`, { steps: ['mark_ready'] }); continue;
    }
    if (pr.mergeable_state === 'behind') {
      const r = await gh(slug, `pulls/${number}/update-branch`, 'PUT', { expected_head_sha: sha });
      record('waiting', r.ok ? 'branch_updated' : `update_branch_failed: ${r.status}`, { steps: ['update_branch'] }); continue;
    }
    if (pr.mergeable !== true || state !== 'green') { record('waiting', state !== 'green' ? 'checks_pending' : 'mergeability_pending'); continue; }
    const res = await gh(slug, `pulls/${number}/merge`, 'PUT', { merge_method: 'squash', sha, commit_title: `${pr.title} (#${number})`.slice(0, 250) });
    if (!res.ok) { record('waiting', `merge_failed: ${res.status}`); continue; }
    const mergeSha = String(((await res.json().catch(() => ({}))) as { sha?: string }).sha ?? '');
    record('merged', `squash-merged (${files.length} test file(s), ${diff} line(s))`, { merge_commit_sha: mergeSha, merged_at: now.toISOString(), steps: ['squash_merge'] });
    merged++;
    try {
      new AuditService(db).record({ event_type: AuditEventType.TASK_EXECUTED, action: 'loop_pr_auto_merged', resource_type: 'pull_request',
        resource_id: meta.pr_url, risk_level: RiskLevel.MEDIUM, metadata: { actor: 'loop-auto-merge', loop_run_id: run.id, pr_number: number, merge_commit_sha: mergeSha, files: names, diff_lines: diff } });
    } catch { /* the loop event above is the second record */ }
    await pushNotice(`Auto-merged test-only loop PR #${number}: ${meta.pr_url}`, env);
  }
  return { evaluated, merged, revoked: revoked || laneRevokedNow };
}

/** B3: one judgment per lane window (its newest settled PR); in 'on' a firing rule revokes the lane. True when this tick revoked one. */
async function settlementRevocation(db: Database, env: NodeJS.ProcessEnv, now: Date): Promise<boolean> {
  const mode = autoMergeSettlementRevoke(env);
  if (mode === 'off') return false;
  let rows: ReturnType<typeof latestSettlements> = [];
  try { rows = latestSettlements(db); } catch { return false; }
  let fresh = false;
  for (const lane of SETTLEMENT_REVOKE_LANES) {
    const window = rows.filter((r) => r.lane === lane && r.kill_share_now !== null)
      .sort((a, b) => String(b.merged_at ?? '').localeCompare(String(a.merged_at ?? '')) || b.run_id.localeCompare(a.run_id)).slice(0, SETTLEMENT_REVOKE_WINDOW);
    if (!window.length) continue;
    const kills = window.map((r) => Number(r.kill_share_now)); const sorted = [...kills].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2);
    const n = window.length; const below = kills.filter((k) => k < SETTLEMENT_REVOKE_KILL_BELOW).length;
    const fires = n >= SETTLEMENT_REVOKE_WINDOW && below / n >= SETTLEMENT_REVOKE_SHARE;
    const decision = n < SETTLEMENT_REVOKE_WINDOW ? 'insufficient' : !fires ? 'keep' : mode === 'on' ? 'revoke' : 'would_revoke';
    const newest = window[0].run_id;
    const reason = `settlement value: ${below}/${n} settled ${lane} PRs kill < ${SETTLEMENT_REVOKE_KILL_BELOW} fresh mutants at +14 d (rule: ≥ ${SETTLEMENT_REVOKE_SHARE * 100} % of the last ${SETTLEMENT_REVOKE_WINDOW})`;
    const answers = { lane, window: SETTLEMENT_REVOKE_WINDOW, share_min: SETTLEMENT_REVOKE_SHARE, kill_below: SETTLEMENT_REVOKE_KILL_BELOW, n, below, share_below: +(below / n).toFixed(3),
      kill_share_now_median: +(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2).toFixed(3), newest_run_id: newest, run_ids: window.map((r) => r.run_id) };
    let inserted = 0;
    try {
      inserted = db.prepare(`INSERT OR IGNORE INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
        VALUES (?, ?, 'loop_auto_merge_lane', ?, ?, ?, ?, ?, ?, ?)`).run(`${SETTLEMENT_REVOKE_JUDGMENT}:${mode}:${lane}:${newest}`, SETTLEMENT_REVOKE_JUDGMENT, lane, newest.slice(0, 16), mode, decision, reason,
        JSON.stringify(answers), now.toISOString()).changes;
    } catch { continue; } // judgments absent: nothing judged, nothing acts
    // the same window acts once: after an operator re-enable only a newer settlement can revoke again
    if (inserted && decision === 'revoke' && revokeLane(db, lane, reason, newest, now)) {
      fresh = true;
      await pushNotice(`Auto-merge for test-only ${lane} loop PRs REVOKED — ${reason}. Re-enable needs an operator.`, env);
    }
  }
  return fresh;
}

/** The revert window: true when this tick revoked the class. Closes a PR's window after 14 d once merge survival settled it (or 30 d). */
async function checkRevocations(db: Database, json: <T>(slug: string, p: string) => Promise<T | null>, mergeCommitChecks: (slug: string, sha: string) => Promise<MergeCommitChecks>,
  events: LoopEventService, base: string, now: Date, env: NodeJS.ProcessEnv): Promise<boolean> {
  const merged = db.prepare(`SELECT id, created_at, metadata FROM loop_runs WHERE json_extract(metadata, '$.auto_merge.decision') = 'merged'
    AND json_extract(metadata, '$.auto_merge.window_closed') IS NULL`).all() as Array<{ id: string; created_at: string; metadata: string }>;
  let revokedNow = false;
  for (const run of merged) {
    const meta = JSON.parse(run.metadata) as { pr_url: string; auto_merge: AutoMergeRecord; pr_outcome?: SettlementOutcome };
    // E1: only a settled state counts — a pending or anomalous outcome is neither a removal nor a survival
    const settled = settlementState(run.created_at, meta.pr_outcome ?? null, now.getTime()).state;
    const slug = parsePrUrl(meta.pr_url)?.slug ?? env.GITHUB_REPOSITORY ?? '';
    const am = meta.auto_merge; const mergedAt = Date.parse(am.merged_at ?? am.at); const age = now.getTime() - mergedAt;
    const reasons: string[] = [];
    if (settled === 'SETTLED_REGRESSED') reasons.push('merge survival: its added lines were removed from main');
    const inWindow = age <= SURVIVAL_DAYS * DAY;
    // a confirmation started inside the window stays live after it (Codex review of #1066: day 14 - 1 min, then closed)
    let marker = am.checks_red_pending;
    const sha = am.merge_commit_sha ?? '';
    if (inWindow) {
      const commits = await json<Array<{ sha?: string; commit?: { message?: string } }>>(slug, `commits?sha=${encodeURIComponent(base)}&since=${encodeURIComponent(new Date(mergedAt).toISOString())}&per_page=100`);
      const ref = new RegExp(`#${am.pr_number}\\b`);
      const revert = (commits ?? []).find((c) => c.sha !== sha && /revert/i.test(c.commit?.message ?? '')
        && (ref.test(c.commit?.message ?? '') || (sha.length >= 7 && (c.commit?.message ?? '').includes(sha.slice(0, 7)))));
      if (revert) reasons.push(`reverted on ${base} by ${String(revert.sha).slice(0, 8)}`);
    }
    if (sha && (inWindow || (marker && !am.revoked))) {
      const mc = await mergeCommitChecks(slug, sha);
      const setMeta = (path: string, value: unknown) => (value === undefined
        ? db.prepare('UPDATE loop_runs SET metadata = json_remove(metadata, ?) WHERE id = ?').run(path, run.id)
        : db.prepare('UPDATE loop_runs SET metadata = json_set(metadata, ?, json(?)) WHERE id = ?').run(path, JSON.stringify(value), run.id));
      const at8 = `on ${base} at merge commit ${sha.slice(0, 8)}`;
      const nonRequired = mc.nonRequired.join(',');
      if (nonRequired !== (am.non_required_red ?? '')) {
        setMeta('$.auto_merge.non_required_red', nonRequired || undefined);
        if (nonRequired) events.recordEvent(run.id, 'auto_merge_non_required_check_failed', 'info', `PR #${am.pr_number}: non-required check(s) failing ${at8} (${nonRequired}) — not a revocation`,
          { pr_url: meta.pr_url, merge_commit_sha: sha, checks: mc.nonRequired });
      }
      // an unparseable or future first-read time can never confirm: treat it as absent so this read re-initialises it
      const markedAt = Date.parse(String(marker?.at ?? ''));
      const pending = marker && Number.isFinite(markedAt) && markedAt <= now.getTime() ? marker : undefined;
      if (mc.state === 'red' && pending && markedAt < now.getTime()) {
        reasons.push(`required checks failing ${at8} (${mc.reason})`);
        marker = undefined; // resolved: it revokes below
      } else if (mc.state === 'red' && !pending && !am.revoked) {
        marker = { at: now.toISOString(), reason: String(mc.reason) };
        setMeta('$.auto_merge.checks_red_pending', marker);
        events.recordEvent(run.id, 'auto_merge_revoke_pending', 'warning', `PR #${am.pr_number}: required check(s) failing ${at8} (${mc.reason}) — revokes if still red on the next tick`,
          { pr_url: meta.pr_url, merge_commit_sha: sha, reason: mc.reason });
      } else if (mc.state === 'green' && marker) {
        setMeta('$.auto_merge.checks_red_pending', undefined);
        events.recordEvent(run.id, 'auto_merge_revoke_cleared', 'info', `PR #${am.pr_number}: required checks green ${at8} — no revocation`, { pr_url: meta.pr_url, merge_commit_sha: sha, was: marker });
        marker = undefined;
      }
    }
    if (reasons.length && !am.revoked) {
      const reason = `PR #${am.pr_number}: ${reasons.join('; ')}`;
      const fresh = revokeClass(db, reason, meta.pr_url, now);
      revokedNow = revokedNow || fresh;
      db.prepare("UPDATE loop_runs SET metadata = json_set(metadata, '$.auto_merge.revoked', ?) WHERE id = ?").run(reason, run.id);
      events.recordEvent(run.id, 'auto_merge_revoked', 'warning', `Auto-merge class revoked — ${reason}`, { pr_url: meta.pr_url, reasons, newly_revoked: fresh });
      if (fresh) await pushNotice(`Auto-merge for test-only loop PRs REVOKED — ${reason}. Re-enable needs an operator: ${meta.pr_url}`, env);
    }
    // never closed while a required-check confirmation is unresolved (an already revoked PR has nothing left to confirm)
    if (age > SURVIVAL_DAYS * DAY && !(marker && !am.revoked) && (settled === 'SETTLED_SURVIVED' || settled === 'SETTLED_REGRESSED' || age > 30 * DAY)) {
      db.prepare("UPDATE loop_runs SET metadata = json_set(metadata, '$.auto_merge.window_closed', json('true')) WHERE id = ?").run(run.id);
    }
  }
  return revokedNow;
}

/** Every 15 min (first tick 2 min after boot) while LOOP_AUTO_MERGE_TEST_ONLY is shadow or act. */
export function startLoopAutoMerge(db: Database, intervalMs = 15 * 60_000, loops?: Pick<LoopService, 'prepareMakerWorktree'>): (() => void) | null {
  if (autoMergeMode() === 'off') return null;
  const auditKill = loops && auditSampleAutoMode() !== 'off' ? defaultAuditKillExecutor(db, loops) : null;
  let running = false;
  const tick = () => {
    markRun('loop_auto_merge');
    if (running) return; running = true;
    runAutoMergeTick(db, fetch, process.env, new Date(), auditKill).then((r) => { if (r.merged || r.revoked) console.log(`🤝 loop auto-merge: ${r.merged} merged, revoked=${r.revoked} (${r.evaluated} evaluated)`); })
      .catch((e) => console.warn('loop auto-merge failed:', e instanceof Error ? e.message : String(e)))
      .finally(() => { running = false; });
  };
  const first = setTimeout(tick, 120_000); first.unref?.();
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}

/**
 * The executed audit's kill share (AUDIT_SAMPLE_AUTO_MODE): the settlement re-score machinery (one throwaway worktree via
 * WorktreeManager + prepareMakerWorktree, graded-fitness killShare on fresh seeded mutants) at the PR head instead of main.
 * A head that is not in the deploy clone is fetched from origin once; unfetchable is an unknown, never a pass.
 */
// ponytail: the kill runs are spawnSync (≤ GRADED_KILL_BUDGET_MS) inside the 15-min tick; the ceiling is one execution per tick,
// and only audit-sample PRs (10 % of eligible) execute. Upgrade trigger: a cockpit stall alarm during the tick → move to the async runChild.
export function defaultAuditKillExecutor(db: Database, loops: Pick<LoopService, 'prepareMakerWorktree'>, env: NodeJS.ProcessEnv = process.env): AuditKillExecutor {
  const deps = defaultSettlementExecutionDeps(db, loops);
  return (c) => {
    const repo = env.LOOP_DAEMON_REPOSITORY_PATH;
    if (!repo) return { score: null, reason: 'no repository path (LOOP_DAEMON_REPOSITORY_PATH)' };
    const git = (args: string[], timeout: number) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', timeout });
    try { git(['cat-file', '-e', `${c.head_sha}^{commit}`], 60_000); } catch {
      try { git(['fetch', '--no-tags', '--quiet', 'origin', c.head_sha], 180_000); } catch { return { score: null, reason: `head ${c.head_sha.slice(0, 12)} not in the repository and not fetchable` }; }
    }
    const wt = deps.openWorktree(repo, c.head_sha);
    if ('error' in wt) return { score: null, reason: `infra: ${wt.error}`.slice(0, 300) };
    try { return rescoreKillShare(wt.path, { run_id: c.run_id, target: c.target, maker_mutants: c.maker_mutants }, c.test_files, c.head_sha, deps.kill); }
    finally { try { wt.dispose(); } catch { /* best effort */ } }
  };
}
