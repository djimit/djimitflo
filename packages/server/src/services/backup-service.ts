import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, createReadStream, rmSync } from 'fs';
import { join, basename } from 'path';
import { createGzip, createGunzip } from 'zlib';
import * as tar from 'tar-stream';
import { AuditService } from './audit-service';
import { AuditEventType, RiskLevel } from '@djimitflo/shared';
import { getAppVersion } from '../utils/version';

const BACKUP_FILENAME_REGEX = /^backup-\d{8}-\d{6}\.tar\.gz$/;
const MAX_MANIFEST_SIZE = 64 * 1024;
const EXPECTED_ENTRIES = ['manifest.json', 'djimitflo.sqlite', 'checksums.sha256'];

export interface BackupManifest {
  backupVersion: string;
  appVersion: string;
  createdAt: string;
  databasePath: string;
  tableCounts: Record<string, number>;
  totalTables: number;
  databaseSizeBytes: number;
  databaseSha256: string;
  createdBy: string;
  hostname: string;
  notes: string[];
  warnings: string[];
}

export interface BackupResult {
  filename: string;
  manifest: BackupManifest;
  sizeBytes: number;
}

export interface BackupMetadata {
  filename: string;
  manifest: BackupManifest;
  sizeBytes: number;
  createdAt: Date;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  manifest?: BackupManifest;
  integrityCheck?: string;
}

export interface RestoreResult {
  restartRequired: boolean;
  safetyBackupFilename: string;
  stagedDbPath: string;
  message: string;
}

const MANIFEST_WARNINGS = [
  'This backup contains password hashes and governance evidence. Treat as confidential.',
  'Environment secrets (JWT_SECRET, etc.) are NOT included. Store separately.',
  'Repository working trees are NOT included.',
];

export class BackupService {
  private backupDir: string;
  private dbPath: string;

  constructor(
    private db: Database.Database,
    backupDir: string,
    private auditService: AuditService,
  ) {
    this.backupDir = backupDir;
    this.dbPath = (db as any).name || ':memory:';
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { recursive: true });
    }
  }

  async createBackup(options?: { notes?: string; actorId?: string; actorEmail?: string }): Promise<BackupResult> {
    const now = new Date();
    const ts = now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '-' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');
    const filename = `backup-${ts}.tar.gz`;
    const backupFilePath = join(this.backupDir, filename);
    const tempDir = join(this.backupDir, `.tmp-${ts}`);

    try {
      mkdirSync(tempDir, { recursive: true });

      const sqliteCopyPath = join(tempDir, 'djimitflo.sqlite');
      await this.createSqliteBackup(sqliteCopyPath);

      const databaseSha256 = await this.computeFileHash(sqliteCopyPath);
      const databaseSizeBytes = statSync(sqliteCopyPath).size;
      const tableCounts = this.getTableCounts();
      const totalTables = Object.keys(tableCounts).length;

      const manifest: BackupManifest = {
        backupVersion: '1.0',
        appVersion: getAppVersion(),
        createdAt: new Date().toISOString(),
        databasePath: this.dbPath,
        tableCounts,
        totalTables,
        databaseSizeBytes,
        databaseSha256,
        createdBy: options?.actorEmail || options?.actorId || 'system',
        hostname: process.env.HOSTNAME || require('os').hostname(),
        notes: options?.notes ? [options.notes] : [],
        warnings: [...MANIFEST_WARNINGS],
      };

      const manifestPath = join(tempDir, 'manifest.json');
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

      const checksums = this.computeChecksums(manifestPath, sqliteCopyPath);
      const checksumsPath = join(tempDir, 'checksums.sha256');
      writeFileSync(checksumsPath, checksums, 'utf-8');

      await this.packTarGz(backupFilePath, tempDir, EXPECTED_ENTRIES);

      const manifestJsonPath = join(this.backupDir, `${filename}.manifest.json`);
      writeFileSync(manifestJsonPath, JSON.stringify(manifest, null, 2), 'utf-8');

      const sizeBytes = statSync(backupFilePath).size;

      this.auditService.record({
        event_type: AuditEventType.BACKUP_CREATED,
        action: 'backup_created',
        resource_type: 'backup',
        resource_id: filename,
        risk_level: RiskLevel.LOW,
        user_id: options?.actorId || 'system',
        metadata: { filename, sizeBytes, totalTables, databaseSha256, actorEmail: options?.actorEmail },
      });

      return { filename, manifest, sizeBytes };
    } finally {
      this.cleanupTempDir(tempDir);
    }
  }

  listBackups(): BackupMetadata[] {
    if (!existsSync(this.backupDir)) return [];

    return readdirSync(this.backupDir)
      .filter(name => BACKUP_FILENAME_REGEX.test(name))
      .map(filename => {
        try {
          return this.getBackupMetadata(filename);
        } catch {
          return null;
        }
      })
      .filter((m): m is BackupMetadata => m !== null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  getBackupMetadata(filename: string): BackupMetadata | null {
    if (!this.validateFilename(filename)) return null;

    const filePath = join(this.backupDir, filename);
    if (!existsSync(filePath)) return null;

    try {
      const manifestPath = join(this.backupDir, `${filename}.manifest.json`);
      if (!existsSync(manifestPath)) return null;

      const manifest: BackupManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

      return {
        filename,
        manifest,
        sizeBytes: statSync(filePath).size,
        createdAt: new Date(manifest.createdAt),
      };
    } catch {
      return null;
    }
  }

  async validateBackup(filename: string): Promise<ValidationResult> {
    const errors: string[] = [];

    if (!this.validateFilename(filename)) {
      return { valid: false, errors: ['Invalid backup filename'] };
    }

    const filePath = join(this.backupDir, filename);
    if (!existsSync(filePath)) {
      return { valid: false, errors: ['Backup file not found'] };
    }

    let tempDir = '';
    try {
      tempDir = join(this.backupDir, `.validate-${randomUUID()}`);
      mkdirSync(tempDir, { recursive: true });

      const extracted = await this.extractTarGzSafe(filePath, tempDir);

      const checksumsPath = join(tempDir, 'checksums.sha256');
      if (!extracted.has('checksums.sha256')) {
        errors.push('Missing checksums.sha256');
      } else {
        const expectedChecksums = readFileSync(checksumsPath, 'utf-8');
        const actualManifestChecksum = await this.computeFileHash(join(tempDir, 'manifest.json'));
        const actualSqliteChecksum = await this.computeFileHash(join(tempDir, 'djimitflo.sqlite'));

        const expectedManifestLine = expectedChecksums.split('\n').find(l => l.includes('manifest.json'));
        const expectedSqliteLine = expectedChecksums.split('\n').find(l => l.includes('djimitflo.sqlite'));

        if (expectedManifestLine) {
          const expectedHash = expectedManifestLine.split(/\s+/)[0];
          if (actualManifestChecksum !== expectedHash) errors.push('Manifest checksum mismatch');
        }
        if (expectedSqliteLine) {
          const expectedHash = expectedSqliteLine.split(/\s+/)[0];
          if (actualSqliteChecksum !== expectedHash) errors.push('Database checksum mismatch');
        }
      }

      const manifestPath = join(tempDir, 'manifest.json');
      let manifest: BackupManifest | undefined;
      if (extracted.has('manifest.json')) {
        try {
          const manifestContent = readFileSync(manifestPath, 'utf-8');
          if (manifestContent.length > MAX_MANIFEST_SIZE) {
            errors.push('Manifest exceeds maximum size');
          } else {
            manifest = JSON.parse(manifestContent);
          }
        } catch {
          errors.push('Failed to parse manifest.json');
        }
      } else {
        errors.push('Missing manifest.json');
      }

      if (!extracted.has('djimitflo.sqlite')) {
        errors.push('Missing djimitflo.sqlite');
      }

      if (manifest) {
        const dbVersion = manifest.appVersion?.split('.')[0];
        const currentVersion = getAppVersion().split('.')[0];
        if (dbVersion && currentVersion && dbVersion !== currentVersion) {
          errors.push(`App version mismatch: backup=${manifest.appVersion}, current=${getAppVersion()}`);
        }

        if (manifest.databaseSha256) {
          const actualChecksum = await this.computeFileHash(join(tempDir, 'djimitflo.sqlite'));
          if (actualChecksum !== manifest.databaseSha256) {
            errors.push('Database SHA-256 in manifest does not match actual file');
          }
        }
      }

      if (extracted.has('djimitflo.sqlite') && errors.length === 0) {
        let validateDb: any;
        try {
          const BetterSqlite3 = require('better-sqlite3');
          validateDb = new BetterSqlite3(join(tempDir, 'djimitflo.sqlite'), { readonly: true });
          const result = validateDb.pragma('integrity_check');
          const integrityOk = Array.isArray(result) && result.length === 1 && result[0].integrity_check === 'ok';
          if (!integrityOk) {
            errors.push('Database integrity check failed');
          }
        } catch (err) {
          errors.push(`Database integrity check error: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          if (validateDb) validateDb.close();
        }
      }

      this.auditService.record({
        event_type: AuditEventType.BACKUP_VALIDATED,
        action: 'backup_validated',
        resource_type: 'backup',
        resource_id: filename,
        risk_level: RiskLevel.LOW,
        metadata: { filename, valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined },
      });

      return {
        valid: errors.length === 0,
        errors,
        manifest,
        integrityCheck: errors.length === 0 ? 'ok' : 'failed',
      };
    } catch (err) {
      errors.push(`Validation error: ${err instanceof Error ? err.message : String(err)}`);
      return { valid: false, errors };
    } finally {
      if (tempDir) this.cleanupTempDir(tempDir);
    }
  }

  downloadBackup(filename: string): { stream: NodeJS.ReadableStream; size: number; manifest: BackupManifest } | null {
    if (!this.validateFilename(filename)) return null;

    const filePath = join(this.backupDir, filename);
    if (!existsSync(filePath)) return null;

    const manifest = this.readSidecarManifest(filename);
    if (!manifest) return null;

    this.auditService.record({
      event_type: AuditEventType.BACKUP_DOWNLOADED,
      action: 'backup_downloaded',
      resource_type: 'backup',
      resource_id: filename,
      risk_level: RiskLevel.LOW,
    });

    return {
      stream: createReadStream(filePath),
      size: statSync(filePath).size,
      manifest,
    };
  }

  async stageRestore(filename: string, options: { confirm: string; actorId?: string; actorEmail?: string }): Promise<RestoreResult> {
    if (options.confirm !== 'RESTORE') {
      throw new Error('Restore requires explicit confirmation: { confirm: "RESTORE" }');
    }

    if (!this.validateFilename(filename)) {
      throw new Error('Invalid backup filename');
    }

    const filePath = join(this.backupDir, filename);
    if (!existsSync(filePath)) {
      throw new Error('Backup file not found');
    }

    const validation = await this.validateBackup(filename);
    if (!validation.valid) {
      throw new Error(`Backup validation failed: ${validation.errors.join(', ')}`);
    }

    const safetyBackup = await this.createBackup({
      notes: 'Pre-restore safety backup',
      actorId: options.actorId,
      actorEmail: options.actorEmail,
    });

    this.auditService.record({
      event_type: AuditEventType.BACKUP_PRE_RESTORE_CREATED,
      action: 'pre_restore_backup_created',
      resource_type: 'backup',
      resource_id: safetyBackup.filename,
      risk_level: RiskLevel.HIGH,
      user_id: options.actorId || 'system',
      metadata: { safetyBackupFilename: safetyBackup.filename, restoreTarget: filename },
    });

    let tempDir = '';
    try {
      tempDir = join(this.backupDir, `.restore-${randomUUID()}`);
      mkdirSync(tempDir, { recursive: true });

      const extracted = await this.extractTarGzSafe(filePath, tempDir);
      if (!extracted.has('djimitflo.sqlite')) {
        throw new Error('Backup archive does not contain djimitflo.sqlite');
      }

      const stagedDbPath = this.dbPath + '.restore-pending';
      copyFileSync(join(tempDir, 'djimitflo.sqlite'), stagedDbPath);

      const marker = {
        stagedDbPath,
        targetDbPath: this.dbPath,
        safetyBackupFilename: safetyBackup.filename,
        timestamp: new Date().toISOString(),
        actorId: options.actorId || 'system',
        actorEmail: options.actorEmail,
        restoreFrom: filename,
      };

      writeFileSync(join(this.backupDir, 'restore-pending.json'), JSON.stringify(marker, null, 2), 'utf-8');

      this.auditService.record({
        event_type: AuditEventType.BACKUP_RESTORE_STARTED,
        action: 'restore_staged',
        resource_type: 'backup',
        resource_id: filename,
        risk_level: RiskLevel.HIGH,
        user_id: options.actorId || 'system',
        metadata: {
          filename,
          safetyBackupFilename: safetyBackup.filename,
          stagedDbPath,
          actorEmail: options.actorEmail,
        },
      });

      return {
        restartRequired: true,
        safetyBackupFilename: safetyBackup.filename,
        stagedDbPath,
        message: 'Restore staged successfully. Restart the server to complete the restore operation.',
      };
    } finally {
      if (tempDir) this.cleanupTempDir(tempDir);
    }
  }

  validateFilename(filename: string): boolean {
    if (!filename || typeof filename !== 'string') return false;
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return false;
    if (filename !== basename(filename)) return false;
    return BACKUP_FILENAME_REGEX.test(filename);
  }

  private async createSqliteBackup(targetPath: string): Promise<void> {
    await this.db.backup(targetPath);
  }

  private async computeFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(filePath);
      stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  private computeChecksums(manifestPath: string, sqlitePath: string): string {
    const manifestHash = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
    const sqliteHash = createHash('sha256').update(readFileSync(sqlitePath)).digest('hex');
    return `${manifestHash}  manifest.json\n${sqliteHash}  djimitflo.sqlite\n`;
  }

  private getTableCounts(): Record<string, number> {
    const tables = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as { name: string }[];

    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      const result = this.db.prepare(`SELECT COUNT(*) as count FROM "${name}"`).get() as { count: number };
      counts[name] = result.count;
    }
    return counts;
  }

  private async packTarGz(outputPath: string, sourceDir: string, entries: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const pack = tar.pack();
      const gzip = createGzip();
      const output = require('fs').createWriteStream(outputPath);

      for (const name of entries) {
        const filePath = join(sourceDir, name);
        if (!existsSync(filePath)) continue;
        const stat = statSync(filePath);
        pack.entry({ name, size: stat.size, type: 'file' as const }, readFileSync(filePath));
      }
      pack.finalize();

      pack.pipe(gzip).pipe(output);
      output.on('finish', resolve);
      output.on('error', reject);
    });
  }

  private async extractTarGzSafe(archivePath: string, targetDir: string): Promise<Set<string>> {
    const extracted = new Set<string>();

    return new Promise<Set<string>>((resolve, reject) => {
      const extract = tar.extract();
      const gunzip = createGunzip();
      const seenEntries = new Set<string>();

      extract.on('entry', (header: tar.Headers, stream: NodeJS.ReadableStream, next: () => void) => {
        const name = header.name;

        if (header.type === 'symlink' || header.type === 'link') {
          stream.resume();
          next();
          return;
        }

        if (name.startsWith('/') || name.includes('..') || name.includes('\\')) {
          stream.resume();
          next();
          return;
        }

        if (seenEntries.has(name)) {
          stream.resume();
          next();
          return;
        }

        if (!EXPECTED_ENTRIES.includes(name)) {
          stream.resume();
          next();
          return;
        }

        seenEntries.add(name);
        const safePath = join(targetDir, basename(name));
        const writeStream = require('fs').createWriteStream(safePath);
        stream.pipe(writeStream);
        writeStream.on('finish', () => {
          extracted.add(name);
          next();
        });
        writeStream.on('error', () => {
          stream.resume();
          next();
        });
      });

      extract.on('finish', () => resolve(extracted));
      extract.on('error', reject);

      const fileStream = createReadStream(archivePath);
      fileStream.on('error', (err) => reject(err));
      gunzip.on('error', (err) => reject(err));

      fileStream.pipe(gunzip).pipe(extract);
    });
  }

  private readSidecarManifest(filename: string): BackupManifest | null {
    const manifestPath = join(this.backupDir, `${filename}.manifest.json`);
    if (!existsSync(manifestPath)) return null;
    try {
      return JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  private cleanupTempDir(tempDir: string): void {
    try {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  }
}