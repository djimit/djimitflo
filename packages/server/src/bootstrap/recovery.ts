/**
 * Database initialization and loop recovery at startup.
 * Extracted from index.ts for separation of concerns.
 */
import { initializeDatabase } from '../database';
import { LoopService } from '../services/loop-service';
import type { Database } from 'better-sqlite3';

export function initDatabase(): ReturnType<typeof initializeDatabase> {
  console.log('📦 Initializing database...');
  return initializeDatabase();
}

export function recoverInterruptedOpenMythosRuns(db: Database): number {
  const finishedAt = new Date().toISOString();
  return db.prepare(`
    UPDATE openmythos_eval_runs
    SET status = 'failed', finished_at = ?, metadata = json_set(COALESCE(metadata, '{}'), '$.interrupted_reason', 'server_restart', '$.interrupted_at', ?)
    WHERE status = 'running'
  `).run(finishedAt, finishedAt).changes;
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
    const interruptedEvals = recoverInterruptedOpenMythosRuns(db);
    if (interruptedEvals) console.log(`🔄 Recovered ${interruptedEvals} interrupted OpenMythos evaluation(s).`);
  } catch (error) {
    console.warn('⚠️  OpenMythos recovery failed (non-fatal):', error instanceof Error ? error.message : String(error));
  }
  return recoverySvc;
}
