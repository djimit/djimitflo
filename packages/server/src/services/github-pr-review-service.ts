import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { Database } from 'better-sqlite3';
import { CHECKER_PACKET_MAX_CHARS, LoopService } from './loop-service';
import { ComplianceAuditService } from './compliance-audit-service';
import { RoborevFindingsService } from './roborev-findings-service';
import { PR_REVIEW_STATUS_CONTEXT } from './loop-auto-merge-state';

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
  additions: number;
  deletions: number;
  changedFiles: number;
  files: string[];
}

/** The material a verdict is computed from, read by exact SHA — never by the PR's (moving) number. */
interface ReviewPacket {
  stat: PrStat;
  mergeBaseSha: string;
  sha256: string;
}

type HoldStage = 'before_packet' | 'after_evaluation' | 'before_status';

/**
 * CODE-005: the PR head moved away from the SHA under review. Not a failure — the newer head gets its own
 * `synchronize` delivery and review — but nothing is published for the old SHA's material.
 */
class PrHeadMovedError extends Error {
  constructor(readonly stage: HoldStage, readonly observedHeadSha: string) {
    super(`PR_HEAD_MOVED at ${stage}: head is now ${observedHeadSha}`);
  }
}

type Verdict = 'accepted' | 'needs_revision' | 'rejected' | 'insufficient_evidence';
type LlmRuntime = 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'mock';

const GH_TIMEOUT_MS = 15_000;
const LARGE_PR_FILES = 40;
const LARGE_PR_LINES = 1500;
const SENSITIVE_PATH_PATTERN = /\.env|secret|credential/i;
const LLM_RUNTIMES: LlmRuntime[] = ['codex', 'opencode', 'claude', 'gemini', 'editor', 'mock'];
const LLM_CHECKER_TIMEOUT_MS = 480_000;
const DIFF_MAX_BUFFER = 64 * 1024 * 1024;
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

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
  startReview(input: StartReviewInput): { status: 'commented' | 'pending' | 'failed' | 'superseded'; verdict?: Verdict } {
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

    let packet: ReviewPacket | undefined;
    try {
      this.assertHeadUnchanged(input, 'before_packet');
      packet = this.fetchExactShaPacket(input);
      const { verdict, checkerLeaseId } = this.runCheckerVerdict(input, packet.stat);
      this.assertHeadUnchanged(input, 'after_evaluation');
      const body = this.buildComment(input, packet, verdict);
      const checkRunId = this.postToGithub(input, verdict, body);

      this.db.prepare("UPDATE github_pull_request_reviews SET status='commented', check_run_id=?, metadata=?, updated_at=? WHERE id=?")
        .run(checkRunId, JSON.stringify({ verdict, checker_lease_id: checkerLeaseId, ...this.binding(input, packet) }), new Date().toISOString(), id);
      this.recordRunBinding(input, packet, 'published');
      this.settleReviewRun(input.loopRunId);

      this.audit.appendEntry({
        actor: 'github-pr-review', action: 'github_pr_reviewed', resource: input.loopRunId, outcome: 'success',
        evidence: { owner: input.owner, repo: input.repo, number: input.number, head_sha: input.headSha, verdict, packet_sha256: packet.sha256 },
        event: { eventType: 'integration.reviewed', resourceType: 'loop_run', riskLevel: 'low' },
      });

      return { status: 'commented', verdict };
    } catch (error) {
      if (error instanceof PrHeadMovedError) {
        this.recordSuperseded(id, input, error, packet);
        return { status: 'superseded' };
      }
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
   * LoopVerificationService marks the change-loop artifact gates (worktree,
   * assignment, diff, checks) 'skipped' — not applicable (E2) — and leaves
   * the run's status for settleReviewRun. The verdict posted to GitHub below
   * is computed independently from the PR's own diff stats, read by the exact head SHA (CODE-005).
   */
  private runCheckerVerdict(input: StartReviewInput, stat: PrStat): { verdict: Verdict; checkerLeaseId: string } {
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
      // P0-5: an automated diff-size heuristic, never a human or independent review
      worktreePath: null, branchName: null, metadata: { maker_lease_id: makerLeaseId, reviewer_type: 'heuristic' },
      now,
    });

    const { verdict, notes } = this.computeVerdict(stat);
    this.loops.submitCheckerVerdict(input.loopRunId, {
      lease_id: checkerLeaseId, verdict, notes,
      manual_attestation: { reviewer: 'roborev-webhook', reason: 'automated pull_request review webhook verdict', reviewer_type: 'heuristic' },
    });

    return { verdict, checkerLeaseId };
  }

  /**
   * The review's loop_run exists only as bookkeeping (synthetic maker, no worktree): loop verification leaves its status
   * as it was (planning/running), or 'blocked' when the review itself failed a gate. Prod 2026-09-25: after the webhook fix 32 such runs in 3 h inflated the blocked count and would have been
   * replayed as failures by the dream state. Once the verdict is on GitHub the run has done its job: settle it completed.
   */
  private settleReviewRun(loopRunId: string): void {
    this.db.prepare(`UPDATE loop_runs SET status = 'completed', updated_at = ?,
      metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.settled_by', 'github-pr-review') WHERE id = ? AND status IN ('planning', 'running', 'blocked')`)
      .run(new Date().toISOString(), loopRunId);
    // its goal too (prod 2026-09-27: 42 review goals stayed 'running' after their run was settled); idempotently catches
    // earlier settled reviews as well
    this.db.prepare(`UPDATE goals SET status = 'completed', updated_at = ? WHERE status = 'running' AND id IN
      (SELECT goal_id FROM loop_runs WHERE goal_id IS NOT NULL AND status = 'completed' AND json_extract(metadata, '$.settled_by') = 'github-pr-review')`)
      .run(new Date().toISOString());
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
    let packet: ReviewPacket | undefined;
    try {
      const run = this.loops.getLoopRun(input.loopRunId);
      const findingId = run.findings[0]?.id;
      if (!findingId) throw new Error('PR_REVIEW_FINDING_MISSING');
      const now = new Date().toISOString();

      const baseTipSha = this.fetchBaseTip(input);
      execFileSync('git', ['fetch', 'origin', `pull/${input.number}/head`], { cwd: input.repositoryPath, timeout: GH_TIMEOUT_MS });
      this.ensureCommit(input.repositoryPath, input.headSha);

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
      // CODE-005: the diff comes from git, merge-base..headSha in this worktree,
      // never from `gh pr diff <number>` (whatever head the PR has now).
      this.assertHeadUnchanged(input, 'before_packet');
      const mergeBaseSha = execFileSync('git', ['merge-base', baseTipSha, input.headSha], { cwd: worktreePath, encoding: 'utf8', timeout: GH_TIMEOUT_MS }).trim();
      const diffText = execFileSync('git', ['diff', '--no-color', '--no-ext-diff', mergeBaseSha, input.headSha], { cwd: worktreePath, encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: DIFF_MAX_BUFFER });
      const packetText = [
        'BEGIN_EXTERNAL_CONTENT source=github_pull_request_diff trust=untrusted',
        `PR #${input.number} (${input.owner}/${input.repo}) at ${input.headSha} (merge base ${mergeBaseSha})`,
        diffText,
        'END_EXTERNAL_CONTENT',
      ].join('\n');
      packet = { stat: this.gitStat(worktreePath, mergeBaseSha, input.headSha), mergeBaseSha, sha256: sha256(packetText) };
      const packetPath = path.join(worktreePath, '.djimitflo', 'PR_REVIEW_PACKET.md');
      fs.mkdirSync(path.dirname(packetPath), { recursive: true });
      fs.writeFileSync(packetPath, packetText, 'utf8');

      this.loops.updateWorkerLeaseStatus(makerLeaseId, 'completed', {
        notes: 'Maker output is the PR head commit, fetched and checked out for review.',
        assignment_packet_file: packetPath,
        // the checker reads the packet only while it still hashes to this (LoopService.checkerAssignmentPacket)
        assignment_packet_sha256: packet.sha256,
      });

      // The checker prompt cuts the assignment packet at CHECKER_PACKET_MAX_CHARS, so a larger packet's hash would not prove
      // what the checker read. Such a review is not run: it is published as insufficient_evidence (pending, never green).
      let verdict: Verdict = 'insufficient_evidence';
      let notes = '';
      let checkerLeaseId: string | null = null;
      const oversized = packetText.length > CHECKER_PACKET_MAX_CHARS;
      if (oversized) {
        notes = `Review packet is ${packetText.length} characters, above the ${CHECKER_PACKET_MAX_CHARS}-character checker input limit; not reviewed — needs a manual review.`;
      } else {
        checkerLeaseId = randomUUID();
        this.loops.insertWorkerLease({
          id: checkerLeaseId, loopRunId: input.loopRunId, role: 'checker', runtime, findingId,
          worktreePath: null, branchName: null, metadata: { maker_lease_id: makerLeaseId },
          now,
        });
        const execResult = await this.loops.executeChecker(input.loopRunId, {
          lease_id: checkerLeaseId, runtime, timeout_ms: LLM_CHECKER_TIMEOUT_MS,
        });
        verdict = (execResult.lease.metadata.verdict as Verdict | undefined) || 'insufficient_evidence';
        notes = typeof execResult.lease.metadata.notes === 'string' ? execResult.lease.metadata.notes : '';
      }

      this.assertHeadUnchanged(input, 'after_evaluation');
      const body = this.buildComment(input, packet, verdict, notes);
      const checkRunId = this.postToGithub(input, verdict, body);

      const oversizedMeta = oversized ? { reason: 'packet_exceeds_checker_input', packet_chars: packetText.length } : {};
      this.db.prepare("UPDATE github_pull_request_reviews SET status='commented', check_run_id=?, metadata=?, updated_at=? WHERE id=?")
        .run(checkRunId, JSON.stringify({ verdict, checker_lease_id: checkerLeaseId, runtime, ...oversizedMeta, ...this.binding(input, packet) }), new Date().toISOString(), reviewId);
      this.recordRunBinding(input, packet, 'published');
      this.settleReviewRun(input.loopRunId);
      this.audit.appendEntry({
        actor: 'github-pr-review', action: 'github_pr_reviewed', resource: input.loopRunId, outcome: 'success',
        evidence: { owner: input.owner, repo: input.repo, number: input.number, head_sha: input.headSha, verdict, runtime, packet_sha256: packet.sha256 },
        event: { eventType: 'integration.reviewed', resourceType: 'loop_run', riskLevel: 'low' },
      });
    } catch (error) {
      if (error instanceof PrHeadMovedError) {
        this.recordSuperseded(reviewId, input, error, packet, { runtime });
        return;
      }
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

  /**
   * CODE-005: the PR's head as GitHub sees it now. Another head means the material under review was superseded:
   * throw PrHeadMovedError (hold). An unreadable head throws as a failure — never publish on an unverified head.
   */
  private assertHeadUnchanged(input: StartReviewInput, stage: HoldStage): void {
    const raw = execFileSync('gh', [
      'pr', 'view', String(input.number), '--repo', `${input.owner}/${input.repo}`, '--json', 'headRefOid',
    ], { encoding: 'utf8', timeout: GH_TIMEOUT_MS });
    const head = (JSON.parse(raw) as { headRefOid?: unknown }).headRefOid;
    if (typeof head !== 'string' || !/^[0-9a-f]{40,64}$/.test(head)) throw new Error('PR_HEAD_UNREADABLE');
    if (head !== input.headSha) throw new PrHeadMovedError(stage, head);
  }

  /**
   * Phase 1 packet (no worktree): file stats from the compare API addressed by the exact head SHA, which is immutable —
   * not `gh pr view <number>`, which reads whatever head the PR has now. GitHub resolves the merge base with the base branch.
   */
  private fetchExactShaPacket(input: StartReviewInput): ReviewPacket {
    const raw = execFileSync('gh', [
      'api', `repos/${input.owner}/${input.repo}/compare/${input.baseRef}...${input.headSha}`,
      '--jq', '{merge_base: .merge_base_commit.sha, files: [.files[] | {filename, additions, deletions}]}',
    ], { encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: DIFF_MAX_BUFFER });
    const parsed = JSON.parse(raw) as { merge_base?: unknown; files?: Array<{ filename: string; additions: number; deletions: number }> };
    if (typeof parsed.merge_base !== 'string' || !Array.isArray(parsed.files)) throw new Error('PR_COMPARE_UNREADABLE');
    const files = parsed.files;
    return {
      stat: {
        additions: files.reduce((sum, f) => sum + (f.additions || 0), 0),
        deletions: files.reduce((sum, f) => sum + (f.deletions || 0), 0),
        changedFiles: files.length,
        files: files.map((f) => f.filename),
      },
      mergeBaseSha: parsed.merge_base,
      sha256: sha256(JSON.stringify({ repo: `${input.owner}/${input.repo}`, number: input.number, head_sha: input.headSha, merge_base: parsed.merge_base, files })),
    };
  }

  /** Fetches the base branch and resolves it to a SHA once, so the merge base is computed against one fixed commit. */
  private fetchBaseTip(input: StartReviewInput): string {
    const tracking = `refs/remotes/origin/${input.baseRef}`;
    execFileSync('git', ['fetch', 'origin', `+refs/heads/${input.baseRef}:${tracking}`], { cwd: input.repositoryPath, timeout: GH_TIMEOUT_MS });
    return execFileSync('git', ['rev-parse', '--verify', `${tracking}^{commit}`], { cwd: input.repositoryPath, encoding: 'utf8', timeout: GH_TIMEOUT_MS }).trim();
  }

  /** pull/<n>/head may already point past (or after a force-push away from) headSha: fetch the exact commit when missing. */
  private ensureCommit(repositoryPath: string, sha: string): void {
    try {
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repositoryPath, timeout: GH_TIMEOUT_MS, stdio: 'ignore' });
    } catch {
      execFileSync('git', ['fetch', 'origin', sha], { cwd: repositoryPath, timeout: GH_TIMEOUT_MS });
    }
  }

  private gitStat(cwd: string, baseSha: string, headSha: string): PrStat {
    const raw = execFileSync('git', ['diff', '--numstat', '--no-renames', baseSha, headSha], { cwd, encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: DIFF_MAX_BUFFER });
    const rows = raw.split('\n').filter(Boolean).map((line) => line.split('\t'));
    return {
      additions: rows.reduce((sum, [added]) => sum + (Number(added) || 0), 0), // binary files report '-'
      deletions: rows.reduce((sum, [, deleted]) => sum + (Number(deleted) || 0), 0),
      changedFiles: rows.length,
      files: rows.map((row) => row.slice(2).join('\t')),
    };
  }

  private binding(input: StartReviewInput, packet: ReviewPacket): { reviewed_sha: string; merge_base_sha: string; packet_sha256: string } {
    return { reviewed_sha: input.headSha, merge_base_sha: packet.mergeBaseSha, packet_sha256: packet.sha256 };
  }

  /** Records the reviewed SHA and packet hash on the bookkeeping loop run. */
  private recordRunBinding(input: StartReviewInput, packet: ReviewPacket | undefined, outcome: 'published' | 'superseded', extra: Record<string, unknown> = {}): void {
    const value = { reviewed_sha: input.headSha, merge_base_sha: packet?.mergeBaseSha ?? null, packet_sha256: packet?.sha256 ?? null, outcome, ...extra };
    this.db.prepare(`UPDATE loop_runs SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.pr_review', json(?)), updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(value), new Date().toISOString(), input.loopRunId);
  }

  /**
   * Hold: the head moved, so nothing (more) is published for this SHA. The row closes as 'completed' with outcome
   * 'superseded' (the table CHECK has no 'superseded'; 'completed' was otherwise unused) and the bookkeeping run is
   * settled. The newer head's own `synchronize` delivery reviews the new material.
   */
  private recordSuperseded(reviewId: string, input: StartReviewInput, error: PrHeadMovedError, packet: ReviewPacket | undefined, extra: Record<string, unknown> = {}): void {
    const hold = { outcome: 'superseded', reviewed_sha: input.headSha, observed_head_sha: error.observedHeadSha, stage: error.stage, packet_sha256: packet?.sha256 ?? null, ...extra };
    this.db.prepare("UPDATE github_pull_request_reviews SET status='completed', metadata=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(hold), new Date().toISOString(), reviewId);
    this.recordRunBinding(input, packet, 'superseded', { observed_head_sha: error.observedHeadSha, stage: error.stage });
    this.settleReviewRun(input.loopRunId);
    this.audit.appendEntry({
      actor: 'github-pr-review', action: 'github_pr_review_superseded', resource: input.loopRunId, outcome: 'success',
      evidence: { owner: input.owner, repo: input.repo, number: input.number, ...hold },
      event: { eventType: 'integration.review_superseded', resourceType: 'loop_run', riskLevel: 'low' },
    });
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

  private buildComment(input: StartReviewInput, packet: ReviewPacket, verdict: Verdict, llmNotes = ''): string {
    const { stat } = packet;
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
      `- Reviewed commit: ${input.headSha} (merge base ${packet.mergeBaseSha}, packet sha256 ${packet.sha256})`,
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

    // The Checks API (POST .../check-runs) only ever accepts GitHub App
    // tokens — "OAuth apps and authenticated users are not able to create
    // a check suite" per GitHub's own docs. A personal access token (ours)
    // gets a hard 403 regardless of scopes, no matter what permissions are
    // granted. The Commit Status API is the pre-Checks-API mechanism built
    // for exactly this (PAT-authenticated) case and renders the same
    // green/red dot on the PR.
    const state = verdict === 'accepted' ? 'success' : verdict === 'rejected' ? 'failure' : 'pending';
    const statusPayload = {
      state,
      context: PR_REVIEW_STATUS_CONTEXT,
      description: (verdict === 'accepted' ? 'No blocking issues found' : verdict === 'rejected' ? 'Blocking issues found' : 'Needs a closer look').slice(0, 140),
    };
    // CODE-005: re-read the head immediately before publishing; a moved head gets no status on the old SHA.
    this.assertHeadUnchanged(input, 'before_status');
    const raw = execFileSync('gh', [
      'api', `repos/${input.owner}/${input.repo}/statuses/${input.headSha}`, '--input', '-',
    ], { input: JSON.stringify(statusPayload), encoding: 'utf8', timeout: GH_TIMEOUT_MS });
    const parsed = JSON.parse(raw) as { id?: number };
    return parsed.id != null ? String(parsed.id) : null;
  }
}
