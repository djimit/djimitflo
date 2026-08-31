import type { Database } from "better-sqlite3";
import { ExplainerGenerationService } from "./explainer-generation-service";
import { RepoExplainerScheduler } from "./repo-explainer-scheduler";
import { ExplainerKnowledgeService } from "./explainer-knowledge-service";

const UAMS_URL = process.env.UAMS_URL || "http://100.77.58.72:8000";

/**
 * Test-isolation guard: unit tests must never write to the real UAMS memory
 * store (same rationale as the embedChunks NODE_ENV guard).
 */
function isTestEnv(): boolean {
  return process.env.NODE_ENV === "test";
}

/** Publish a drift alert to UAMS so the agent fleet can react (non-blocking). */
async function publishDriftAlert(drift: string[]): Promise<void> {
  if (isTestEnv()) return;
  const content = `Djimit fleet drift alert (${drift.length} items): ${drift.slice(0, 10).join("; ")}`;
  try {
    await fetch(`${UAMS_URL}/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: content.slice(0, 2000),
        tags: ["explainer_drift_alert", "djimitflo-explainer", `count:${drift.length}`],
      }),
    });
  } catch {
    // non-fatal by design
  }
}

/**
 * Publish a concise explainer-memory record to UAMS after a bundle publishes.
 * Non-blocking: memory sync failure never fails the worker tick.
 */
async function publishExplainerMemory(bundleId: string, repoFullName: string, score: number | null): Promise<void> {
  if (isTestEnv()) return;
  const content = `Explainer published for ${repoFullName}: OpenMythos score ${score ?? "n/a"}, bundle ${bundleId}. Auto-generated repo knowledge available via Djimit Explore.`;
  try {
    const res = await fetch(`${UAMS_URL}/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: content.slice(0, 2000),
        tags: [`repo:${repoFullName}`, "explainer_published", `bundle:${bundleId}`, "djimitflo-explainer"],
      }),
    });
    if (res.ok) {
      console.log(`🧠 Explainer memory published → UAMS: ${repoFullName}`);
    } else {
      console.warn(`UAMS explainer publish failed ${res.status} for ${repoFullName}`);
    }
  } catch (error) {
    console.warn("UAMS explainer publish error (non-fatal):", error instanceof Error ? error.message : String(error));
  }
}

export class ExplainerFleetWorker {
  readonly serviceName = "ExplainerFleetWorker";
  private timer?: NodeJS.Timeout;
  private driftTimer?: NodeJS.Timeout;
  private driftChecking = false;
  private running = false;
  private knowledge: ExplainerKnowledgeService;

  constructor(
    private readonly scheduler: RepoExplainerScheduler,
    private readonly generation: ExplainerGenerationService,
    private readonly db: Database,
    private readonly intervalMs = Number(process.env.DJIMITFLO_EXPLAINER_WORKER_INTERVAL_MS) || 30_000,
  ) {
    this.knowledge = new ExplainerKnowledgeService(db);
  }

  static create(db: Database): ExplainerFleetWorker {
    return new ExplainerFleetWorker(new RepoExplainerScheduler(db), new ExplainerGenerationService(db), db);
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    // Autonomous drift check every ~10 minutes (aligned with scheduler pace)
    if (!this.driftTimer) {
      this.driftTimer = setInterval(() => void this.checkDrift(), Math.max(this.intervalMs * 20, 600_000));
      this.driftTimer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.driftTimer) clearInterval(this.driftTimer);
    this.timer = undefined;
    this.driftTimer = undefined;
  }

  /**
   * Autonomous OODA observe→orient→act: compute fleet drift (stale bundles,
   * score regressions, never-published repos) and alert UAMS. Runs on its own
   * slow timer so it never delays job processing; failures are non-fatal.
   */
  private async checkDrift(): Promise<void> {
    if (this.driftChecking || this.scheduler.isPaused()) return;
    this.driftChecking = true;
    try {
      const now = Date.now();
      const staleDays = Number(process.env.DJIMITFLO_STALENESS_DAYS) || 15;
      const rows = this.db.prepare(
        `SELECT COALESCE(dr.full_name, t.remote_url) AS full_name,
                b.id AS bundle_id, b.openmythos_score, b.status, b.created_at
         FROM explainer_bundles b
         JOIN explainer_tasks t ON t.id = b.task_id
         LEFT JOIN discovered_repositories dr ON dr.id = t.discovered_repository_id
         WHERE dr.full_name IS NOT NULL
         ORDER BY dr.full_name, b.created_at DESC`,
      ).all() as any[];
      const perRepo = new Map<string, { latest: any; previous_score: number | null }>();
      for (const row of rows) {
        const entry = perRepo.get(row.full_name) ?? { latest: null, previous_score: null };
        if (row.status === "published") {
          if (!entry.latest) entry.latest = row;
          else if (entry.previous_score === null) entry.previous_score = row.openmythos_score;
        }
        perRepo.set(row.full_name, entry);
      }
      const drift: string[] = [];
      for (const [fullName, entry] of perRepo) {
        if (!entry.latest) { drift.push(`never_published: ${fullName}`); continue; }
        const ageDays = (now - new Date(entry.latest.created_at).getTime()) / 86_400_000;
        if (ageDays > staleDays) drift.push(`stale(${Math.round(ageDays)}d): ${fullName}`);
        if (entry.previous_score !== null && entry.latest.openmythos_score !== null && entry.previous_score - entry.latest.openmythos_score >= 15) {
          drift.push(`score_regression(${Math.round(entry.previous_score)}→${Math.round(entry.latest.openmythos_score)}): ${fullName}`);
        }
      }
      if (drift.length > 0) {
        // Act: alert UAMS (append-only memory; drift details in the content)
        await publishDriftAlert(drift).catch(() => undefined);
        console.log(`⚠️  Fleet drift detected (${drift.length}): ${drift.slice(0, 3).join("; ")}`);
      }
    } catch (error) {
      // drift check is observability — never fatal
    } finally {
      this.driftChecking = false;
    }
  }

  async tick(): Promise<boolean> {
    if (this.running || this.scheduler.isPaused()) return false;
    this.running = true;
    const workerId = `explainer-${process.pid}`;
    const job = this.scheduler.claimNextJob(workerId);
    if (!job) {
      this.running = false;
      return false;
    }

    try {
      const bundleId = await this.generation.runPipeline(job.task_id);
      this.scheduler.completeJob(job.job_id, "completed");
      // Post-publish actions (all non-blocking)
      const bundleRow = this.db.prepare("SELECT openmythos_score, status, markdown_path FROM explainer_bundles WHERE id = ?").get(bundleId) as any;
      const published = bundleRow?.status === "published";
      if (published) {
        const task = this.db.prepare("SELECT remote_url FROM explainer_tasks WHERE id = ?").get(job.task_id) as any;
        const fullName = String(task?.remote_url ?? "").replace("https://github.com/", "").replace(/\.git$/, "");
        void publishExplainerMemory(bundleId, fullName, bundleRow?.openmythos_score ?? null);
      }
      // Auto knowledge-sync: chunk + embed ONLY when the bundle actually published —
      // human_review content must stay unsearchable until approved (Codex P1).
      if (published) {
        try {
          const chunks = this.knowledge.chunkBundle(bundleId);
          const { embedded, semantic } = await this.knowledge.embedChunks(chunks);
          if (embedded > 0) console.log(`📖 Knowledge synced post-publish: ${embedded} chunks (semantic: ${semantic}) for bundle ${bundleId}`);
        } catch (error) {
          console.warn("Post-publish knowledge sync failed (non-fatal):", error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      this.scheduler.completeJob(job.job_id, "failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
    }
    return true;
  }
}
