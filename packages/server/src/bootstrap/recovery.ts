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
  return recoverySvc;
}
