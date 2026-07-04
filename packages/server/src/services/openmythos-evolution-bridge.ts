/**
 * OpenMythosEvolutionBridge — bridges Python evolve.py goals to Djimitflo LoopService.
 *
 * Runs evolve.py --goal-batch to get evolution tasks from discrimination analysis,
 * then creates corresponding goals in Djimitflo's LoopService for autonomous execution.
 *
 * Rate limited to max 1 sync per 24h to avoid goal flooding.
 */

import { spawn } from 'child_process';
import type { Database } from 'better-sqlite3';

interface EvolutionGoal {
  id: string;
  objective: string;
  risk_class: string;
  target_ref: string;
  acceptance_criteria: string[];
}

interface EvolutionBatch {
  change: string;
  ordered_goals: EvolutionGoal[];
}

export class OpenMythosEvolutionBridge {
  private lastSyncAt: Date | null = null;
  private readonly SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    private db: Database,
    private evolvePyPath: string = '/Users/dlandman/OpenMythos/openmythos-benchmark/scripts/evolve.py',
    private corpusPath: string = '/Users/dlandman/OpenMythos/openmythos-benchmark/cases/corpus.jsonl',
  ) {}

  /**
   * Check if sync is allowed (rate limited).
   */
  canSync(): boolean {
    if (!this.lastSyncAt) return true;
    return Date.now() - this.lastSyncAt.getTime() > this.SYNC_INTERVAL_MS;
  }

  /**
   * Run evolve.py and parse goal batch output.
   */
  async runEvolvePy(): Promise<EvolutionBatch> {
    return new Promise((resolve, reject) => {
      const args = [
        this.evolvePyPath,
        '--corpus', this.corpusPath,
        '--goal-batch', '/tmp/openmythos-goals.json',
        '--demo', // Use demo mode for now; replace with real traces when available
      ];

      const proc = spawn('python3', args, { timeout: 30000 });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data; });
      proc.stderr.on('data', (data) => { stderr += data; });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`evolve.py exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          // Read the generated goal batch file
          const fs = require('fs');
          const raw = fs.readFileSync('/tmp/openmythos-goals.json', 'utf8');
          const batch = JSON.parse(raw) as EvolutionBatch;
          resolve(batch);
        } catch (err) {
          reject(new Error(`Failed to parse evolve.py output: ${err}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to run evolve.py: ${err.message}`));
      });
    });
  }

  /**
   * Sync evolution goals to Djimitflo LoopService.
   * Creates goals in the database for autonomous execution.
   */
  async syncEvolutionGoals(): Promise<number> {
    if (!this.canSync()) {
      return 0;
    }

    const batch = await this.runEvolvePy();
    let created = 0;

    for (const goal of batch.ordered_goals) {
      const existing = this.db.prepare(
        'SELECT id FROM goals WHERE id = ?'
      ).get(goal.id);

      if (!existing) {
        this.db.prepare(`
          INSERT INTO goals (id, description, status, priority, metadata, created_at)
          VALUES (?, ?, 'pending', ?, ?, ?)
        `).run(
          goal.id,
          goal.objective,
          goal.risk_class === 'high' ? 'high' : 'medium',
          JSON.stringify({
            source: 'openmythos-evolution',
            risk_class: goal.risk_class,
            target_ref: goal.target_ref,
            acceptance_criteria: goal.acceptance_criteria,
          }),
          new Date().toISOString(),
        );
        created++;
      }
    }

    this.lastSyncAt = new Date();
    return created;
  }

  /**
   * Get the timestamp of the last sync.
   */
  getLastSyncAt(): Date | null {
    return this.lastSyncAt;
  }

  /**
   * Force sync bypassing rate limit (for manual triggers).
   */
  async forceSync(): Promise<number> {
    this.lastSyncAt = null;
    return this.syncEvolutionGoals();
  }
}
