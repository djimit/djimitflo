import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { Database } from 'better-sqlite3';
import { LoopService } from './loop-service';
import { ComplianceAuditService } from './compliance-audit-service';

export interface StartReviewInput {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  baseRef: string;
  headRef: string;
  repositoryPath: string;
  loopRunId: string;
  deliveryId: string;
}

interface PrStat {
  title: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: string[];
}

type Verdict = 'accepted' | 'needs_revision';

const GH_TIMEOUT_MS = 15_000;
const LARGE_PR_FILES = 40;
const LARGE_PR_LINES = 1500;
const SENSITIVE_PATH_PATTERN = /\.env|secret|credential/i;

/**
 * Djimitflo's own Kilo Code Bot replacement, Phase 1: a rule-based stub
 * verdict (no LLM yet) driven through the real maker/checker state machine
 * in LoopService, posted back to GitHub via the `gh` CLI. See
 * .claude/plans/zany-coalescing-teapot.md for the phased design.
 */
export class GithubPrReviewService {
  private db: Database;
  private loops: LoopService;
  private audit: ComplianceAuditService;

  constructor(db: Database, loops?: LoopService) {
    this.db = db;
    this.loops = loops ?? new LoopService(db);
    this.audit = new ComplianceAuditService(db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS github_pull_request_reviews (
      id TEXT PRIMARY KEY,
      loop_run_id TEXT,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      base_ref TEXT,
      head_ref TEXT,
      check_run_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','commented','completed','failed')),
      delivery_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_github_pr_reviews_unique ON github_pull_request_reviews(owner, repo, pr_number, head_sha)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_github_pr_reviews_loop_run ON github_pull_request_reviews(loop_run_id)');
  }

  /**
   * Reviews the PR that `loopRunId` was already started for (a `loop_run`
   * with a real `target_finding`, created by the caller). Never throws:
   * a `gh`/GitHub failure is recorded as `status: 'failed'` in the new
   * table and returned, since djimitflo's own DB state must stay
   * authoritative even when the GitHub-posting step fails transiently.
   */
  startReview(input: StartReviewInput): { status: 'commented' | 'failed'; verdict?: Verdict } {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO github_pull_request_reviews (id, loop_run_id, owner, repo, pr_number, head_sha, base_ref, head_ref, status, delivery_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(id, input.loopRunId, input.owner, input.repo, input.number, input.headSha, input.baseRef, input.headRef, input.deliveryId, now, now);

    try {
      const { verdict, checkerLeaseId } = this.runCheckerVerdict(input);
      const stat = this.fetchPrStat(input.owner, input.repo, input.number);
      const body = this.buildComment(input, stat, verdict);
      const checkRunId = this.postToGithub(input, verdict, body);

      this.db.prepare("UPDATE github_pull_request_reviews SET status='commented', check_run_id=?, metadata=?, updated_at=? WHERE id=?")
        .run(checkRunId, JSON.stringify({ verdict, checker_lease_id: checkerLeaseId }), new Date().toISOString(), id);

      this.audit.appendEntry({
        actor: 'github-pr-review', action: 'github_pr_reviewed', resource: input.loopRunId, outcome: 'success',
        evidence: { owner: input.owner, repo: input.repo, number: input.number, head_sha: input.headSha, verdict },
        event: { eventType: 'integration.reviewed', resourceType: 'loop_run', riskLevel: 'low' },
      });

      return { status: 'commented', verdict };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.prepare("UPDATE github_pull_request_reviews SET status='failed', metadata=?, updated_at=? WHERE id=?")
        .run(JSON.stringify({ error: message }), new Date().toISOString(), id);
      this.audit.appendEntry({
        actor: 'github-pr-review', action: 'github_pr_review_failed', resource: input.loopRunId, outcome: 'failure',
        evidence: { owner: input.owner, repo: input.repo, number: input.number, head_sha: input.headSha, error: message },
        event: { eventType: 'integration.review_failed', resourceType: 'loop_run', riskLevel: 'low' },
      });
      return { status: 'failed' };
    }
  }

  /**
   * A PR review is checker-only: the PR's commits already are the "patch",
   * so the maker lease is synthesized as already-completed rather than
   * driving a real fix-generation pass. This has no isolated worktree, so
   * LoopVerificationService's worktree/diff gates will legitimately show
   * 'fail' and the loop_run itself settles as 'blocked' — that's expected
   * and does not affect the verdict posted to GitHub below, which is
   * computed independently from the PR's own diff stats.
   */
  private runCheckerVerdict(input: StartReviewInput): { verdict: Verdict; checkerLeaseId: string } {
    const run = this.loops.getLoopRun(input.loopRunId);
    const findingId = run.findings[0]?.id;
    if (!findingId) throw new Error('PR_REVIEW_FINDING_MISSING');
    const now = new Date().toISOString();

    const makerLeaseId = randomUUID();
    this.loops.insertWorkerLease({
      id: makerLeaseId, loopRunId: input.loopRunId, role: 'maker', runtime: 'manual', findingId,
      worktreePath: null, branchName: input.headRef,
      metadata: { github_pr: { owner: input.owner, repo: input.repo, number: input.number, head_sha: input.headSha }, synthetic: true },
      now,
    });
    this.loops.updateWorkerLeaseStatus(makerLeaseId, 'completed', {
      notes: "Maker output is the PR's own commits; no isolated worktree was created for this synthetic review lease.",
    });

    const checkerLeaseId = randomUUID();
    this.loops.insertWorkerLease({
      id: checkerLeaseId, loopRunId: input.loopRunId, role: 'checker', runtime: 'manual', findingId,
      worktreePath: null, branchName: null, metadata: { maker_lease_id: makerLeaseId },
      now,
    });

    const stat = this.fetchPrStat(input.owner, input.repo, input.number);
    const { verdict, notes } = this.computeVerdict(stat);
    this.loops.submitCheckerVerdict(input.loopRunId, { lease_id: checkerLeaseId, verdict, notes });

    return { verdict, checkerLeaseId };
  }

  private fetchPrStat(owner: string, repo: string, number: number): PrStat {
    const raw = execFileSync('gh', [
      'pr', 'view', String(number), '--repo', `${owner}/${repo}`,
      '--json', 'title,url,additions,deletions,changedFiles,files',
    ], { encoding: 'utf8', timeout: GH_TIMEOUT_MS });
    const parsed = JSON.parse(raw) as { title: string; url: string; additions: number; deletions: number; changedFiles: number; files: Array<{ path: string }> };
    return {
      title: parsed.title, url: parsed.url,
      additions: parsed.additions, deletions: parsed.deletions, changedFiles: parsed.changedFiles,
      files: (parsed.files || []).map((f) => f.path),
    };
  }

  /** Deliberately simple, explicitly labeled as a stub — see class docstring. */
  private computeVerdict(stat: PrStat): { verdict: Verdict; notes: string } {
    const reasons: string[] = [];
    if (stat.changedFiles > LARGE_PR_FILES || stat.additions + stat.deletions > LARGE_PR_LINES) {
      reasons.push(`Large change (${stat.changedFiles} files, ${stat.additions + stat.deletions} lines) — please split or request manual review.`);
    }
    const sensitive = stat.files.filter((f) => SENSITIVE_PATH_PATTERN.test(f));
    if (sensitive.length > 0) {
      reasons.push(`Touches sensitive-looking path(s): ${sensitive.join(', ')}.`);
    }
    const verdict: Verdict = reasons.length > 0 ? 'needs_revision' : 'accepted';
    const stub = 'Phase 1 automated stub — full checker review not yet enabled.';
    return { verdict, notes: reasons.length > 0 ? `${stub} ${reasons.join(' ')}` : stub };
  }

  private buildComment(input: StartReviewInput, stat: PrStat, verdict: Verdict): string {
    const lines = [
      '## Djimitflo automated review',
      '',
      verdict === 'accepted' ? '✅ No blocking issues found by the automated stub check.' : '⚠️ Needs a closer look before merge.',
      '',
      `- Changed files: ${stat.changedFiles}`,
      `- Lines changed: +${stat.additions} / -${stat.deletions}`,
      `- Loop run: ${input.loopRunId}`,
      '',
      '_Phase 1 automated stub — full checker review not yet enabled. This does not merge or block merging on its own._',
    ];
    return lines.join('\n') + '\n';
  }

  private postToGithub(input: StartReviewInput, verdict: Verdict, body: string): string | null {
    const bodyFile = path.join(os.tmpdir(), `djimitflo-pr-review-${input.loopRunId}.md`);
    fs.writeFileSync(bodyFile, body, 'utf8');
    try {
      execFileSync('gh', [
        'pr', 'comment', String(input.number), '--repo', `${input.owner}/${input.repo}`, '--body-file', bodyFile,
      ], { timeout: GH_TIMEOUT_MS });
    } finally {
      fs.rmSync(bodyFile, { force: true });
    }

    const conclusion = verdict === 'accepted' ? 'success' : 'neutral';
    const checkPayload = {
      name: 'djimitflo-review',
      head_sha: input.headSha,
      status: 'completed',
      conclusion,
      output: {
        title: verdict === 'accepted' ? 'No blocking issues found' : 'Needs a closer look',
        summary: body,
      },
    };
    const raw = execFileSync('gh', [
      'api', `repos/${input.owner}/${input.repo}/check-runs`, '--input', '-',
    ], { input: JSON.stringify(checkPayload), encoding: 'utf8', timeout: GH_TIMEOUT_MS });
    const parsed = JSON.parse(raw) as { id?: number };
    return parsed.id != null ? String(parsed.id) : null;
  }
}
