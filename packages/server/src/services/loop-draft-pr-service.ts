import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { Database } from 'better-sqlite3';
import { LoopEventService } from './loop-event-service';

/**
 * G4: a verified loop run becomes a *draft* PR. Before this, ready_for_human_merge output stayed in a VPS worktree
 * and was harvested by hand (#357, #363). Default off (LOOP_AUTO_DRAFT_PR_ENABLED): it publishes to GitHub.
 * The merge stays human — a draft PR is only the hand-off.
 */
export class LoopDraftPrService {
  constructor(private db: Database, private fetchImpl: typeof fetch = fetch, private env: NodeJS.ProcessEnv = process.env) {}

  async openForRun(runId: string): Promise<string | null> {
    if (this.env.LOOP_AUTO_DRAFT_PR_ENABLED !== 'true') return null;
    const repo = this.env.GITHUB_REPOSITORY; const token = this.env.GITHUB_TOKEN;
    const events = new LoopEventService(this.db);
    const fail = (reason: string) => { events.recordEvent(runId, 'draft_pr_failed', 'warning', `Draft PR not opened: ${reason}`, {}); return null; };
    if (!repo || !token) return fail('GITHUB_REPOSITORY/GITHUB_TOKEN missing');

    const run = this.db.prepare('SELECT id, status, goal_id, metadata FROM loop_runs WHERE id = ?').get(runId) as { id: string; status: string; goal_id: string | null; metadata: string | null } | undefined;
    if (!run || !['ready_for_human_merge', 'completed'].includes(run.status)) return null;
    const meta = JSON.parse(run.metadata || '{}') as { pr_url?: string };
    if (meta.pr_url) return meta.pr_url; // once per run

    const maker = this.db.prepare(`SELECT id, worktree_path, branch_name FROM worker_leases WHERE loop_run_id = ? AND role = 'maker' AND status = 'completed'
      AND json_extract(metadata, '$.superseded_by_maker_lease_id') IS NULL ORDER BY updated_at DESC LIMIT 1`).get(runId) as { id: string; worktree_path: string | null; branch_name: string | null } | undefined;
    if (!maker?.worktree_path || !maker.branch_name || !fs.existsSync(maker.worktree_path)) return fail('no completed maker worktree');
    const wt = maker.worktree_path;
    const git = (...args: string[]) => execFileSync('git', ['-C', wt, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

    try {
      // Only the maker's real files: never node_modules symlinks from `npm ci`, never lockfile install noise.
      const tracked = git('diff', '--name-only', '--', '.').split('\n').filter(Boolean);
      const untracked = git('ls-files', '--others', '--exclude-standard', '--', '.').split('\n').filter(Boolean);
      const files = [...tracked, ...untracked].filter((f) => !f.split('/').includes('node_modules')
        && !(f.endsWith('package-lock.json') && !tracked.includes(path.join(path.dirname(f), 'package.json').replace(/^\.\//, '')))
        && !fs.lstatSync(path.join(wt, f), { throwIfNoEntry: false })?.isSymbolicLink());
      if (files.length === 0) return fail('no changes in the maker worktree');

      const proposal = run.goal_id ? this.db.prepare('SELECT si.id, si.title FROM goals g JOIN self_improvements si ON si.id = g.improvement_id WHERE g.id = ?').get(run.goal_id) as { id: string; title: string } | undefined : undefined;
      const title = `loop: ${proposal?.title ?? `run ${runId.slice(0, 8)}`}`.slice(0, 120);
      git('add', '--', ...files);
      execFileSync('git', ['-C', wt, '-c', 'user.name=djimitflo-loop', '-c', 'user.email=loop@djimitflo.invalid', 'commit', '-q', '-m', `${title}\n\nLoop run ${runId}, maker lease ${maker.id}.`], { stdio: 'ignore' });
      // Token only as a one-off header: never written to the remote URL or git config.
      const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
      execFileSync('git', ['-C', wt, '-c', `http.extraheader=AUTHORIZATION: basic ${auth}`, 'push', '-q', this.env.LOOP_DRAFT_PR_REMOTE || 'origin', `HEAD:refs/heads/${maker.branch_name}`], { stdio: 'ignore' });

      const verdicts = (this.db.prepare(`SELECT role, json_extract(metadata, '$.verdict') AS verdict FROM worker_leases WHERE loop_run_id = ? AND role IN ('checker', 'security_checker') AND status = 'completed'`).all(runId) as Array<{ role: string; verdict: string | null }>)
        .map((l) => `- ${l.role}: ${l.verdict ?? 'n/a'}`).join('\n');
      const body = `Opened by the djimitflo loop for run \`${runId}\`${proposal ? ` (proposal \`${proposal.id}\`)` : ''}.\n\nReviewer verdicts:\n${verdicts || '- none recorded'}\n\nFiles: ${files.map((f) => `\`${f}\``).join(', ')}\n\nDraft: a human reviews and merges.`;
      const res = await this.fetchImpl(`https://api.github.com/repos/${repo}/pulls`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, head: maker.branch_name, base: this.env.LOOP_DRAFT_PR_BASE || 'main', draft: true, body }),
      });
      if (!res.ok) return fail(`GitHub ${res.status}`);
      const prUrl = String(((await res.json()) as { html_url?: string }).html_url ?? '');
      this.db.prepare(`UPDATE loop_runs SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.pr_url', ?) WHERE id = ?`).run(prUrl, runId);
      events.recordEvent(runId, 'draft_pr_opened', 'info', `Draft PR opened: ${prUrl}`, { pr_url: prUrl, files });
      return prUrl;
    } catch (error) {
      return fail(error instanceof Error ? error.message.replace(/basic [A-Za-z0-9+/=]+/g, 'basic ***').slice(0, 200) : String(error));
    }
  }
}
