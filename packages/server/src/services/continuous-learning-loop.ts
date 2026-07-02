import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { MemoryCurator } from './memory-curator';
import { ReflectionEngine } from './reflection-engine';
import { AutonomousGoalGenerator } from './autonomous-goal-generator';

export interface LearningCycleResult {
  id: string;
  timestamp: string;
  episodesIngested: number;
  reflectionsGenerated: number;
  patternsDetected: number;
  goalsGenerated: number;
  durationMs: number;
}

export class ContinuousLearningLoop {
  private curator: MemoryCurator;
  private reflections: ReflectionEngine;
  private goals: AutonomousGoalGenerator;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCycle: string | null = null;

  constructor(
    private db: Database,
    options: { intervalMs?: number } = {},
  ) {
    this.curator = new MemoryCurator(db);
    this.reflections = new ReflectionEngine(db);
    this.goals = new AutonomousGoalGenerator(db);
    this.intervalMs = options.intervalMs ?? 3600_000;
    this.db.exec("CREATE TABLE IF NOT EXISTS learning_cycles (id TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval((): void => { this.runCycle().catch((): void => {}); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async runCycle(): Promise<LearningCycleResult> {
    const start = Date.now();
    const id = randomUUID();

    const pendingEpisodes = this.collectPendingEpisodes();
    let episodesIngested = 0;
    for (const episode of pendingEpisodes) {
      this.curator.curate(episode);
      episodesIngested++;
    }

    const recentRuns = this.db.prepare("SELECT id FROM loop_runs WHERE status = 'completed' AND created_at > ? ORDER BY created_at DESC LIMIT 10").all(this.lastCycle ?? '1970-01-01') as Array<{ id: string }>;
    let reflectionsGenerated = 0;
    for (const run of recentRuns) {
      this.reflections.reflectOnRun(run.id);
      reflectionsGenerated++;
    }

    const patternReport = this.reflections.analyzeReflectionPatterns(50);
    const generatedGoals = this.goals.generateAll();

    const result: LearningCycleResult = {
      id,
      timestamp: new Date().toISOString(),
      episodesIngested,
      reflectionsGenerated,
      patternsDetected: patternReport.recurringPatterns.length,
      goalsGenerated: generatedGoals.total,
      durationMs: Date.now() - start,
    };

    this.db.prepare('INSERT INTO learning_cycles (id, result_json) VALUES (?, ?)').run(id, JSON.stringify(result));
    this.lastCycle = result.timestamp;

    return result;
  }

  getHistory(limit: number = 20): LearningCycleResult[] {
    const rows = this.db.prepare('SELECT result_json FROM learning_cycles ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ result_json: string }>;
    return rows.map(r => JSON.parse(r.result_json) as LearningCycleResult);
  }

  getLastCycle(): LearningCycleResult | null {
    const row = this.db.prepare('SELECT result_json FROM learning_cycles ORDER BY created_at DESC LIMIT 1').get() as { result_json: string } | undefined;
    return row ? JSON.parse(row.result_json) as LearningCycleResult : null;
  }

  private collectPendingEpisodes(): Array<{ id: string; type: string; content: string; source: string; timestamp: string }> {
    const episodes: Array<{ id: string; type: string; content: string; source: string; timestamp: string }> = [];
    try {
      const runs = this.db.prepare("SELECT id, loop_name, status, created_at FROM loop_runs WHERE created_at > ? AND status = 'completed' ORDER BY created_at DESC LIMIT 5").all(this.lastCycle ?? '1970-01-01') as Array<{ id: string; loop_name: string; status: string; created_at: string }>;
      for (const run of runs) {
        episodes.push({ id: `episode-${run.id}`, type: 'episode', content: `Completed ${run.loop_name}`, source: 'loop-daemon', timestamp: run.created_at });
      }
    } catch { /* best-effort */ }
    return episodes;
  }
}
