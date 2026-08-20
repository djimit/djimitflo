import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "./helpers/test-db";
import { RepoExplainerScheduler } from "../services/repo-explainer-scheduler";

function insertRepo(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    owner: string;
    name: string;
    full_name: string;
    priority_tier: number;
    last_commit_sha: string;
    last_commit_at: string;
    is_active: number;
    stargazers_count: number;
  }> = {},
) {
  const id = overrides.id ?? `repo-${Math.random().toString(36).slice(2)}`;
  const name = overrides.name ?? "repo";
  const owner = overrides.owner ?? "djimit";
  const fullName = overrides.full_name ?? `${owner}/${name}`;
  db.prepare(`
    INSERT INTO discovered_repositories (id, owner, name, full_name, priority_tier, last_commit_sha, last_commit_at, is_active, stargazers_count, html_url, clone_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    owner,
    name,
    fullName,
    overrides.priority_tier ?? 3,
    overrides.last_commit_sha ?? null,
    overrides.last_commit_at ?? null,
    overrides.is_active ?? 1,
    overrides.stargazers_count ?? 0,
    `https://github.com/${fullName}`,
    `https://github.com/${fullName}.git`,
  );
  return id;
}

function insertCompletedBundle(db: Database.Database, repositoryId: string, commitSha: string, createdAt: string) {
  const taskId = `task-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO explainer_tasks (id, title, description, provider, remote_url, discovered_repository_id, status, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    "Explain repo",
    "desc",
    "github",
    `https://github.com/djimit/repo`,
    repositoryId,
    "completed",
    JSON.stringify({}),
    createdAt,
    createdAt,
  );

  const bundleId = `bundle-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO explainer_bundles (id, task_id, bundle_path, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    bundleId,
    taskId,
    "/tmp/bundle",
    JSON.stringify({ source_commit: commitSha }),
    createdAt,
    createdAt,
  );

  return { taskId, bundleId };
}

describe("RepoExplainerScheduler", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("schedules repos that have never been generated", () => {
    const id = insertRepo(db, { full_name: "djimit/new-repo", priority_tier: 2 });
    const scheduler = new RepoExplainerScheduler(db);
    const result = scheduler.findRefreshCandidates({ now: new Date("2026-07-31T00:00:00Z") });

    expect(result).toHaveLength(1);
    expect(result[0].discovered_repository_id).toBe(id);
    expect(result[0].reason).toBe("never_generated");
    expect(result[0].priority_score).toBeGreaterThan(0);
  });

  it("schedules repos with a new commit", () => {
    const id = insertRepo(db, { full_name: "djimit/changed-repo", last_commit_sha: "abc123", last_commit_at: "2026-07-25T00:00:00Z" });
    insertCompletedBundle(db, id, "def456", "2026-07-20T00:00:00Z");

    const scheduler = new RepoExplainerScheduler(db);
    const result = scheduler.findRefreshCandidates({ now: new Date("2026-07-31T00:00:00Z") });

    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe("new_commit");
  });

  it("schedules stale repos based on refresh interval", () => {
    const id = insertRepo(db, { full_name: "djimit/stale-repo", last_commit_sha: "abc123" });
    insertCompletedBundle(db, id, "abc123", "2026-07-01T00:00:00Z");

    const scheduler = new RepoExplainerScheduler(db, { refreshIntervalDays: 7 });
    const result = scheduler.findRefreshCandidates({ now: new Date("2026-07-31T00:00:00Z") });

    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe("stale");
  });

  it("does not schedule up-to-date low-tier repos", () => {
    const id = insertRepo(db, { full_name: "djimit/fresh-repo", priority_tier: 3, last_commit_sha: "abc123" });
    insertCompletedBundle(db, id, "abc123", "2026-07-30T00:00:00Z");

    const scheduler = new RepoExplainerScheduler(db, { refreshIntervalDays: 7 });
    const result = scheduler.findRefreshCandidates({ now: new Date("2026-07-31T00:00:00Z") });

    expect(result).toHaveLength(0);
  });

  it("creates explainer_tasks and explainer_jobs when scheduling", async () => {
    insertRepo(db, { full_name: "djimit/repo-a", priority_tier: 1 });
    insertRepo(db, { full_name: "djimit/repo-b", priority_tier: 2 });

    const scheduler = new RepoExplainerScheduler(db, { maxJobs: 10 });
    const result = await scheduler.run({ now: new Date("2026-07-31T00:00:00Z") });

    expect(result.candidates).toHaveLength(2);
    expect(result.scheduled).toBe(2);

    const jobs = db.prepare("SELECT * FROM explainer_jobs").all() as any[];
    expect(jobs).toHaveLength(2);
    const tasks = db.prepare("SELECT * FROM explainer_tasks").all() as any[];
    expect(tasks).toHaveLength(2);
  });

  it("respects daily job budget limits", async () => {
    for (let i = 0; i < 5; i++) {
      insertRepo(db, { full_name: `djimit/repo-${i}`, priority_tier: 1 });
    }

    const scheduler = new RepoExplainerScheduler(db, { maxJobs: 10, dailyLlmBudget: 2, dailyGitOpsBudget: 10, dailyGitHubApiBudget: 10 });
    const result = await scheduler.run({ now: new Date("2026-07-31T00:00:00Z") });

    expect(result.scheduled).toBe(0);
    expect(result.skipped_due_to_budget).toBeGreaterThan(0);
  });

  it("claims the highest priority pending job", async () => {
    insertRepo(db, { full_name: "djimit/repo-a", priority_tier: 1 });
    insertRepo(db, { full_name: "djimit/repo-b", priority_tier: 2 });
    const scheduler = new RepoExplainerScheduler(db, { maxJobs: 10 });
    await scheduler.run({ now: new Date("2026-07-31T00:00:00Z") });

    const claimed = scheduler.claimNextJob("worker-1");
    expect(claimed).not.toBeNull();
    expect(claimed?.full_name).toBe("djimit/repo-a");

    const job = db.prepare("SELECT * FROM explainer_jobs WHERE id = ?").get(claimed!.job_id) as any;
    expect(job.status).toBe("running");
    expect(job.worker_id).toBe("worker-1");
  });

  it("completes a job and marks the task completed", async () => {
    insertRepo(db, { full_name: "djimit/repo-a", priority_tier: 1 });
    const scheduler = new RepoExplainerScheduler(db, { maxJobs: 10 });
    await scheduler.run({ now: new Date("2026-07-31T00:00:00Z") });

    const claimed = scheduler.claimNextJob("worker-1")!;
    scheduler.completeJob(claimed.job_id, "completed");

    const job = db.prepare("SELECT * FROM explainer_jobs WHERE id = ?").get(claimed.job_id) as any;
    expect(job.status).toBe("completed");
    const task = db.prepare("SELECT * FROM explainer_tasks WHERE id = ?").get(claimed.task_id) as any;
    expect(task.status).toBe("completed");
  });

  it("does not enqueue duplicate active work", async () => {
    insertRepo(db, { full_name: "djimit/repo-a", priority_tier: 1 });
    const scheduler = new RepoExplainerScheduler(db);

    expect((await scheduler.run()).scheduled).toBe(1);
    expect((await scheduler.run()).scheduled).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM explainer_jobs").get()).toMatchObject({ count: 1 });
  });

  it("persists pause state even for an empty fleet and blocks scheduling", async () => {
    const scheduler = new RepoExplainerScheduler(db);
    scheduler.setPaused(true);
    insertRepo(db, { full_name: "djimit/repo-a" });

    expect(scheduler.isPaused()).toBe(true);
    expect((await scheduler.run()).scheduled).toBe(0);

    scheduler.setPaused(false);
    expect((await scheduler.run()).scheduled).toBe(1);
  });

  it("persists the same estimated costs used for admission", async () => {
    insertRepo(db, { full_name: "djimit/repo-a" });
    const scheduler = new RepoExplainerScheduler(db);
    const result = await scheduler.run({ now: new Date("2026-07-31T00:00:00Z") });
    const job = db.prepare("SELECT * FROM explainer_jobs").get() as any;

    expect(job.estimated_llm_calls).toBe(3);
    expect(result.budget.llm_calls_used).toBe(3);
    expect(result.budget.llm_calls_remaining).toBe(497);
  });

  it("allows only one claim for one pending job", async () => {
    insertRepo(db, { full_name: "djimit/repo-a" });
    const scheduler = new RepoExplainerScheduler(db);
    await scheduler.run();

    expect(scheduler.claimNextJob("worker-1")).not.toBeNull();
    expect(scheduler.claimNextJob("worker-2")).toBeNull();
  });
});
