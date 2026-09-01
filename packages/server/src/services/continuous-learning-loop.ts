import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { MemoryCurator } from './memory-curator';
import { ReflectionEngine } from './reflection-engine';
import { AutonomousGoalGenerator } from './autonomous-goal-generator';
import { TrajectoryStore } from './trajectory-store';
import { SelfEvolvingGovernanceLoop } from './self-evolving-governance-loop';
import { SelfImprovementService } from './self-improvement-service';
import { config as envConfig } from '../config/env';

export interface LearningCycleResult {
  id: string; timestamp: string; episodesIngested: number;
  reflectionsGenerated: number; patternsDetected: number;
  proposalsGenerated: number; goalsGenerated: number; durationMs: number;
  producer: 'continuous-learning-loop'; schemaVersion: 1;
}

export class ContinuousLearningLoop {
  private curator: MemoryCurator;
  private reflections: ReflectionEngine;
  private goals: AutonomousGoalGenerator;
  private improvements: SelfImprovementService;
  private _trajectories?: TrajectoryStore;
  private segml?: SelfEvolvingGovernanceLoop;
  private segmlTimer: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  setTrajectoryStore(store: TrajectoryStore): void {
    this._trajectories = store;
  }

  constructor(private db: Database, options: { intervalMs?: number } = {}) {
    this.curator = new MemoryCurator(db);
    this.reflections = new ReflectionEngine(db);
    this.goals = new AutonomousGoalGenerator(db);
    this.improvements = new SelfImprovementService(db);
    this.intervalMs = options.intervalMs ?? 3600_000;
    this.db.exec("CREATE TABLE IF NOT EXISTS learning_cycles (id TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval((): void => { this.runCycle().catch((): void => {}); }, this.intervalMs);
    this.segml = new SelfEvolvingGovernanceLoop(this.db);
    this.segmlTimer = setInterval((): void => {
      this.segml?.runCycle('auto').catch((): void => {});
    }, envConfig.SEGML_CYCLE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.segmlTimer) { clearInterval(this.segmlTimer); this.segmlTimer = null; }
  }

  async runCycle(): Promise<LearningCycleResult> {
    const start = Date.now();
    const id = randomUUID();
    const pendingEpisodes = this.collectPendingEpisodes();
    let episodesIngested = 0;
    for (const episode of pendingEpisodes) { this.curator.curate(episode); episodesIngested++; }
    const recentRuns = this.getUnlearnedCompletedRuns(10);
    let reflectionsGenerated = 0;
    let proposalsGenerated = 0;
    for (const run of recentRuns) {
      const reflection = this.reflections.reflectOnRun(run.id);
      reflectionsGenerated++;
      proposalsGenerated += this.improvements.generateFromReflection({
        ...reflection,
        reflectionId: reflection.id,
      }).length;
    }
    const patternReport = this.reflections.analyzeReflectionPatterns(50);
    const goalsGenerated = this.goals.generateFromSelfImprovements();
    const result: LearningCycleResult = {
      id,
      timestamp: new Date().toISOString(),
      episodesIngested,
      reflectionsGenerated,
      patternsDetected: patternReport.recurringPatterns.length,
      proposalsGenerated,
      goalsGenerated,
      durationMs: Date.now() - start,
      producer: 'continuous-learning-loop',
      schemaVersion: 1,
    };
    this.db.prepare('INSERT INTO learning_cycles (id, result_json) VALUES (?, ?)').run(id, JSON.stringify(result));
    return result;
  }

  getHistory(limit: number = 20): LearningCycleResult[] {
    const rows = this.db.prepare(`
      SELECT result_json FROM learning_cycles
      WHERE json_extract(result_json, '$.producer') = 'continuous-learning-loop'
        AND json_extract(result_json, '$.schemaVersion') = 1
      ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Array<{ result_json: string }>;
    return rows.map(r => JSON.parse(r.result_json) as LearningCycleResult);
  }

  getLastCycle(): LearningCycleResult | null {
    const row = this.db.prepare(`
      SELECT result_json FROM learning_cycles
      WHERE json_extract(result_json, '$.producer') = 'continuous-learning-loop'
        AND json_extract(result_json, '$.schemaVersion') = 1
      ORDER BY created_at DESC LIMIT 1
    `).get() as { result_json: string } | undefined;
    return row ? JSON.parse(row.result_json) as LearningCycleResult : null;
  }

  private collectPendingEpisodes(): Array<{ id: string; type: string; content: string; source: string; timestamp: string }> {
    const episodes: Array<{ id: string; type: string; content: string; source: string; timestamp: string }> = [];
    try {
      const runs = this.getUnlearnedCompletedRuns(5);
      for (const run of runs) {
        let content = 'Completed ' + run.loop_name;
        // Enrich with trajectory summary when available
        if (this._trajectories) {
          const summary = this._trajectories.getTrajectorySummary(run.id);
          if (summary && !summary.startsWith('_No trajectory')) {
            content += ' | trajectory: ' + summary;
          }
        }
        episodes.push({ id: 'episode-' + run.id, type: 'episode', content, source: 'loop-daemon', timestamp: run.created_at });
      }
    } catch { /* ok */ }
    return episodes;
  }

  private getUnlearnedCompletedRuns(limit: number): Array<{ id: string; loop_name: string; status: string; created_at: string }> {
    return this.db.prepare(`
      SELECT lr.id, lr.loop_name, lr.status, lr.created_at
      FROM loop_runs lr
      WHERE lr.status = 'completed'
        AND EXISTS (
          SELECT 1 FROM worker_leases wl
          WHERE wl.loop_run_id = lr.id AND wl.role = 'maker' AND wl.status = 'completed'
        )
        AND NOT EXISTS (SELECT 1 FROM reflections r WHERE r.loop_run_id = lr.id)
      ORDER BY COALESCE(lr.completed_at, lr.updated_at, lr.created_at) DESC
      LIMIT ?
    `).all(limit) as Array<{ id: string; loop_name: string; status: string; created_at: string }>;
  }
}
