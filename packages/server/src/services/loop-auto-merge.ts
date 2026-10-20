import type { Database } from 'better-sqlite3';
import { AuditEventType, RiskLevel } from '@djimitflo/shared';
import { AuditService } from './audit-service';
import { LoopEventService } from './loop-event-service';
import { testOnlyChange, TEST_ONLY_DIFF_MAX } from './loop-worker-executor-service';
import { pushNotice } from './operator-push';
import { settlementState, SURVIVAL_DAYS, type SettlementOutcome } from './merge-survival';
import { autoMergeMaxPerDay, autoMergeMode, isAuditSample, readClassState, revokeClass } from './loop-auto-merge-state';
import { markRun } from './scheduler-registry';
import { assertionStrengthVerdict } from './test-assertion-strength';
import { autoMergeAllowed, parsePrUrl } from './repo-registry';

/**
 * Earned auto-merge for verified test-only loop PRs (operator-approved 2026-10-07: 30 loop PRs, 22 merged by the human,
 * 0 rejected, median 48 h wait). LOOP_AUTO_MERGE_TEST_ONLY: off (default) | shadow (records what it would do) | act.
 *
 * Eligible: a loop draft PR (loop_runs.metadata.pr_url, title 'loop:', head = the maker branch in this repo, never a
 * Dependabot PR) of a run whose proposal is 'verified' with no failed gate; every changed file is a test file
 * (testOnlyChange) and none is deleted; additions + deletions within the maker's lane limit; no outstanding
 * CHANGES_REQUESTED review; the maker's test:assertion-strength verdict is 'pass' (shadow or enforce — skipped, missing or
 * failed is ineligible: F1 09-10, the checker accepted toBeDefined-only tests). A deterministic 10 % (hash of the PR number) stays for the human as an audit sample.
 * Act: mark ready → update the branch when behind (branch protection wants up to date) → wait for every check on the head
 * to be green → squash-merge with the token the draft-PR service uses. Every step is one tick (15 min); nothing blocks.
 * Shadow re-evaluates its would_merge PRs every tick, incl. the merge-conflict check act runs (10-10: #658 went conflicting
 * and stayed 'would_merge'); a decision is rewritten only when it changes.
 * Head binding (P0-6): only the commit the loop verified is merged. The draft-PR service records it as
 * metadata.verified_head_sha when it commits the checked worktree; a run without it is ineligible ('no_verified_head'). The PR
 * head must equal it, or be GitHub's own update-branch merge on top of it (web-flow, signature verified, first parent = the
 * verified head, at most 5 deep); anything else is 'head_moved'. The merge call passes that head as `sha`, so a push between
 * this read and the merge is rejected by GitHub.
 * Cap: LOOP_AUTO_MERGE_MAX_PER_DAY (default 10, rolling 24 h).
 * Revert window: an auto-merged PR that is reverted on main (a commit within 14 d whose message says revert and names the
 * PR or its merge commit), whose added lines merge survival marks removed, or whose merge commit's checks fail on main
 * revokes the class (system_state). It then stops acting (decisions become 'revoked_hold') until an operator re-enables it.
 */
type Decision = 'merged' | 'would_merge' | 'audit_sample' | 'ineligible' | 'waiting' | 'capped' | 'revoked_hold';
export interface AutoMergeRecord {
  mode: 'shadow' | 'act'; decision: Decision; reason: string; at: string; pr_number: number;
  steps?: string[]; merge_commit_sha?: string; merged_at?: string; window_closed?: boolean; revoked?: string;
}
interface Pr {
  number: number; state: string; draft?: boolean; title?: string; node_id?: string; mergeable?: boolean | null; mergeable_state?: string;
  user?: { login?: string }; head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null }; base?: { ref?: string };
}
type Checks = 'green' | 'pending' | 'red';
const DAY = 86_400_000;
const RED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);

export async function runAutoMergeTick(db: Database, fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env, now = new Date()):
  Promise<{ evaluated: number; merged: number; revoked: boolean }> {
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
  const checks = async (slug: string, sha: string): Promise<Checks> => {
    const runs = (await json<{ check_runs?: Array<{ status?: string; conclusion?: string | null }> }>(slug, `commits/${sha}/check-runs?per_page=100`))?.check_runs;
    const status = await json<{ state?: string; total_count?: number }>(slug, `commits/${sha}/status`);
    if (!runs) return 'pending';
    if (runs.some((c) => c.status === 'completed' && RED.has(String(c.conclusion))) || status?.state === 'failure' || status?.state === 'error') return 'red';
    if (runs.some((c) => c.status !== 'completed' || c.conclusion === 'cancelled' || c.conclusion === 'stale') || (status?.total_count && status.state === 'pending')) return 'pending';
    return runs.length || status?.total_count ? 'green' : 'pending'; // no check reported yet = not green
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

  // 1. Revert window over earlier auto-merges (act only produces them; shadow has nothing to revoke).
  const revoked = await checkRevocations(db, json, checks, events, base, now, env);

  // 2. Candidates: loop PRs without a final decision for this mode.
  const runs = db.prepare(`SELECT r.id, r.status, r.gates_json, r.metadata, s.status AS improvement_status FROM loop_runs r
      LEFT JOIN goals g ON g.id = r.goal_id LEFT JOIN self_improvements s ON s.id = g.improvement_id
    WHERE json_extract(r.metadata, '$.pr_url') IS NOT NULL AND r.created_at >= ? ORDER BY r.created_at`)
    .all(new Date(now.getTime() - 60 * DAY).toISOString()) as Array<{ id: string; status: string; gates_json: string | null; metadata: string; improvement_status: string | null }>;
  const cap = autoMergeMaxPerDay(env);
  let evaluated = 0; let merged = 0;
  for (const run of runs) {
    const meta = JSON.parse(run.metadata || '{}') as { pr_url: string; auto_merge?: AutoMergeRecord; verified_head_sha?: string };
    const prev = meta.auto_merge;
    if (prev && ['merged', 'audit_sample', 'ineligible'].includes(prev.decision)) continue;
    const ref = parsePrUrl(meta.pr_url);
    if (!ref) continue;
    const { slug, number } = ref;
    evaluated++;
    const record = (decision: Decision, reason: string, extra: Partial<AutoMergeRecord> = {}): AutoMergeRecord => {
      // unchanged decision (shadow re-checks every tick): keep the first record, so `at` stays when it was first decided
      if (prev && prev.mode === mode && prev.decision === decision && prev.reason === reason) return prev;
      const rec: AutoMergeRecord = { mode, decision, reason, at: now.toISOString(), pr_number: number, ...extra };
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
    const maker = db.prepare(`SELECT branch_name, json_extract(metadata, '$.diff_max_lines') AS diff_max, json_extract(metadata, '$.deterministic_checks') AS checks FROM worker_leases WHERE loop_run_id = ? AND role = 'maker'
      AND status = 'completed' AND json_extract(metadata, '$.superseded_by_maker_lease_id') IS NULL ORDER BY updated_at DESC LIMIT 1`).get(run.id) as { branch_name: string | null; diff_max: number | null; checks: string | null } | undefined;
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
    const removed = files.find((f) => f.status === 'removed');
    if (removed) { record('ineligible', `removes_test: ${removed.filename}`); continue; }
    const diff = files.reduce((a, f) => a + (Number(f.additions) || 0) + (Number(f.deletions) || 0), 0);
    const limit = Number(maker.diff_max) > 0 ? Number(maker.diff_max) : TEST_ONLY_DIFF_MAX;
    if (diff > limit) { record('ineligible', `diff_over_limit: ${diff} > ${limit}`); continue; }
    const strength = assertionStrengthVerdict((() => { try { return JSON.parse(maker.checks || '[]'); } catch { return []; } })());
    if (strength !== 'pass') { record('ineligible', `assertion_strength_${strength ?? 'missing'}`); continue; }
    const reviews = await json<Array<{ user?: { login?: string }; state?: string }>>(slug, `pulls/${number}/reviews?per_page=100`);
    if (!reviews) { record('waiting', 'reviews_unavailable'); continue; }
    const latest = new Map<string, string>();
    for (const r of reviews) if (r.state && r.state !== 'COMMENTED' && r.state !== 'PENDING') latest.set(String(r.user?.login), r.state);
    if ([...latest.values()].includes('CHANGES_REQUESTED')) { record('ineligible', 'changes_requested'); continue; }
    if (isAuditSample(number)) { record('audit_sample', 'deterministic 10 % sample: stays for the human'); continue; }

    const effective = mode === 'act' && readClassState(db).state === 'revoked' ? 'held' : mode;
    if (effective === 'held') { record('revoked_hold', `class revoked: ${readClassState(db).reason ?? 'unknown'}`); continue; }
    // a PR already counted as would_merge / merged in this window does not count against its own re-check
    const counted = prev?.mode === mode && prev.decision === (mode === 'act' ? 'merged' : 'would_merge') && Date.parse(prev.at) >= now.getTime() - DAY ? 1 : 0;
    const today = (db.prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.auto_merge.decision') = ? AND json_extract(metadata, '$.auto_merge.at') >= ?`)
      .get(mode === 'act' ? 'merged' : 'would_merge', new Date(now.getTime() - DAY).toISOString()) as { n: number }).n;
    if (today - counted >= cap) { record('capped', `${today} ${mode === 'act' ? 'merged' : 'would merge'} in 24 h ≥ cap ${cap}`); continue; }
    const state = await checks(slug, sha);
    if (state === 'red') { record('ineligible', 'checks_failed'); continue; }
    if (pr.mergeable === false || pr.mergeable_state === 'dirty') { record('ineligible', 'merge_conflict'); continue; }

    if (mode === 'shadow') {
      const steps = [pr.draft ? 'mark_ready' : null, pr.mergeable_state === 'behind' ? 'update_branch' : null, state === 'pending' ? 'wait_for_checks' : null, 'squash_merge'].filter((s): s is string => !!s);
      record('would_merge', `eligible test-only loop PR (${files.length} file(s), ${diff} line(s))`, { steps });
      continue;
    }
    // act — one step per tick
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
  return { evaluated, merged, revoked };
}

/** The revert window: true when this tick revoked the class. Closes a PR's window after 14 d once merge survival settled it (or 30 d). */
async function checkRevocations(db: Database, json: <T>(slug: string, p: string) => Promise<T | null>, checks: (slug: string, sha: string) => Promise<Checks>,
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
    if (age <= SURVIVAL_DAYS * DAY) {
      const commits = await json<Array<{ sha?: string; commit?: { message?: string } }>>(slug, `commits?sha=${encodeURIComponent(base)}&since=${encodeURIComponent(new Date(mergedAt).toISOString())}&per_page=100`);
      const ref = new RegExp(`#${am.pr_number}\\b`);
      const sha = am.merge_commit_sha ?? '';
      const revert = (commits ?? []).find((c) => c.sha !== sha && /revert/i.test(c.commit?.message ?? '')
        && (ref.test(c.commit?.message ?? '') || (sha.length >= 7 && (c.commit?.message ?? '').includes(sha.slice(0, 7)))));
      if (revert) reasons.push(`reverted on ${base} by ${String(revert.sha).slice(0, 8)}`);
      if (sha && await checks(slug, sha) === 'red') reasons.push(`checks failing on ${base} at merge commit ${sha.slice(0, 8)}`);
    }
    if (reasons.length && !am.revoked) {
      const reason = `PR #${am.pr_number}: ${reasons.join('; ')}`;
      const fresh = revokeClass(db, reason, meta.pr_url, now);
      revokedNow = revokedNow || fresh;
      db.prepare("UPDATE loop_runs SET metadata = json_set(metadata, '$.auto_merge.revoked', ?) WHERE id = ?").run(reason, run.id);
      events.recordEvent(run.id, 'auto_merge_revoked', 'warning', `Auto-merge class revoked — ${reason}`, { pr_url: meta.pr_url, reasons, newly_revoked: fresh });
      if (fresh) await pushNotice(`Auto-merge for test-only loop PRs REVOKED — ${reason}. Re-enable needs an operator: ${meta.pr_url}`, env);
    }
    if (age > SURVIVAL_DAYS * DAY && (settled === 'SETTLED_SURVIVED' || settled === 'SETTLED_REGRESSED' || age > 30 * DAY)) {
      db.prepare("UPDATE loop_runs SET metadata = json_set(metadata, '$.auto_merge.window_closed', json('true')) WHERE id = ?").run(run.id);
    }
  }
  return revokedNow;
}

/** Every 15 min (first tick 2 min after boot) while LOOP_AUTO_MERGE_TEST_ONLY is shadow or act. */
export function startLoopAutoMerge(db: Database, intervalMs = 15 * 60_000): (() => void) | null {
  if (autoMergeMode() === 'off') return null;
  let running = false;
  const tick = () => {
    markRun('loop_auto_merge');
    if (running) return; running = true;
    runAutoMergeTick(db).then((r) => { if (r.merged || r.revoked) console.log(`🤝 loop auto-merge: ${r.merged} merged, revoked=${r.revoked} (${r.evaluated} evaluated)`); })
      .catch((e) => console.warn('loop auto-merge failed:', e instanceof Error ? e.message : String(e)))
      .finally(() => { running = false; });
  };
  const first = setTimeout(tick, 120_000); first.unref?.();
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
