import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { AutonomyRollbackService } from '../services/autonomy-rollback-service';
import { RsiSafetyGuard } from '../services/rsi-safety-guard';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let rollback: AutonomyRollbackService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  const safetyGuard = new RsiSafetyGuard(db);
  rollback = new AutonomyRollbackService(db, safetyGuard);
});

afterEach(() => {
  db?.close();
});

describe('G116: AutonomyRollbackService', () => {
  it('creates snapshot', () => {
    const snapshot = rollback.snapshotBeforeMutation('test-component');
    expect(snapshot.id).toBeDefined();
    expect(snapshot.componentId).toBe('test-component');
  });

  it('rolls back to snapshot', () => {
    const snapshot = rollback.snapshotBeforeMutation('test-component');
    const result = rollback.rollbackToSnapshot(snapshot.id);
    expect(result.success).toBe(true);
  });

  it('fails rollback for unknown snapshot', () => {
    const result = rollback.rollbackToSnapshot('nonexistent');
    expect(result.success).toBe(false);
  });

  it('enforces filesystem freeze', () => {
    expect(rollback.enforceFilesystemFreeze('auth-service')).toBe(true);
    expect(rollback.enforceFilesystemFreeze('loop-service')).toBe(false);
  });

  it('monitors reward integrity', () => {
    const report = rollback.monitorRewardIntegrity();
    expect(report.totalRewards).toBe(0);
    expect(report.driftDetected).toBe(false);
  });

  it('gets snapshots', () => {
    rollback.snapshotBeforeMutation('comp-1');
    rollback.snapshotBeforeMutation('comp-2');
    const snapshots = rollback.getSnapshots();
    expect(snapshots.length).toBe(2);
  });

  it('gets snapshots by component', () => {
    rollback.snapshotBeforeMutation('comp-a');
    const snapshots = rollback.getSnapshots('comp-a');
    expect(snapshots.length).toBe(1);
  });
});
