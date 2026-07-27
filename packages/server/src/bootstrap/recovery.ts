/**
 * Database initialization and loop recovery at startup.
 * Extracted from index.ts for separation of concerns.
 */
import { initializeDatabase } from '../database';
import { LoopService } from '../services/loop-service';

export function initDatabase(): ReturnType<typeof initializeDatabase> {
  console.log('📦 Initializing database...');
  return initializeDatabase();
}

export function recoverInterruptedRuns(db: ReturnType<typeof initializeDatabase>): LoopService {
  const recoverySvc = new LoopService(db);
  try {
    const recovery = recoverySvc.recoverInterruptedRuns();
    if (recovery.interruptedRuns || recovery.failedLeases || recovery.prunedWorktrees) {
      console.log(
        `🔄 Recovered ${recovery.interruptedRuns} interrupted run(s), ${recovery.failedLeases} orphaned lease(s), pruned ${recovery.prunedWorktrees} worktree(s).`,
      );
    }
  } catch (error) {
    console.warn('⚠️  Loop recovery failed (non-fatal):', error instanceof Error ? error.message : String(error));
  }
  try {
    const staleEvaluations = recoverStaleOpenMythosRuns(db);
    if (staleEvaluations > 0) {
      console.log(`🔄 Recovered ${staleEvaluations} stale OpenMythos evaluation run(s).`);
    }
  } catch (error) {
    console.warn('⚠️  OpenMythos recovery failed (non-fatal):', error instanceof Error ? error.message : String(error));
  }
  return recoverySvc;
}

export function recoverStaleOpenMythosRuns(db: ReturnType<typeof initializeDatabase>): number {
  return db.prepare(`
    UPDATE openmythos_eval_runs
    SET status = 'failed',
        finished_at = COALESCE(finished_at, datetime('now')),
        metadata = json_set(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.recovery_reason', 'interrupted_stale_run')
    WHERE status = 'running' AND datetime(started_at) < datetime('now', '-6 hours')
  `).run().changes;
}
