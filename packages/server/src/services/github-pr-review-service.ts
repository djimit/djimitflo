import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { Database } from 'better-sqlite3';
import { LoopService } from './loop-service';
import { ComplianceAuditService } from './compliance-audit-service';
import { RoborevFindingsService } from './roborev-findings-service';

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

type Verdict = 'accepted' | 'needs_revision' | 'rejected' | 'insufficient_evidence';
type LlmRuntime = 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'mock';

const GH_TIMEOUT_MS = 15_000;
const LARGE_PR_FILES = 40;
const LARGE_PR_LINES = 1500;
const SENSITIVE_PATH_PATTERN = /\.env|secret|credential/i;
const LLM_RUNTIMES: LlmRuntime[] = ['codex', 'opencode', 'claude', 'gemini', 'editor', 'mock'];
const LLM_CHECKER_TIMEOUT_MS = 480_000;

/**
 * Djimitflo's own Kilo Code Bot replacement, posted back to GitHub via the
 * `gh` CLI. Two review paths, both driven through the real maker/checker
 * state machine in LoopService — see .claude/plans/zany-coalescing-teapot.md:
 *
 * - Phase 1 (default): a synchronous, rule-based stub verdict, no LLM call.
 * - Phase 2 (opt-in via GITHUB_PR_REVIEW_RUNTIME): materializes a real git
 *   worktree at the PR's head commit and runs a real LLM checker through
 *   LoopService.executeChecker(), asynchronously. Off by default —
 *   automatically spawning a paid LLM call on every PR push is exactly the
 *   runaway-cost failure mode that retired Kilo Code Bot in the first place.
 */
export class GithubPrReviewService {
  private db: Database;
  private loops: LoopService;
  private audit: ComplianceAuditService;
  private roborev: RoborevFindingsService;

  constructor(db: Database, loops?: LoopService) {
    this.db = db;
    this.loops = loops ?? new LoopService(db);
    this.audit = new ComplianceAuditService(db);
    this.roborev = new RoborevFindingsService();
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
  startReview(input: StartReviewInput): { status: 'commented' | 'pending' | 'failed'; verdict?: Verdict } {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO github_pull_request_reviews (id, loop_run_id, owner, repo, pr_number, head_sha, base_ref, head_ref, status, delivery_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(id, input.loopRunId, input.owner, input.repo, input.number, input.headSha, input.baseRef, input.headRef, input.deliveryId, now, now);

    const llmRuntime = this.resolveLlmRuntime();
    if (llmRuntime) {
      void this.runLlmReview(id, input, llmRuntime).catch(() => { /* runLlmReview handles its own failure bookkeeping */ });
      return { status: 'pending' };
    }

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

  private resolveLlmRuntime(): LlmRuntime | null {
    const configured = process.env.GITHUB_PR_REVIEW_RUNTIME;
    return configured && (LLM_RUNTIMES as string[]).includes(configured) ? (configured as LlmRuntime) : null;
  }

  /**
   * Materializes a real worktree at the PR's head commit and drives it
   * through LoopService.executeChecker() with a real runtime. Never throws
   * to its caller (startReview fires this with `void ... .catch()`) — all
   * failure paths update the review row and audit log directly.
   */
  private async runLlmReview(reviewId: string, input: StartReviewInput, runtime: LlmRuntime): Promise<void> {
    try {
      const run = this.loops.getLoopRun(input.loopRunId);
      const findingId = run.findings[0]?.id;
      if (!findingId) throw new Error('PR_REVIEW_FINDING_MISSING');
      const now = new Date().toISOString();

      execFileSync('git', ['fetch', 'origin', `pull/${input.number}/head`], { cwd: input.repositoryPath, timeout: GH_TIMEOUT_MS });

      const makerLeaseId = randomUUID();
      const makerBranch = `djimitflo/pr-review-${input.number}-${makerLeaseId.slice(0, 8)}`;
      this.loops.insertWorkerLease({
        id: makerLeaseId, loopRunId: input.loopRunId, role: 'maker', runtime: 'manual', findingId,
        worktreePath: null, branchName: makerBranch,
        metadata: { github_pr: { owner: input.owner, repo: input.repo, number: input.number, head_sha: input.headSha }, synthetic: true },
        now,
      });
      const worktreePath = this.loops.createWorktree(input.repositoryPath, input.loopRunId, findingId, makerBranch);
      execFileSync('git', ['reset', '--hard', input.headSha], { cwd: worktreePath, timeout: GH_TIMEOUT_MS });
      this.loops.updateWorkerLeaseWorktree(makerLeaseId, worktreePath, makerBranch);

      // buildCheckerPrompt() shows `git diff -- .` from the maker worktree,
      // which is empty once the PR's commits are checked out (nothing
      // uncommitted) — so the actual diff goes in the assignment packet
      // instead, which the prompt surfaces first. Wrapped as untrusted
      // external content: this is the first point a real LLM reads PR data.
      const diffText = execFileSync('gh', ['pr', 'diff', String(input.number), '--repo', `${input.owner}/${input.repo}`], { encoding: 'utf8', timeout: GH_TIMEOUT_MS });
      const packetPath = path.join(worktreePath, '.djimitflo', 'PR_REVIEW_PACKET.md');
      fs.mkdirSync(path.dirname(packetPath), { recursive: true });
      fs.writeFileSync(packetPath, [
        'BEGIN_EXTERNAL_CONTENT source=github_pull_request_diff trust=untrusted',
        `PR #${input.number} (${input.owner}/${input.repo}) at ${input.headSha}`,
        diffText,
        'END_EXTERNAL_CONTENT',
      ].join('\n'), 'utf8');

      this.loops.updateWorkerLeaseStatus(makerLeaseId, 'completed', {
        notes: 'Maker output is the PR head commit, fetched and checked out for review.',
        assignment_packet_file: packetPath,
      });

      const checkerLeaseId = randomUUID();
      this.loops.insertWorkerLease({
        id: checkerLeaseId, loopRunId: input.loopRunId, role: 'checker', runtime, findingId,
        worktreePath: null, branchName: null, metadata: { maker_lease_id: makerLeaseId },
        now,
      });

      const execResult = await this.loops.executeChecker(input.loopRunId, {
        lease_id: checkerLeaseId, runtime, timeout_ms: LLM_CHECKER_TIMEOUT_MS,
      });
      const verdict = (execResult.lease.metadata.verdict as Verdict | undefined) || 'insufficient_evidence';
      const notes = typeof execResult.lease.metadata.notes === 'string' ? execResult.lease.metadata.notes : '';

      const stat = this.fetchPrStat(input.owner, input.repo, input.number);
      const body = this.buildComment(input, stat, verdict, notes);
      const checkRunId = this.postToGithub(input, verdict, body);

      this.db.prepare("UPDATE github_pull_request_reviews SET status='commented', check_run_id=?, metadata=?, updated_at=? WHERE id=?")
        .run(checkRunId, JSON.stringify({ verdict, checker_lease_id: checkerLeaseId, runtime }), new Date().toISOString(), reviewId);
      this.audit.appendEntry({
        actor: 'github-pr-review', action: 'github_pr_reviewed', resource: input.loopRunId, outcome: 'success',
        evidence: { owner: input.owner, repo: input.repo, number: input.number, head_sha: input.headSha, verdict, runtime },
        event: { eventType: 'integration.reviewed', resourceType: 'loop_run', riskLevel: 'low' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.prepare("UPDATE github_pull_request_reviews SET status='failed', metadata=?, updated_at=? WHERE id=?")
        .run(JSON.stringify({ error: message, runtime }), new Date().toISOString(), reviewId);
      this.audit.appendEntry({
        actor: 'github-pr-review', action: 'github_pr_review_failed', resource: input.loopRunId, outcome: 'failure',
        evidence: { owner: input.owner, repo: input.repo, number: input.number, head_sha: input.headSha, error: message, runtime },
        event: { eventType: 'integration.review_failed', resourceType: 'loop_run', riskLevel: 'low' },
      });
    }
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

  private buildComment(input: StartReviewInput, stat: PrStat, verdict: Verdict, llmNotes = ''): string {
    const isStub = !llmNotes;
    const verdictLine = verdict === 'accepted' ? `✅ No blocking issues found${isStub ? ' by the automated stub check' : ''}.`
      : verdict === 'rejected' ? '❌ Blocking issues found.'
      : verdict === 'insufficient_evidence' ? '⚠️ Review runtime could not produce a confident verdict.'
      : '⚠️ Needs a closer look before merge.';
    const lines = [
      '## Djimitflo automated review',
      '',
      verdictLine,
      '',
      `- Changed files: ${stat.changedFiles}`,
      `- Lines changed: +${stat.additions} / -${stat.deletions}`,
      `- Loop run: ${input.loopRunId}`,
      '',
    ];
    if (llmNotes) lines.push(llmNotes, '');
    lines.push(this.roborevSection(input.owner, input.repo, input.headSha));
    lines.push(isStub
      ? '_Phase 1 automated stub — full checker review not yet enabled. This does not merge or block merging on its own._'
      : '_Automated review. This does not merge or block merging on its own._');
    return lines.filter(Boolean).join('\n') + '\n';
  }

  /** Empty string (omitted from the comment) when roborev has no matching commit-level findings. */
  private roborevSection(owner: string, repo: string, headSha: string): string {
    const findings = this.roborev.readPending(`${owner}/${repo}`, headSha);
    if (findings.length === 0) return '';
    const lines = findings.map((finding) => `- **${finding.severity}** ${finding.task_title}${finding.affected_files.length ? ` (${finding.affected_files.join(', ')})` : ''}`);
    return ['## Static findings (roborev)', '', ...lines, ''].join('\n');
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

    const conclusion = verdict === 'accepted' ? 'success' : verdict === 'rejected' ? 'failure' : 'neutral';
    const checkPayload = {
      name: 'djimitflo-review',
      head_sha: input.headSha,
      status: 'completed',
      conclusion,
      output: {
        title: verdict === 'accepted' ? 'No blocking issues found' : verdict === 'rejected' ? 'Blocking issues found' : 'Needs a closer look',
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
