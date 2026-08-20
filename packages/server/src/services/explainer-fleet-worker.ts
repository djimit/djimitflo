import type { Database } from "better-sqlite3";
import { ExplainerGenerationService } from "./explainer-generation-service";
import { RepoExplainerScheduler } from "./repo-explainer-scheduler";

export class ExplainerFleetWorker {
  readonly serviceName = "ExplainerFleetWorker";
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly scheduler: RepoExplainerScheduler,
    private readonly generation: ExplainerGenerationService,
    private readonly intervalMs = Number(process.env.DJIMITFLO_EXPLAINER_WORKER_INTERVAL_MS) || 30_000,
  ) {}

  static create(db: Database): ExplainerFleetWorker {
    return new ExplainerFleetWorker(new RepoExplainerScheduler(db), new ExplainerGenerationService(db));
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
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
      await this.generation.runPipeline(job.task_id);
      this.scheduler.completeJob(job.job_id, "completed");
    } catch (error) {
      this.scheduler.completeJob(job.job_id, "failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
    }
    return true;
  }
}
