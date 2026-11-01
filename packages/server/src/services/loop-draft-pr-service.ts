import fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { execFileSync } from 'child_process';
import type { Database } from 'better-sqlite3';
import { LoopEventService } from './loop-event-service';
import { redactSecrets } from './secret-patterns';
import { withoutHiddenChecks } from './fail-before-pass-after';
import { freshnessMode, staleAgainst, type ReadSet } from './evidence-freshness';
import { emptySettlementCounts, parseOutcome, settlementState, type SettlementState } from './merge-survival';
import { extraRepoBySlug, goalRepoSlug, isExtraRepoPr, slugFromRemote } from './repo-registry';
import { onDraftPrOpened } from './capability-factory';

interface DraftPublication {
  makerId: string; repo: string; branch: string; base: string; worktree: string;
  parentHead: string; head?: string; files: string[]; digest: string;
  owner: string; leaseUntil: number; phase: 'prepared' | 'committed' | 'submitting';
}

type PublishedDraft = { html_url: string; draft: boolean; state: string; body: string; head: { ref: string; sha: string; repo: { full_name: string } }; base: { ref: string; repo: { full_name: string } } };

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
    const meta = JSON.parse(run.metadata || '{}') as { pr_url?: string; draft_publication?: DraftPublication };
    if (meta.pr_url) return meta.pr_url; // once per run
    const goalSlug = goalRepoSlug(this.db, run.goal_id);
    if (goalSlug && goalSlug.toLowerCase() !== primary.toLowerCase() && !extraRepoBySlug(goalSlug, this.env)) return fail(`repo_not_registered: ${goalSlug}`);
    const repo = goalSlug ?? primary;

    const maker = this.db.prepare(`SELECT id, worktree_path, branch_name FROM worker_leases WHERE loop_run_id = ? AND role = 'maker' AND status = 'completed'
      AND json_extract(metadata, '$.superseded_by_maker_lease_id') IS NULL ORDER BY updated_at DESC LIMIT 1`).get(runId) as { id: string; worktree_path: string | null; branch_name: string | null } | undefined;
    if (!maker?.worktree_path || !maker.branch_name || !fs.existsSync(maker.worktree_path)) return fail('no completed maker worktree');
    const wt = maker.worktree_path;
    const git = (...args: string[]) => execFileSync('git', ['-C', wt, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();

    // B2: the worktree's push remote must be that same repo; when they differ nothing is pushed and no PR is opened.
    let remoteSlug: string | null = null;
    try { remoteSlug = slugFromRemote(git('remote', 'get-url', this.env.LOOP_DRAFT_PR_REMOTE || 'origin')); } catch { /* no such remote: the push below fails as before */ }
    if (remoteSlug && remoteSlug.toLowerCase() !== repo.toLowerCase()) return fail(`repo_mismatch: worktree ${remoteSlug} ≠ goal ${repo}`);

    let publication: DraftPublication | undefined;
    const owner = randomUUID();
    try {
      // Only the maker's real files: never node_modules symlinks from `npm ci`, never lockfile install noise.
      const tracked = git('diff', '--name-only', '--', '.').split('\n').filter(Boolean);
      const untracked = git('ls-files', '--others', '--exclude-standard', '--', '.').split('\n').filter(Boolean);
      const discoveredFiles = [...tracked, ...untracked].filter((f) => !f.split('/').includes('node_modules')
        && !(f.endsWith('package-lock.json') && !tracked.includes(path.join(path.dirname(f), 'package.json').replace(/^\.\//, '')))
        && !fs.lstatSync(path.join(wt, f), { throwIfNoEntry: false })?.isSymbolicLink());
      const files = meta.draft_publication?.files ?? discoveredFiles;
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
      let publicationThrottled = false;
      const mode = this.env.LOOP_DRAFT_PR_THROTTLE_MODE;
      if (mode === 'shadow' || mode === 'enforce') {
        const cap = Math.max(0, Number(this.env.LOOP_DRAFT_PR_MAX_OPEN ?? 5) || 0);
        const open = await this.openLoopDrafts(repo, token);
        if (open !== null && open >= cap) {
          events.recordEvent(runId, mode === 'enforce' ? 'draft_pr_throttled' : 'draft_pr_throttle_shadow', 'info',
            `${open} open loop drafts ≥ cap ${cap}${mode === 'enforce' ? ': draft PR not opened' : ' (shadow: opened anyway)'}`, { open, cap, mode });
          if (mode === 'enforce') {
            if (!meta.draft_publication) return null;
            publicationThrottled = true; // An already-created draft may be the item that fills the cap.
          }
        }
      }

      const proposal = run.goal_id ? this.db.prepare('SELECT si.id, si.title FROM goals g JOIN self_improvements si ON si.id = g.improvement_id WHERE g.id = ?').get(run.goal_id) as { id: string; title: string } | undefined : undefined;
      const title = `loop: ${proposal?.title ?? `run ${runId.slice(0, 8)}`}`.slice(0, 120);
      // Claim a persisted checkpoint before committing or publishing. A second process cannot own it concurrently.
      const base = this.env.LOOP_DRAFT_PR_BASE || 'main';
      const current = () => this.publicationAuthorized(runId, maker.id, wt, maker.branch_name!, repo, primary);
      publication = this.db.transaction(() => {
        if (!current()) throw new Error('publication_authority_changed');
        const latest = JSON.parse((this.db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(runId) as { metadata: string }).metadata || '{}');
        if (latest.pr_url) throw new Error('publication_already_completed');
        const previous = latest.draft_publication as DraftPublication | undefined;
        if (previous && (previous.makerId !== maker.id || previous.repo !== repo || previous.branch !== maker.branch_name
          || previous.base !== base || previous.worktree !== wt)) throw new Error('publication_checkpoint_scope_changed');
        if (previous && previous.leaseUntil > Date.now()) throw new Error('publication_owned');
        const checkpoint: DraftPublication = previous ?? {
          makerId: maker.id, repo, branch: maker.branch_name!, base, worktree: wt,
          parentHead: git('rev-parse', 'HEAD'), files, digest: this.publicationDigest(wt, files), phase: 'prepared', owner, leaseUntil: 0,
        };
        checkpoint.owner = owner; checkpoint.leaseUntil = Date.now() + 300_000;
        this.writePublication(runId, checkpoint, true);
        return checkpoint;
      }).immediate();
      const guard = () => {
        if (!current()) throw new Error('publication_authority_changed');
        const checkpoint = JSON.parse((this.db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(runId) as { metadata: string }).metadata || '{}').draft_publication as DraftPublication | undefined;
        if (checkpoint?.owner !== owner || checkpoint.leaseUntil <= Date.now()) throw new Error('publication_lease_lost');
        if (this.publicationDigest(wt, publication!.files) !== publication!.digest) throw new Error('publication_artifact_changed');
      };
      guard();
      const commitMessage = `${title}\n\nLoop run ${runId}, maker lease ${maker.id}.`;
      const head = git('rev-parse', 'HEAD');
      if (!publication.head) {
        if (head === publication.parentHead) {
          git('add', '--', ...publication.files);
          execFileSync('git', ['-C', wt, '-c', 'user.name=djimitflo-loop', '-c', 'user.email=loop@djimitflo.invalid', 'commit', '-q', '-m', commitMessage, '--only', '--', ...publication.files], { stdio: 'ignore', timeout: 60_000 });
        } else if (git('rev-parse', 'HEAD^') !== publication.parentHead || git('log', '-1', '--format=%B') !== commitMessage) {
          throw new Error('publication_head_changed');
        }
        guard();
        publication.head = git('rev-parse', 'HEAD'); publication.phase = 'committed';
        this.writePublication(runId, publication);
      } else if (head !== publication.head) throw new Error('publication_head_changed');
      const verifiedHead = publication.head;
      const committedFiles = git('diff-tree', '--no-commit-id', '--name-only', '-r', verifiedHead).split('\n').filter(Boolean).sort();
      if (JSON.stringify(committedFiles) !== JSON.stringify([...publication.files].sort())
        || git('diff', 'HEAD', '--', ...publication.files)) throw new Error('publication_commit_artifact_mismatch');
      // A retry reconciles the previous external effect before attempting another POST.
      if (meta.draft_publication) {
        const reconciled = await this.reconcilePublication(publication, runId, token);
        guard();
        if (reconciled) {
          this.completePublication(runId, publication, reconciled, events);
          return reconciled;
        }
      }
      if (publicationThrottled) return null;
      guard();
      const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
      const remoteHead = execFileSync('git', ['-C', wt, '-c', `http.extraheader=AUTHORIZATION: basic ${auth}`, 'ls-remote', '--heads', this.env.LOOP_DRAFT_PR_REMOTE || 'origin', `refs/heads/${maker.branch_name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 }).trim().split(/\s+/)[0];
      if (remoteHead && remoteHead !== verifiedHead) throw new Error('publication_remote_head_changed');
      guard();
      execFileSync('git', ['-C', wt, '-c', `http.extraheader=AUTHORIZATION: basic ${auth}`, 'push', '-q', this.env.LOOP_DRAFT_PR_REMOTE || 'origin', `${verifiedHead}:refs/heads/${maker.branch_name}`], { stdio: 'ignore', timeout: 60_000 });

      const verdicts = (this.db.prepare(`SELECT role, json_extract(metadata, '$.verdict') AS verdict FROM worker_leases WHERE loop_run_id = ? AND role IN ('checker', 'security_checker') AND status = 'completed'`).all(runId) as Array<{ role: string; verdict: string | null }>)
        .map((l) => `- ${l.role}: ${l.verdict ?? 'n/a'}`).join('\n');
      let body = `Opened by the djimitflo loop for run \`${runId}\`${proposal ? ` (proposal \`${proposal.id}\`)` : ''}.\n\nReviewer verdicts:\n${verdicts || '- none recorded'}\n\nFiles: ${files.map((f) => `\`${f}\``).join(', ')}\n\nDraft: a human reviews and merges.`;
      if (this.env.LOOP_PR_BODY_V2 === 'true') { let numstat = ''; try { numstat = git('diff', '--numstat', 'HEAD~1', 'HEAD'); } catch { /* no parent: diff stat omitted */ } body = this.bodyV2(runId, maker.id, body, numstat); }
      guard();
      publication.phase = 'submitting'; this.writePublication(runId, publication);
      const res = await this.fetchImpl(`https://api.github.com/repos/${repo}/pulls`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, head: maker.branch_name, base: this.env.LOOP_DRAFT_PR_BASE || 'main', draft: true, body }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return fail(`GitHub ${res.status}`);
      const prUrl = this.validatePublishedDraft(await res.json() as PublishedDraft, publication, runId);
      guard();
      this.completePublication(runId, publication, prUrl, events);
      return prUrl;
    } catch (error) {
      return fail(error instanceof Error ? error.message.replace(/basic [A-Za-z0-9+/=]+/g, 'basic ***').slice(0, 200) : String(error));
    } finally {
      if (publication) this.db.prepare(`UPDATE loop_runs SET metadata = json_set(metadata, '$.draft_publication.leaseUntil', 0)
        WHERE id = ? AND json_extract(metadata, '$.draft_publication.owner') = ?`).run(runId, owner);
    }
  }

  private publicationDigest(worktree: string, files: string[]): string {
    const hash = createHash('sha256');
    for (const file of [...files].sort()) {
      const full = path.resolve(worktree, file);
      if (!full.startsWith(path.resolve(worktree) + path.sep)) throw new Error('publication_path_outside_worktree');
      const stat = fs.lstatSync(full, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink() || stat?.isDirectory()) throw new Error('publication_invalid_file');
      hash.update(JSON.stringify([file, stat?.mode ?? null]));
      hash.update(stat ? fs.readFileSync(full) : '<deleted>');
    }
    return hash.digest('hex');
  }

  private publicationAuthorized(runId: string, makerId: string, worktree: string, branch: string, repo: string, primary: string): boolean {
    const run = this.db.prepare('SELECT status, goal_id, metadata FROM loop_runs WHERE id = ?').get(runId) as { status: string; goal_id: string | null; metadata: string } | undefined;
    if (!run || !['ready_for_human_merge', 'completed'].includes(run.status) || JSON.parse(run.metadata || '{}').operator_paused) return false;
    const goal = run.goal_id ? this.db.prepare('SELECT status, metadata FROM goals WHERE id = ?').get(run.goal_id) as { status: string; metadata: string } | undefined : undefined;
    if (goal && (['cancelled', 'archived'].includes(goal.status) || JSON.parse(goal.metadata || '{}').operator_paused)) return false;
    if ((goalRepoSlug(this.db, run.goal_id) ?? primary) !== repo) return false;
    const lease = this.db.prepare(`SELECT id, worktree_path, branch_name FROM worker_leases WHERE loop_run_id = ? AND role = 'maker'
      AND status = 'completed' AND json_extract(metadata, '$.superseded_by_maker_lease_id') IS NULL ORDER BY updated_at DESC LIMIT 1`)
      .get(runId) as { id: string; worktree_path: string; branch_name: string } | undefined;
    return lease?.id === makerId && lease.worktree_path === worktree && lease.branch_name === branch;
  }

  private writePublication(runId: string, checkpoint: DraftPublication, acquiring = false): void {
    const result = this.db.prepare(`UPDATE loop_runs SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.draft_publication', json(?))
      WHERE id = ? AND (? OR (json_extract(metadata, '$.draft_publication.owner') = ?
        AND json_extract(metadata, '$.draft_publication.leaseUntil') > ?))`)
      .run(JSON.stringify(checkpoint), runId, acquiring ? 1 : 0, checkpoint.owner, Date.now());
    if (result.changes !== 1) throw new Error('publication_lease_lost');
  }

  private completePublication(runId: string, checkpoint: DraftPublication, prUrl: string, events: LoopEventService): void {
    this.db.transaction(() => {
      if (!this.publicationAuthorized(runId, checkpoint.makerId, checkpoint.worktree, checkpoint.branch, checkpoint.repo, this.env.GITHUB_REPOSITORY!)) {
        throw new Error('publication_authority_changed');
      }
      const result = this.db.prepare(`UPDATE loop_runs SET metadata = json_set(metadata, '$.pr_url', ?, '$.verified_head_sha', ?)
        WHERE id = ? AND json_extract(metadata, '$.draft_publication.owner') = ?
        AND json_extract(metadata, '$.draft_publication.leaseUntil') > ?`)
        .run(prUrl, checkpoint.head!, runId, checkpoint.owner, Date.now());
      if (result.changes !== 1) throw new Error('publication_lease_lost');
      events.recordEvent(runId, 'draft_pr_opened', 'info', `Draft PR opened: ${prUrl}`, { pr_url: prUrl, files: checkpoint.files });
    }).immediate();
    onDraftPrOpened(this.db, runId, prUrl, this.env);
  }

  private async reconcilePublication(checkpoint: DraftPublication, runId: string, token: string): Promise<string | null> {
    const query = new URLSearchParams({ state: 'all', head: `${checkpoint.repo.split('/')[0]}:${checkpoint.branch}`, base: checkpoint.base, per_page: '100' });
    const response = await this.fetchImpl(`https://api.github.com/repos/${checkpoint.repo}/pulls?${query}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`publication_reconciliation_failed: ${response.status}`);
    const rows = await response.json() as PublishedDraft[];
    if (!Array.isArray(rows) || rows.length > 1) throw new Error('publication_reconciliation_ambiguous');
    if (!rows.length) return null;
    return this.validatePublishedDraft(rows[0], checkpoint, runId);
  }

  private validatePublishedDraft(pr: PublishedDraft, checkpoint: DraftPublication, runId: string): string {
    if (!pr || !pr.draft || pr.state !== 'open' || pr.head?.ref !== checkpoint.branch || pr.head?.sha !== checkpoint.head
      || pr.head?.repo?.full_name !== checkpoint.repo || pr.base?.repo?.full_name !== checkpoint.repo || pr.base?.ref !== checkpoint.base
      || !pr.body?.includes(`Opened by the djimitflo loop for run \`${runId}\``)
      || !pr.html_url?.startsWith(`https://github.com/${checkpoint.repo}/pull/`)) throw new Error('publication_reconciliation_mismatch');
    return pr.html_url;
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
