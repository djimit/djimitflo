/**
 * RepoExplainerScheduler — incremental refresh scheduler for the explainer fleet.
 *
 * Decides which discovered repositories need a fresh explainer based on:
 * - missing bundle / never generated
 * - time since last generation (staleness)
 * - new commit SHA vs last recorded commit
 * - priority tier and health-score degradation
 * - daily cost/rate-limit budgets
 *
 * Queues work into `explainer_jobs` linked to `explainer_tasks`.
 */

import { randomUUID } from "crypto";
import type { Database } from "better-sqlite3";

export interface SchedulerOptions {
  /** Maximum jobs to schedule in one run. */
  maxJobs?: number;
  /** Repos with no bundle after this many days are stale. */
  stalenessDays?: number;
  /** Repos with any bundle older than this many days are stale. */
  refreshIntervalDays?: number;
  /** Daily budget tokens for LLM invocations (soft limit). */
  dailyLlmBudget?: number;
  /** Daily budget for GitHub API calls (soft limit). */
  dailyGitHubApiBudget?: number;
  /** Daily budget for git clone operations (soft limit). */
  dailyGitOpsBudget?: number;
  /** Date override for deterministic tests. */
  now?: Date;
}

export interface SchedulerBudget {
  llm_calls_used: number;
  github_api_calls_used: number;
  git_ops_used: number;
  llm_calls_remaining: number;
  github_api_calls_remaining: number;
  git_ops_remaining: number;
}

export interface RefreshCandidate {
  discovered_repository_id: string;
  full_name: string;
  priority_tier: number;
  last_commit_sha: string | null;
  last_bundle_commit_sha: string | null;
  last_bundle_at: string | null;
  reason: "never_generated" | "new_commit" | "stale" | "tier_refresh";
  priority_score: number;
}

export interface ScheduleRunResult {
  candidates: RefreshCandidate[];
  scheduled: number;
  skipped_due_to_budget: number;
  budget: SchedulerBudget;
}

export interface SchedulerStatus {
  pending_jobs: number;
  running_jobs: number;
  completed_today: number;
  failed_today: number;
  budget: SchedulerBudget;
  paused: boolean;
}

export class RepoExplainerScheduler {
  private maxJobs: number;
  private stalenessDays: number;
  private refreshIntervalDays: number;
  private dailyLlmBudget: number;
  private dailyGitHubApiBudget: number;
  private dailyGitOpsBudget: number;

  constructor(
    private db: Database,
    options: SchedulerOptions = {},
  ) {
    this.maxJobs = options.maxJobs ?? (Number(process.env.DJIMITFLO_SCHEDULER_MAX_JOBS) || 50);
    this.stalenessDays = options.stalenessDays ?? (Number(process.env.DJIMITFLO_SCHEDULER_STALENESS_DAYS) || 7);
    this.refreshIntervalDays = options.refreshIntervalDays ?? (Number(process.env.DJIMITFLO_SCHEDULER_REFRESH_DAYS) || 7);
    this.dailyLlmBudget = options.dailyLlmBudget ?? (Number(process.env.DJIMITFLO_DAILY_LLM_BUDGET) || 500);
    this.dailyGitHubApiBudget = options.dailyGitHubApiBudget ?? (Number(process.env.DJIMITFLO_DAILY_GITHUB_API_BUDGET) || 5000);
    this.dailyGitOpsBudget = options.dailyGitOpsBudget ?? (Number(process.env.DJIMITFLO_DAILY_GIT_OPS_BUDGET) || 500);
  }

  private now(options?: SchedulerOptions): Date {
    return options?.now ?? new Date();
  }

  /**
   * Find repositories that need a fresh explainer, ordered by priority score.
   */
  findRefreshCandidates(options?: SchedulerOptions): RefreshCandidate[] {
    const now = this.now(options);
    const staleThreshold = new Date(now.getTime() - this.stalenessDays * 24 * 60 * 60 * 1000).toISOString();
    const refreshThreshold = new Date(now.getTime() - this.refreshIntervalDays * 24 * 60 * 60 * 1000).toISOString();

    const rows = this.db.prepare(`
      SELECT
        dr.id AS discovered_repository_id,
        dr.full_name,
        dr.priority_tier,
        dr.last_commit_sha,
        dr.last_commit_at,
        eb.id AS last_bundle_id,
        eb.metadata AS bundle_metadata,
        eb.created_at AS last_bundle_at
      FROM discovered_repositories dr
      LEFT JOIN (
        SELECT id AS task_id, discovered_repository_id, MAX(created_at) AS max_created
        FROM explainer_tasks
        WHERE status = 'completed' AND discovered_repository_id IS NOT NULL
        GROUP BY discovered_repository_id
      ) latest_task ON latest_task.discovered_repository_id = dr.id
      LEFT JOIN explainer_bundles eb ON eb.task_id = latest_task.task_id
      WHERE dr.is_active = 1
        AND NOT EXISTS (
          SELECT 1
          FROM explainer_tasks active_task
          JOIN explainer_jobs active_job ON active_job.task_id = active_task.id
          WHERE active_task.discovered_repository_id = dr.id
            AND active_job.status IN ('pending', 'queued', 'running')
        )
      ORDER BY dr.priority_tier ASC, dr.stargazers_count DESC
    `).all() as Array<{
      discovered_repository_id: string;
      full_name: string;
      priority_tier: number;
      last_commit_sha: string | null;
      last_commit_at: string | null;
      last_bundle_id: string | null;
      bundle_metadata: string | null;
      last_bundle_at: string | null;
    }>;

    const candidates: RefreshCandidate[] = [];
    for (const row of rows) {
      const bundleMeta = row.bundle_metadata ? JSON.parse(row.bundle_metadata) : {};
      const lastBundleCommit = bundleMeta.source_commit ?? null;
      let reason: RefreshCandidate["reason"];
      let score = 0;

      if (!row.last_bundle_id) {
        reason = "never_generated";
        score = 1000;
      } else if (row.last_commit_at && row.last_bundle_at && row.last_commit_at > row.last_bundle_at) {
        reason = "new_commit";
        score = 800;
      } else if (!row.last_bundle_at || row.last_bundle_at < refreshThreshold) {
        reason = "stale";
        score = 500;
      } else if (row.priority_tier === 1) {
        reason = "tier_refresh";
        score = 200;
      } else {
        continue;
      }

      // Boost priority tier 1 repos and penalize low tier.
      score += (4 - row.priority_tier) * 50;
      if (row.last_bundle_at && row.last_bundle_at < staleThreshold) score += 100;

      candidates.push({
        discovered_repository_id: row.discovered_repository_id,
        full_name: row.full_name,
        priority_tier: row.priority_tier,
        last_commit_sha: row.last_commit_sha,
        last_bundle_commit_sha: lastBundleCommit,
        last_bundle_at: row.last_bundle_at,
        reason,
        priority_score: score,
      });
    }

    return candidates.sort((a, b) => b.priority_score - a.priority_score);
  }

  /**
   * Schedule jobs for refresh candidates up to budget and max job limits.
   */
  scheduleRefreshCandidates(candidates: RefreshCandidate[], options?: SchedulerOptions): ScheduleRunResult {
    const now = this.now(options);
    const budget = this.getBudget(now);
    let scheduled = 0;
    let skippedDueToBudget = 0;

    const createTask = this.db.prepare(`
      INSERT INTO explainer_tasks (id, title, description, provider, remote_url, discovered_repository_id, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const createJob = this.db.prepare(`
      INSERT INTO explainer_jobs (
        id, task_id, scheduled_at, status, priority_score, scheduled_reason, dedupe_key,
        estimated_llm_calls, estimated_github_api_calls, estimated_git_ops,
        metadata, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const estimatedLlmCost = 3; // per-repo author + critic + retry headroom
    const estimatedGitOpsCost = 1;
    const estimatedGitHubApiCost = 1; // ls-remote preflight

    const transaction = this.db.transaction(() => {
      for (const candidate of candidates) {
        if (scheduled >= this.maxJobs) break;

        if (
          budget.llm_calls_remaining < estimatedLlmCost ||
          budget.git_ops_remaining < estimatedGitOpsCost ||
          budget.github_api_calls_remaining < estimatedGitHubApiCost
        ) {
          skippedDueToBudget += 1;
          continue;
        }

        const taskId = randomUUID();
        const jobId = randomUUID();
        const title = `Explain ${candidate.full_name}`;
        const remoteUrl = `https://github.com/${candidate.full_name}`;
        const dedupeKey = `${candidate.discovered_repository_id}:${candidate.last_commit_sha ?? "latest"}`;
        const metadata = JSON.stringify({
          scheduled_reason: candidate.reason,
          last_commit_sha: candidate.last_commit_sha,
          last_bundle_commit_sha: candidate.last_bundle_commit_sha,
        });

        createTask.run(
          taskId,
          title,
          `Scheduled refresh for ${candidate.full_name}`,
          "github",
          remoteUrl,
          candidate.discovered_repository_id,
          "pending",
          metadata,
          now.toISOString(),
          now.toISOString(),
        );

        createJob.run(
          jobId,
          taskId,
          now.toISOString(),
          candidate.priority_score,
          candidate.reason,
          dedupeKey,
          estimatedLlmCost,
          estimatedGitHubApiCost,
          estimatedGitOpsCost,
          metadata,
          now.toISOString(),
          now.toISOString(),
        );

        budget.llm_calls_remaining -= estimatedLlmCost;
        budget.git_ops_remaining -= estimatedGitOpsCost;
        budget.github_api_calls_remaining -= estimatedGitHubApiCost;
        budget.llm_calls_used += estimatedLlmCost;
        budget.git_ops_used += estimatedGitOpsCost;
        budget.github_api_calls_used += estimatedGitHubApiCost;
        scheduled += 1;
      }
    });

    transaction();

    return {
      candidates,
      scheduled,
      skipped_due_to_budget: skippedDueToBudget,
      budget,
    };
  }

  /**
   * Run one scheduler iteration: find candidates, schedule jobs, return status.
   */
  async run(options?: SchedulerOptions): Promise<ScheduleRunResult> {
    if (this.isPaused()) return this.pausedResult(options);
    const candidates = this.findRefreshCandidates(options);
    return this.scheduleRefreshCandidates(candidates, options);
  }

  /**
   * Refresh stale repositories for a specific owner.
   */
  async refreshStale(owner: string, options?: SchedulerOptions): Promise<ScheduleRunResult> {
    if (this.isPaused()) return this.pausedResult(options);
    const allCandidates = this.findRefreshCandidates(options);
    const ownerCandidates = allCandidates.filter((c) => c.full_name.toLowerCase().startsWith(`${owner.toLowerCase()}/`));
    return this.scheduleRefreshCandidates(ownerCandidates, options);
  }

  /**
   * Claim the next pending job for a worker.
   */
  claimNextJob(workerId: string): { job_id: string; task_id: string; full_name: string } | null {
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT j.id AS job_id, j.task_id, t.remote_url
        FROM explainer_jobs j
        JOIN explainer_tasks t ON t.id = j.task_id
        WHERE j.status = 'pending'
        ORDER BY j.priority_score DESC, j.scheduled_at ASC
        LIMIT 1
      `).get() as { job_id: string; task_id: string; remote_url: string } | undefined;

      if (!row) return null;
      const now = new Date().toISOString();
      const claimed = this.db.prepare(
        "UPDATE explainer_jobs SET status = 'running', worker_id = ?, started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      ).run(workerId, now, now, row.job_id);
      if (claimed.changes !== 1) return null;
      this.db.prepare("UPDATE explainer_tasks SET status = 'running', updated_at = ? WHERE id = ?").run(now, row.task_id);
      return {
        job_id: row.job_id,
        task_id: row.task_id,
        full_name: row.remote_url.replace("https://github.com/", ""),
      };
    })();
  }

  /**
   * Mark a job completed or failed.
   */
  completeJob(jobId: string, status: "completed" | "failed", errorMessage?: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE explainer_jobs SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?").run(status, now, now, jobId);

    const taskRow = this.db.prepare("SELECT task_id FROM explainer_jobs WHERE id = ?").get(jobId) as { task_id: string } | undefined;
    if (taskRow) {
      const taskStatus = status === "completed" ? "completed" : "failed";
      this.db.prepare("UPDATE explainer_tasks SET status = ?, error_message = ?, updated_at = ? WHERE id = ?").run(
        taskStatus,
        errorMessage ?? null,
        now,
        taskRow.task_id,
      );
    }
  }

  /**
   * Current scheduler status and budget.
   */
  getStatus(options?: SchedulerOptions): SchedulerStatus {
    const now = this.now(options);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'completed' AND finished_at >= ? THEN 1 ELSE 0 END) AS completed_today,
        SUM(CASE WHEN status = 'failed' AND finished_at >= ? THEN 1 ELSE 0 END) AS failed_today
      FROM explainer_jobs
    `).get(todayStart, todayStart) as { pending: number; running: number; completed_today: number; failed_today: number };

    return {
      pending_jobs: Number(counts.pending ?? 0),
      running_jobs: Number(counts.running ?? 0),
      completed_today: Number(counts.completed_today ?? 0),
      failed_today: Number(counts.failed_today ?? 0),
      budget: this.getBudget(now),
      paused: this.isPaused(),
    };
  }

  /**
   * Compute today's remaining budget based on audit log / job history.
   */
  private getBudget(now: Date): SchedulerBudget {
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    const used = this.db.prepare(`
      SELECT
        SUM(estimated_llm_calls) AS llm_calls,
        SUM(estimated_git_ops) AS git_ops,
        SUM(estimated_github_api_calls) AS github_api
      FROM explainer_jobs
      WHERE created_at >= ?
    `).get(todayStart) as { llm_calls: number; git_ops: number; github_api: number };

    const llmCallsUsed = Number(used.llm_calls ?? 0);
    const gitOpsUsed = Number(used.git_ops ?? 0);
    const githubApiUsed = Number(used.github_api ?? 0);

    return {
      llm_calls_used: llmCallsUsed,
      github_api_calls_used: githubApiUsed,
      git_ops_used: gitOpsUsed,
      llm_calls_remaining: Math.max(0, this.dailyLlmBudget - llmCallsUsed),
      github_api_calls_remaining: Math.max(0, this.dailyGitHubApiBudget - githubApiUsed),
      git_ops_remaining: Math.max(0, this.dailyGitOpsBudget - gitOpsUsed),
    };
  }

  setPaused(paused: boolean): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO config (key, value, created_at, updated_at)
      VALUES ('explainer_scheduler_paused', ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify(paused), now, now);
  }

  isPaused(): boolean {
    const row = this.db.prepare("SELECT value FROM config WHERE key = 'explainer_scheduler_paused'").get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) === true : false;
  }

  private pausedResult(options?: SchedulerOptions): ScheduleRunResult {
    return { candidates: [], scheduled: 0, skipped_due_to_budget: 0, budget: this.getBudget(this.now(options)) };
  }
}
