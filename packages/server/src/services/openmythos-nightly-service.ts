/**
 * OpenMythosNightlyService — scheduled governance evals that fill the leaderboard.
 *
 * Default-off. Arm with:
 *   OPENMYTHOS_NIGHTLY_ENABLED=true
 *   OPENMYTHOS_NIGHTLY_MODELS=llama3.1:8b,qwen2.5:14b-instruct-q4_K_M   (required)
 *   OPENMYTHOS_NIGHTLY_HOUR=3                                           (server-local hour, default 3)
 *   OPENMYTHOS_CORPUS_PATH=...                                          (required by the eval itself)
 *   OPENMYTHOS_ORACLE_ANCHORS_PATH=...                                  (optional; when set, only the
 *                                                                        oracle-anchored subset runs —
 *                                                                        deterministic, ~2-5 min/model)
 *
 * Each subject model gets one run per UTC day under agent id `nightly:<model>`,
 * deduped against openmythos_eval_runs so restarts don't double-run. Models run
 * sequentially to avoid saturating the Ollama host.
 */

import { readFileSync } from 'fs';
import type { Database } from 'better-sqlite3';
import { OpenMythosEvalService } from './openmythos-eval-service';

type EvalRunner = Pick<OpenMythosEvalService, 'runEval'>;

const HOUR_MS = 60 * 60 * 1000;

export class OpenMythosNightlyService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly evalService: EvalRunner;

  constructor(private db: Database, evalService?: EvalRunner) {
    this.evalService = evalService ?? new OpenMythosEvalService(db);
  }

  /** Arm the hourly scheduler. Returns false (no-op) unless explicitly enabled. */
  start(): boolean {
    if (process.env.OPENMYTHOS_NIGHTLY_ENABLED !== 'true') return false;
    if (this.models().length === 0) {
      console.warn('OpenMythos nightly: enabled but OPENMYTHOS_NIGHTLY_MODELS is empty — not arming');
      return false;
    }
    this.timer = setInterval(() => void this.tick(), HOUR_MS);
    this.timer.unref();
    void this.tick(); // catch-up on boot
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  models(): string[] {
    return (process.env.OPENMYTHOS_NIGHTLY_MODELS || '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
  }

  targetHour(): number {
    const hour = Number(process.env.OPENMYTHOS_NIGHTLY_HOUR ?? '3');
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 3;
  }

  /** Oracle-anchored case ids when an anchors file is configured, else undefined (full corpus). */
  anchorCaseIds(): string[] | undefined {
    const path = process.env.OPENMYTHOS_ORACLE_ANCHORS_PATH;
    if (!path) return undefined;
    const payload = JSON.parse(readFileSync(path, 'utf8')) as { anchors?: Array<{ case_id: string }> };
    const ids = (payload.anchors ?? []).map((a) => a.case_id).filter(Boolean);
    return ids.length > 0 ? ids : undefined;
  }

  /** Due when past the target hour and this agent has no running/completed run today (UTC). */
  shouldRun(model: string, now: Date = new Date()): boolean {
    if (now.getHours() < this.targetHour()) return false;
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM openmythos_eval_runs
      WHERE agent_id = ? AND status IN ('running', 'completed')
        AND substr(started_at, 1, 10) = date('now')
    `).get(`nightly:${model}`) as { n: number };
    return row.n === 0;
  }

  /** One scheduler pass: run every due model sequentially; failures don't stop the rest. */
  async tick(now: Date = new Date()): Promise<string[]> {
    const ran: string[] = [];
    const caseIds = this.anchorCaseIds();
    for (const model of this.models()) {
      if (!this.shouldRun(model, now)) continue;
      try {
        const result = await this.evalService.runEval(`nightly:${model}`, undefined, model, caseIds);
        console.log(`OpenMythos nightly: ${model} → ${result.overallScore.toFixed(3)} (${result.completedCases}/${result.totalCases} cases)`);
        ran.push(model);
      } catch (error) {
        console.error(`OpenMythos nightly: ${model} failed —`, error instanceof Error ? error.message : error);
      }
    }
    return ran;
  }
}
