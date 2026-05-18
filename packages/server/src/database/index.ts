/**
 * Database initialization and connection
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'fs';
import { schema } from './schema';
import { runMigrations } from './migrate';

// Get the monorepo root (3 levels up from packages/server/src)
const MONOREPO_ROOT = process.cwd().includes('/packages/server')
  ? join(process.cwd(), '../..')
  : process.cwd();

const DATA_DIR = join(MONOREPO_ROOT, '.data');
const DB_PATH = process.env.DB_PATH || join(DATA_DIR, 'djimitflo.sqlite');
const BACKUP_DIR = process.env.BACKUP_DIR || join(DATA_DIR, 'backups');

// Ensure data directory exists only when using the default path
if (!process.env.DB_PATH) {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
} else {
  const dbDir = join(DB_PATH, '..');
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }
}

// Ensure backup directory exists
if (!existsSync(BACKUP_DIR)) {
  mkdirSync(BACKUP_DIR, { recursive: true });
}

let restoreApplied = false;
let restoreMarkerInfo: { actorId?: string; actorEmail?: string; safetyBackupFilename?: string; restoreFrom?: string } | null = null;

function applyStagedRestore(): boolean {
  const restoreMarkerPath = join(BACKUP_DIR, 'restore-pending.json');
  if (!existsSync(restoreMarkerPath)) return false;

  try {
    const marker = JSON.parse(readFileSync(restoreMarkerPath, 'utf-8'));

    if (!marker.stagedDbPath || !marker.targetDbPath) {
      console.error('❌ Invalid restore marker: missing paths');
      try { renameSync(restoreMarkerPath, restoreMarkerPath + '.failed'); } catch {}
      return false;
    }

    const normalizedStaged = marker.stagedDbPath.replace(/\0/g, '');
    const normalizedTarget = marker.targetDbPath.replace(/\0/g, '');

    if (normalizedStaged.includes('..') || normalizedStaged.includes('\\')) {
      console.error('❌ Invalid staged path in restore marker');
      try { renameSync(restoreMarkerPath, restoreMarkerPath + '.failed'); } catch {}
      return false;
    }
    if (normalizedTarget.includes('..') || normalizedTarget.includes('\\')) {
      console.error('❌ Invalid target path in restore marker');
      try { renameSync(restoreMarkerPath, restoreMarkerPath + '.failed'); } catch {}
      return false;
    }

    if (!existsSync(normalizedStaged)) {
      console.error(`❌ Staged DB not found: ${normalizedStaged}`);
      try { renameSync(restoreMarkerPath, restoreMarkerPath + '.failed'); } catch {}
      return false;
    }

    renameSync(normalizedStaged, normalizedTarget);
    unlinkSync(restoreMarkerPath);

    restoreMarkerInfo = marker;
    restoreApplied = true;
    console.log('✅ Restore applied from staged backup');
    if (marker.safetyBackupFilename) {
      console.log(`   Safety backup: ${marker.safetyBackupFilename}`);
    }
    return true;
  } catch (err) {
    console.error('❌ Restore failed, keeping current database:', err);
    try { renameSync(restoreMarkerPath, restoreMarkerPath + '.failed'); } catch {}
    return false;
  }
}

export function initializeDatabase(): Database.Database {
  applyStagedRestore();

  console.log(`📦 Opening database at ${DB_PATH}`);
  
  const db = new Database(DB_PATH, {
    verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
  });
  
  // Enable foreign keys
  db.pragma('foreign_keys = ON');
  
  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  
  // Run schema
  console.log('📋 Applying database schema...');
  db.exec(schema);
  runMigrations(db);
  
  console.log('✅ Database initialized');

  if (restoreApplied && restoreMarkerInfo) {
    try {
      const { AuditEventType } = require('@djimitflo/shared');
      const { AuditService } = require('../services/audit-service');
      const auditService = new AuditService(db);
      auditService.record({
        event_type: AuditEventType.BACKUP_RESTORE_COMPLETED,
        action: 'restore_completed',
        resource_type: 'backup',
        resource_id: restoreMarkerInfo.restoreFrom || 'unknown',
        risk_level: 'high',
        user_id: restoreMarkerInfo.actorId || 'system',
        metadata: {
          safetyBackupFilename: restoreMarkerInfo.safetyBackupFilename,
          actorEmail: restoreMarkerInfo.actorEmail,
        },
      });
      console.log('📝 Restore completion audit event recorded');
    } catch (err) {
      console.error('⚠️  Could not record restore_completed audit event:', err instanceof Error ? err.message : String(err));
    }
    restoreApplied = false;
    restoreMarkerInfo = null;
  }
  
  return db;
}

export { Database, BACKUP_DIR, DB_PATH };