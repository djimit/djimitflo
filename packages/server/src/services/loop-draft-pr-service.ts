import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { Database } from 'better-sqlite3';
import { LoopEventService } from './loop-event-service';
import { redactSecrets } from './secret-patterns';
import { withoutHiddenChecks } from './fail-before-pass-after';
import { freshnessMode, staleAgainst, type ReadSet } from './evidence-freshness';
import { emptySettlementCounts, parseOutcome, settlementState, type SettlementState } from './merge-survival';
import { extraRepoBySlug, goalRepoSlug, isExtraRepoPr, slugFromRemote } from './repo-registry';
import { guardTick, markRun } from './scheduler-registry';
import { issueRefsLine } from './work-item-outcome-sync';

/**
 * G4: a verified loop run becomes a *draft* PR. Before this, ready_for_human_merge output stayed in a VPS worktree
 * and was harvested by hand (#357, #363). Default off (LOOP_AUTO_DRAFT_PR_ENABLED): it publishes to GitHub.
 * The merge stays human — a draft PR is only the hand-off.
 */
export class LoopDraftPrService {
  constructor(private db: Database, private fetchImpl: typeof fetch = fetch, private env: NodeJS.ProcessEnv = process.env) {}

  async openForRun(runId: string): Promise<string | null> {
    if (this.env.LOOP_AUTO_DRAFT_PR_ENABLED !== 'true') return null;
    const primary = this.env.GITHUB_REPOSITORY; const token = this.env.GITHUB_TOKEN;
    const events = new LoopEventService(this.db);
    const fail = (reason: string) => { events.recordEvent(runId, 'draft_pr_failed', 'warning', `Draft PR not opened: ${reason}`, {}); return null; };
    if (!primary || !token) return fail('GITHUB_REPOSITORY/GITHUB_TOKEN missing');

    const run = this.db.prepare('SELECT id, status, goal_id, metadata FROM loop_runs WHERE id = ?').get(runId) as { id: string; status: string; goal_id: string | null; metadata: string | null } | undefined;
    if (!run || !['ready_for_human_merge', 'completed'].includes(run.status)) return null;
    // B2 (17-10): the PR goes to the repo of the goal's proposal (`repo:<slug>`, else the primary repo) — never blindly to
    // GITHUB_REPOSITORY. A proposal for a repo that is not registered (or the flag is off) gets no PR.
    const meta = JSON.parse(run.metadata || '{}') as { pr_url?: string };
    if (meta.pr_url) return meta.pr_url; // once per run
    const goalSlug = goalRepoSlug(this.db, run.goal_id);
    if (goalSlug && goalSlug.toLowerCase() !== primary.toLowerCase() && !extraRepoBySlug(goalSlug, this.env)) return fail(`repo_not_registered: ${goalSlug}`);
    const repo = goalSlug ?? primary;

    const maker = this.db.prepare(`SELECT id, worktree_path, branch_name FROM worker_leases WHERE loop_run_id = ? AND role = 'maker' AND status = 'completed'
      AND json_extract(metadata, '$.superseded_by_maker_lease_id') IS NULL ORDER BY updated_at DESC LIMIT 1`).get(runId) as { id: string; worktree_path: string | null; branch_name: string | null } | undefined;
    if (!maker?.worktree_path || !maker.branch_name || !fs.existsSync(maker.worktree_path)) return fail('no completed maker worktree');
    const wt = maker.worktree_path;
    const git = (...args: string[]) => execFileSync('git', ['-C', wt, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

    // B2: the worktree's push remote must be that same repo; when they differ nothing is pushed and no PR is opened.
    let remoteSlug: string | null = null;
    try { remoteSlug = slugFromRemote(git('remote', 'get-url', this.env.LOOP_DRAFT_PR_REMOTE || 'origin')); } catch { /* no such remote: the push below fails as before */ }
    if (remoteSlug && remoteSlug.toLowerCase() !== repo.toLowerCase()) return fail(`repo_mismatch: worktree ${remoteSlug} ≠ goal ${repo}`);

    try {
      // PRC-1: a retry after a failed push/POST finds the work already committed on HEAD (this run's loop commit): it
      // republishes that commit and never commits the work a second time.
      let committed = false;
      try { committed = git('log', '-1', '--format=%B').includes(`Loop run ${runId}, maker lease ${maker.id}.`); } catch { /* no commit yet */ }
      // Only the maker's real files: never node_modules symlinks from `npm ci`, never lockfile install noise.
      const tracked = (committed ? git('diff', '--name-only', 'HEAD~1', 'HEAD') : git('diff', '--name-only', '--', '.')).split('\n').filter(Boolean);
      const untracked = committed ? [] : git('ls-files', '--others', '--exclude-standard', '--', '.').split('\n').filter(Boolean);
      const files = [...tracked, ...untracked].filter((f) => !f.split('/').includes('node_modules')
        && !(f.endsWith('package-lock.json') && !tracked.includes(path.join(path.dirname(f), 'package.json').replace(/^\.\//, '')))
        && !fs.lstatSync(path.join(wt, f), { throwIfNoEntry: false })?.isSymbolicLink());
      if (files.length === 0) return fail('no changes in the maker worktree');

      // Batch-8 evidence freshness: did anything the checks READ (not edit) change on main since the base commit?
      const fMode = freshnessMode(this.env);
      if (fMode !== 'off') {
        const leaseMeta = JSON.parse((this.db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(maker.id) as { metadata: string | null } | undefined)?.metadata || '{}') as { evidence_read_set?: ReadSet };
        const rs = leaseMeta.evidence_read_set;
        let changed: string[] | null = null;
        if (rs && Object.keys(rs.files).length > 0) {
          try {
            const fetchAuth = Buffer.from(`x-access-token:${token}`).toString('base64');
            execFileSync('git', ['-C', wt, '-c', `http.extraheader=AUTHORIZATION: basic ${fetchAuth}`, 'fetch', '-q', this.env.LOOP_DRAFT_PR_REMOTE || 'origin', this.env.LOOP_DRAFT_PR_BASE || 'main'], { stdio: 'ignore', timeout: 60_000 });
            changed = staleAgainst(wt, rs, 'FETCH_HEAD');
          } catch { changed = null; } // fetch failed: unknown, fail open
        }
        const state = changed === null ? 'unknown' : changed.length ? 'stale' : 'fresh';
        this.db.prepare(`UPDATE loop_runs SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.evidence_freshness', json(?)) WHERE id = ?`)
          .run(JSON.stringify({ state, mode: fMode, changed: changed ?? [], base: rs?.base ?? null, ...(state === 'stale' && fMode === 'enforce' ? { requeue: true } : {}) }), runId);
        if (state === 'stale') {
          events.recordEvent(runId, fMode === 'enforce' ? 'evidence_stale' : 'evidence_stale_shadow', 'warning',
            `${changed!.length} file(s) the checks read changed on main since ${rs!.base.slice(0, 8)}${fMode === 'enforce' ? ': draft PR not opened, re-check requested' : ' (shadow: opened anyway)'}`, { changed, mode: fMode });
          // ponytail: enforce marks the run for a re-check (metadata requeue) instead of opening; an automatic rebase +
          // re-run is not built — add it when evidence_stale fires more than a few times a week.
          if (fMode === 'enforce') return null;
        }
      }

      // RX-6: arrival throttle. A queue nobody drains censors merge survival (closed-unmerged never fires).
      const mode = this.env.LOOP_DRAFT_PR_THROTTLE_MODE;
      if (mode === 'shadow' || mode === 'enforce') {
        const cap = Math.max(0, Number(this.env.LOOP_DRAFT_PR_MAX_OPEN ?? 5) || 0);
        const open = await this.openLoopDrafts(repo, token);
        if (open !== null && open >= cap) {
          events.recordEvent(runId, mode === 'enforce' ? 'draft_pr_throttled' : 'draft_pr_throttle_shadow', 'info',
            `${open} open loop drafts ≥ cap ${cap}${mode === 'enforce' ? ': draft PR not opened' : ' (shadow: opened anyway)'}`, { open, cap, mode });
          if (mode === 'enforce') return null;
        }
      }

      const proposal = run.goal_id ? this.db.prepare('SELECT si.id, si.title FROM goals g JOIN self_improvements si ON si.id = g.improvement_id WHERE g.id = ?').get(run.goal_id) as { id: string; title: string } | undefined : undefined;
      const title = `loop: ${proposal?.title ?? `run ${runId.slice(0, 8)}`}`.slice(0, 120);
      if (!committed) {
        git('add', '--', ...files);
        execFileSync('git', ['-C', wt, '-c', 'user.name=djimitflo-loop', '-c', 'user.email=loop@djimitflo.invalid', 'commit', '-q', '-m', `${title}\n\nLoop run ${runId}, maker lease ${maker.id}.`], { stdio: 'ignore' });
      }
      // P0-6: the commit of the checked worktree is the verified head; auto-merge only ever merges this sha.
      const verifiedHead = git('rev-parse', 'HEAD');
      // Token only as a one-off header: never written to the remote URL or git config.
      const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
      execFileSync('git', ['-C', wt, '-c', `http.extraheader=AUTHORIZATION: basic ${auth}`, 'push', '-q', this.env.LOOP_DRAFT_PR_REMOTE || 'origin', `HEAD:refs/heads/${maker.branch_name}`], { stdio: 'ignore' });

      const verdicts = (this.db.prepare(`SELECT role, json_extract(metadata, '$.verdict') AS verdict FROM worker_leases WHERE loop_run_id = ? AND role IN ('checker', 'security_checker') AND status = 'completed'`).all(runId) as Array<{ role: string; verdict: string | null }>)
        .map((l) => `- ${l.role}: ${l.verdict ?? 'n/a'}`).join('\n');
      let body = `Opened by the djimitflo loop for run \`${runId}\`${proposal ? ` (proposal \`${proposal.id}\`)` : ''}.\n\nReviewer verdicts:\n${verdicts || '- none recorded'}\n\nFiles: ${files.map((f) => `\`${f}\``).join(', ')}\n\nDraft: a human reviews and merges.`;
      if (this.env.LOOP_PR_BODY_V2 === 'true') { let numstat = ''; try { numstat = git('diff', '--numstat', 'HEAD~1', 'HEAD'); } catch { /* no parent: diff stat omitted */ } body = this.bodyV2(runId, maker.id, body, numstat); }
      body += issueRefsLine(this.db, run.goal_id, this.env); // PRC-3: `Refs owner/repo#N` for a GitHub-issue work item
      // PRC-1: never a second PR for one branch — a retry looks up the PR an earlier attempt may have opened before it
      // POSTs, and a 422 (a PR for this head exists) adopts that PR instead of failing.
      let pr = committed ? await this.existingPr(repo, maker.branch_name, token) : null;
      let adopted = pr !== null;
      if (!pr) {
        const res = await this.fetchImpl(`https://api.github.com/repos/${repo}/pulls`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, head: maker.branch_name, base: this.env.LOOP_DRAFT_PR_BASE || 'main', draft: true, body }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) { const j = (await res.json()) as { html_url?: string; number?: number }; pr = { url: String(j.html_url ?? ''), number: Number(j.number) || null }; }
        else if (res.status === 422) { pr = await this.existingPr(repo, maker.branch_name, token); adopted = pr !== null; }
        if (!pr) return fail(`GitHub ${res.status}`);
      }
      this.db.prepare(`UPDATE loop_runs SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.pr_number', ?, '$.pr_head_branch', ?) WHERE id = ?`)
        .run(pr.number ?? (Number(/\/pull\/(\d+)/.exec(pr.url)?.[1]) || null), maker.branch_name, runId);
      if (adopted) events.recordEvent(runId, 'draft_pr_adopted', 'info', `Existing PR adopted: ${pr.url}`, { pr_url: pr.url });
      const prUrl = pr.url;
      this.db.prepare(`UPDATE loop_runs SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.pr_url', ?, '$.verified_head_sha', ?) WHERE id = ?`).run(prUrl, verifiedHead, runId);
      events.recordEvent(runId, 'draft_pr_opened', 'info', `Draft PR opened: ${prUrl}`, { pr_url: prUrl, files });
      return prUrl;
    } catch (error) {
      return fail(error instanceof Error ? error.message.replace(/basic [A-Za-z0-9+/=]+/g, 'basic ***').slice(0, 200) : String(error));
    }
  }

  /**
   * UX-10: the v1 body plus lane, oracle check results, gate summary, diff stat, mutation score and (only with an https
   * DJIMITFLO_PUBLIC_URL) a link to the run. Public repo: ids, names, statuses and numbers only — never gate evidence,
   * check output, hosts or costs — and the whole body goes through secret redaction.
   */
  private bodyV2(runId: string, makerId: string, v1: string, numstat: string): string {
    const run = this.db.prepare('SELECT loop_name, gates_json FROM loop_runs WHERE id = ?').get(runId) as { loop_name: string; gates_json: string | null } | undefined;
    const maker = this.db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(makerId) as { metadata: string | null } | undefined;
    const parse = <T>(text: string | null | undefined, fallback: T): T => { try { return text ? JSON.parse(text) as T : fallback; } catch { return fallback; } };
    const name = (v: unknown) => String(v ?? '').replace(/[^\w:.-]/g, '').slice(0, 60);
    const gates = parse<Array<{ name?: string; status?: string }>>(run?.gates_json, []);
    const checks = withoutHiddenChecks(parse<{ deterministic_checks?: Array<{ name?: string; status?: string; stdout_path?: string }> }>(maker?.metadata, {}).deterministic_checks ?? []);
    const rows = numstat.split('\n').filter(Boolean).map((l) => l.split('\t'));
    const added = rows.reduce((a, r) => a + (Number(r[0]) || 0), 0); const removed = rows.reduce((a, r) => a + (Number(r[1]) || 0), 0);
    const lines = [`Lane: \`${name(run?.loop_name)}\``];
    if (checks.length) lines.push(`Oracle checks: ${checks.map((c) => `${name(c.name)} ${name(c.status)}`).join(', ')}`);
    if (gates.length) lines.push(`Gates: ${gates.map((g) => `${name(g.name)} ${name(g.status)}`).join(', ')}`);
    lines.push(`Diff: ${rows.length} file${rows.length === 1 ? '' : 's'}, +${added} / -${removed}`);
    const mutation = checks.find((c) => String(c.name ?? '').includes('mutation') && c.stdout_path);
    if (mutation?.stdout_path) {
      try { // numbers only from the mutation report: "score A -> B"
        const m = /(\d+(?:\.\d+)?)\s*(?:->|→)\s*(\d+(?:\.\d+)?)/.exec(fs.readFileSync(mutation.stdout_path, 'utf8').slice(0, 20_000));
        if (m) lines.push(`Mutation score: ${m[1]} → ${m[2]}`);
      } catch { /* report absent: omit the line */ }
    }
    const base = this.env.DJIMITFLO_PUBLIC_URL;
    if (base && /^https:\/\//.test(base)) lines.push(`Run: ${base.replace(/\/+$/, '')}/goals-loops?run=${encodeURIComponent(runId)}`);
    return redactSecrets(`${v1}\n\n${lines.join('\n')}`).redacted;
  }

  /** PRC-1: the newest PR (any state) whose head is `branch` in `repo`; null when none or unreadable. */
  private async existingPr(repo: string, branch: string, token: string): Promise<{ url: string; number: number | null } | null> {
    try {
      const head = encodeURIComponent(`${repo.split('/')[0]}:${branch}`);
      const res = await this.fetchImpl(`https://api.github.com/repos/${repo}/pulls?head=${head}&state=all&per_page=1`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const pulls = (await res.json()) as Array<{ html_url?: string; number?: number }>;
      const found = Array.isArray(pulls) ? pulls.find((p) => typeof p.html_url === 'string' && p.html_url) : undefined;
      return found ? { url: String(found.html_url), number: Number(found.number) || null } : null;
    } catch { return null; }
  }

  /** Open PRs titled 'loop:' (one list call, first 100). null on any error: the throttle fails open. */
  private async openLoopDrafts(repo: string, token: string): Promise<number | null> {
    try {
      const res = await this.fetchImpl(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const pulls = (await res.json()) as Array<{ title?: string }>;
      return Array.isArray(pulls) ? pulls.filter((p) => String(p.title ?? '').startsWith('loop:')).length : null;
    } catch { return null; }
  }
}

/**
 * PRC-1 retry sweep. LOOP_DRAFT_PR_RETRY: off (default) | shadow (records `draft_pr_retry_shadow`, calls nothing) | on;
 * needs LOOP_AUTO_DRAFT_PR_ENABLED. A certified run (completed / ready_for_human_merge, the statuses openForRun accepts)
 * created in the last 14 days, without pr_url, whose draft PR failed 1–2 times (`draft_pr_failed`) gets openForRun again —
 * at most 5 per tick, so the 3rd failure ends it. A run never attempted (0 failures) or held on purpose (throttle,
 * stale evidence: no failure event) is never touched. openForRun adopts a PR an earlier attempt opened (no duplicate).
 */
export type DraftPrRetryMode = 'off' | 'shadow' | 'on';
export function draftPrRetryMode(env: NodeJS.ProcessEnv = process.env): DraftPrRetryMode {
  const v = env.LOOP_DRAFT_PR_RETRY; return v === 'shadow' || v === 'on' ? v : 'off';
}
export const DRAFT_PR_MAX_FAILURES = 3;

export async function retryFailedDraftPrs(db: Database, fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<{ retried: number; opened: number }> {
  const mode = draftPrRetryMode(env);
  if (mode === 'off' || env.LOOP_AUTO_DRAFT_PR_ENABLED !== 'true') return { retried: 0, opened: 0 };
  const rows = db.prepare(`SELECT r.id, COUNT(e.id) AS failures FROM loop_runs r
      JOIN loop_events e ON e.loop_run_id = r.id AND e.event_type = 'draft_pr_failed'
    WHERE r.status IN ('completed', 'ready_for_human_merge') AND r.created_at >= ?
      AND json_extract(COALESCE(NULLIF(r.metadata, ''), '{}'), '$.pr_url') IS NULL
    GROUP BY r.id HAVING failures < ? ORDER BY MAX(e.created_at) LIMIT 5`)
    .all(new Date(now - 14 * 86_400_000).toISOString(), DRAFT_PR_MAX_FAILURES) as Array<{ id: string; failures: number }>;
  const events = new LoopEventService(db);
  if (mode === 'shadow') {
    for (const r of rows) events.recordEvent(r.id, 'draft_pr_retry_shadow', 'info', `would retry the draft PR (${r.failures} failed attempt(s))`, { failures: r.failures });
    return { retried: 0, opened: 0 };
  }
  const svc = new LoopDraftPrService(db, fetchImpl, env);
  let opened = 0;
  for (const r of rows) if (await svc.openForRun(r.id)) opened++;
  return { retried: rows.length, opened };
}

/** Scheduler `draft_pr_retry` (every 15 min) while LOOP_DRAFT_PR_RETRY is not off; null when off. */
export function startDraftPrRetry(db: Database, intervalMs = 15 * 60_000): (() => void) | null {
  if (draftPrRetryMode() === 'off') return null;
  const tick = guardTick('draft_pr_retry', async () => { await retryFailedDraftPrs(db); markRun('draft_pr_retry'); });
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => clearInterval(timer);
}

export interface DraftPrRow { run_id: string; lane: string; pr_url: string; pr_number: number | null; age_days: number; outcome: string | null; survived: boolean | null; auto_merge: string | null;
  /** E1: evolutionary settlement state (merge-survival settlementState) — `outcome` stays the GitHub poll state */
  settlement: SettlementState; settlement_reason: string; settlement_terminal: boolean; settlement_age_days: number | null }
/**
 * UX-7: the loop's draft PRs, read from loop_runs.metadata (no GitHub call). `outcome` is the GitHub state merge survival
 * last polled (open / merged / closed_unmerged); `settlement` is the evolutionary settlement state derived from it (E1).
 * unsettled = PRs that still wait for anything: not SETTLED_SURVIVED / SETTLED_REGRESSED and not a terminal (closed-unmerged)
 * OPEN_BLOCKED — open, merged and inside the survival window, or a pipeline anomaly. by_settlement counts every state.
 */
/** Cockpit 3.0: a failed read gives total/unsettled/by_settlement null (unknown), not 0. */
export function listDraftPrs(db: Database, limit = 50, now = Date.now(), env: NodeJS.ProcessEnv = process.env): { total: number | null; unsettled: number | null; by_settlement: Record<SettlementState, number> | null; closed_unmerged: number | null; rows: DraftPrRow[] } {
  const n = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 50));
  let raw: Array<{ id: string; loop_name: string; url: string; created_at: string; o: string | null; auto_merge: string | null }> = [];
  let failed = false;
  try {
    raw = db.prepare(`SELECT id, loop_name, json_extract(metadata, '$.pr_url') AS url, created_at, json_extract(metadata, '$.pr_outcome') AS o,
        json_extract(metadata, '$.auto_merge.decision') AS auto_merge
      FROM loop_runs WHERE json_extract(metadata, '$.pr_url') IS NOT NULL ORDER BY created_at DESC`).all() as typeof raw;
  } catch { failed = true; /* fail-soft on a partial schema: rows empty, counts unknown */ }
  // repo dimension: the default view leaves out PRs of registered extra repos (EXTRA_REPOS_ENABLED), see merge-survival
  const all = raw.filter((r) => !isExtraRepoPr(r.url, env)).map((r) => {
    const o = parseOutcome(r.o);
    return { r, o, s: settlementState(r.created_at, o, now) };
  });
  const rows = all.slice(0, n).map(({ r, o, s }) => ({
    run_id: r.id, lane: r.loop_name, pr_url: r.url, pr_number: Number(/\/pull\/(\d+)/.exec(r.url)?.[1]) || null,
    age_days: +((now - Date.parse(r.created_at)) / 86_400_000).toFixed(1), outcome: typeof o?.state === 'string' ? o.state : null,
    survived: typeof o?.survived === 'boolean' ? o.survived : null,
    auto_merge: r.auto_merge ?? null, // earned auto-merge decision ('audit_sample' = stays for the human)
    settlement: s.state, settlement_reason: s.reason, settlement_terminal: s.terminal, settlement_age_days: s.age_days,
  }));
  const by = emptySettlementCounts();
  for (const { s } of all) by[s.state]++;
  const closed = all.filter(({ s }) => s.terminal).length;
  const unsettled = all.filter(({ s }) => !s.terminal && s.state !== 'SETTLED_SURVIVED' && s.state !== 'SETTLED_REGRESSED').length;
  return failed ? { total: null, unsettled: null, by_settlement: null, closed_unmerged: null, rows } : { total: all.length, unsettled, by_settlement: by, closed_unmerged: closed, rows };
}

/**
 * Needs-you: loop draft PRs still open, as merge survival last saw them on GitHub (no outcome yet = open). Merged PRs
 * that are still settling are not open — they no longer wait for the operator.
 */
export function countOpenLoopPrs(db: Database): number | null {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.pr_url') IS NOT NULL
      AND COALESCE(json_extract(metadata, '$.pr_outcome.state'), 'open') = 'open'`).get() as { n: number }).n;
  } catch { return null; } // unknown, not 'nothing open'
}
