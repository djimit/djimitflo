import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BackupService } from '../services/backup-service';
import { AuditService } from '../services/audit-service';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AuditEventType } from '@djimitflo/shared';
import tmp from 'os';

const TEST_DIR = join(__dirname, '../../.data/test-backup-int');
const TEST_DB_PATH = join(TEST_DIR, 'test.sqlite');
const TEST_BACKUP_DIR = join(TEST_DIR, 'backups');

let db: Database.Database;
let auditService: AuditService;
let backupService: BackupService;

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret-for-backup-tests';
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_BACKUP_DIR, { recursive: true });
  db = new Database(TEST_DB_PATH) as unknown as Database.Database;
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db as any);
  auditService = new AuditService(db as any);
  backupService = new BackupService(db as any, TEST_BACKUP_DIR, auditService);
});

afterEach(() => {
  db.close();
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  delete process.env.JWT_SECRET;
});

describe('BackupService', () => {
  describe('createBackup', () => {
    it('creates a valid backup artifact', async () => {
      const result = await backupService.createBackup({ actorId: 'test-user', actorEmail: 'test@example.com' });

      expect(result.filename).toMatch(/^backup-\d{8}-\d{6}\.tar\.gz$/);
      expect(result.manifest.backupVersion).toBe('1.0');
      expect(result.manifest.appVersion).toBe('0.5.6');
      expect(result.manifest.tableCounts).toBeDefined();
      expect(result.manifest.databaseSha256).toBeDefined();
      expect(result.manifest.warnings).toContain('This backup contains password hashes and governance evidence. Treat as confidential.');
      expect(result.sizeBytes).toBeGreaterThan(0);

      const filePath = join(TEST_BACKUP_DIR, result.filename);
      expect(existsSync(filePath)).toBe(true);
    });

    it('includes correct table counts in manifest', async () => {
      const result = await backupService.createBackup();
      const counts = result.manifest.tableCounts;

      expect(counts).toBeDefined();
      expect(Object.keys(counts).length).toBeGreaterThan(0);

      const sqliteInternal = Object.keys(counts).filter(k => k.startsWith('sqlite_'));
      expect(sqliteInternal.length).toBe(0);
    });

    it('records a backup.created audit event', async () => {
      await backupService.createBackup({ actorId: 'test-user' });

      const events = (db as any).prepare('SELECT * FROM audit_events WHERE event_type = ?').all(AuditEventType.BACKUP_CREATED);
      expect(events.length).toBe(1);
      expect(events[0].action).toBe('backup_created');
      expect(events[0].resource_type).toBe('backup');
    });
  });

  describe('listBackups', () => {
    it('lists created backups', async () => {
      await backupService.createBackup();
      const backups = backupService.listBackups();
      expect(backups.length).toBe(1);
      expect(backups[0].filename).toMatch(/^backup-\d{8}-\d{6}\.tar\.gz$/);
    });

    it('does not list restore-pending.json or other files', async () => {
      await backupService.createBackup();
      writeFileSync(join(TEST_BACKUP_DIR, 'restore-pending.json'), '{}');

      const backups = backupService.listBackups();
      expect(backups.length).toBe(1);
    });
  });

  describe('getBackupMetadata', () => {
    it('returns metadata for a specific backup', async () => {
      const result = await backupService.createBackup();
      const metadata = backupService.getBackupMetadata(result.filename);

      expect(metadata).not.toBeNull();
      expect(metadata!.filename).toBe(result.filename);
      expect(metadata!.manifest.appVersion).toBe('0.5.6');
    });

    it('returns null for nonexistent backup', () => {
      const metadata = backupService.getBackupMetadata('backup-nonexistent.tar.gz');
      expect(metadata).toBeNull();
    });
  });

  describe('validateBackup', () => {
    it('succeeds for a valid backup', async () => {
      const result = await backupService.createBackup();
      const validation = await backupService.validateBackup(result.filename);
      expect(validation.valid).toBe(true);
      expect(validation.errors.length).toBe(0);
      expect(validation.manifest).toBeDefined();
      expect(validation.integrityCheck).toBe('ok');
    });

    it('records a backup.validated audit event', async () => {
      const result = await backupService.createBackup();
      await backupService.validateBackup(result.filename);

      const events = (db as any).prepare('SELECT * FROM audit_events WHERE event_type = ?').all(AuditEventType.BACKUP_VALIDATED);
      expect(events.length).toBe(1);
    });

    it('rejects path traversal in filename', async () => {
      const validation = await backupService.validateBackup('../../../etc/passwd');
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Invalid backup filename');
    });
  });

  describe('filename validation', () => {
    it('accepts valid backup filenames', () => {
      expect(backupService.validateFilename('backup-20260518-200000.tar.gz')).toBe(true);
    });

    it('rejects filenames with slashes', () => {
      expect(backupService.validateFilename('dir/backup-20260518-200000.tar.gz')).toBe(false);
    });

    it('rejects filenames with double dots', () => {
      expect(backupService.validateFilename('../backup-20260518-200000.tar.gz')).toBe(false);
    });

    it('rejects filenames with backslashes', () => {
      expect(backupService.validateFilename('backup\\20260518-200000.tar.gz')).toBe(false);
    });

    it('rejects arbitrary filenames', () => {
      expect(backupService.validateFilename('arbitrary.txt')).toBe(false);
      expect(backupService.validateFilename('')).toBe(false);
    });
  });

  describe('stageRestore', () => {
    it('requires confirm: RESTORE', async () => {
      const result = await backupService.createBackup();
      await expect(
        backupService.stageRestore(result.filename, { confirm: 'no', actorId: 'test' })
      ).rejects.toThrow('explicit confirmation');
    });

    it('creates pre-restore safety backup', async () => {
      const result = await backupService.createBackup();
      const restoreResult = await backupService.stageRestore(result.filename, {
        confirm: 'RESTORE',
        actorId: 'test-user',
        actorEmail: 'test@example.com',
      });

      expect(restoreResult.restartRequired).toBe(true);
      expect(restoreResult.safetyBackupFilename).toMatch(/^backup-/);

      const safetyBackup = backupService.listBackups().find(b => b.filename === restoreResult.safetyBackupFilename);
      expect(safetyBackup).toBeDefined();
    });

    it('creates restore-pending marker', async () => {
      const result = await backupService.createBackup();
      await backupService.stageRestore(result.filename, { confirm: 'RESTORE', actorId: 'test-user' });

      const markerPath = join(TEST_BACKUP_DIR, 'restore-pending.json');
      expect(existsSync(markerPath)).toBe(true);

      const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
      expect(marker.stagedDbPath).toContain('.restore-pending');
      expect(marker.targetDbPath).toBeDefined();
      expect(marker.actorId).toBe('test-user');
    });

    it('returns restartRequired: true', async () => {
      const result = await backupService.createBackup();
      const restoreResult = await backupService.stageRestore(result.filename, {
        confirm: 'RESTORE',
        actorId: 'test-user',
      });

      expect(restoreResult.restartRequired).toBe(true);
      expect(restoreResult.message).toContain('Restart');
    });

    it('records audit events for restore_started and pre_restore_created', async () => {
      const result = await backupService.createBackup();
      await backupService.stageRestore(result.filename, { confirm: 'RESTORE', actorId: 'test-user' });

      const restoreStarted = (db as any).prepare('SELECT * FROM audit_events WHERE event_type = ?').all(AuditEventType.BACKUP_RESTORE_STARTED);
      expect(restoreStarted.length).toBeGreaterThanOrEqual(1);

      const preRestore = (db as any).prepare('SELECT * FROM audit_events WHERE event_type = ?').all(AuditEventType.BACKUP_PRE_RESTORE_CREATED);
      expect(preRestore.length).toBeGreaterThanOrEqual(1);
    });

    it('does not overwrite the active database file', async () => {
      const result = await backupService.createBackup();
      await backupService.stageRestore(result.filename, { confirm: 'RESTORE', actorId: 'test-user' });

      const tables = (db as any).prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      expect(tables.length).toBeGreaterThan(0);
    });
  });

  describe('download filename validation', () => {
    it('rejects path traversal in download', () => {
      const result = backupService.downloadBackup('../../../etc/passwd');
      expect(result).toBeNull();
    });

    it('rejects nonexistent files in download', () => {
      const result = backupService.downloadBackup('backup-99999999-999999.tar.gz');
      expect(result).toBeNull();
    });
  });
});