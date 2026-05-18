import { Router, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { BackupService } from '../services/backup-service';
import { AuditService } from '../services/audit-service';
import type { AuthMiddleware } from '../middleware/auth';

export function createBackupRoutes(db: Database.Database, auth: AuthMiddleware): Router {
  const router = Router();
  const auditService = new AuditService(db);
  const DATA_DIR = process.env.DB_PATH
    ? require('path').join(process.env.DB_PATH, '..')
    : require('path').join(process.cwd().includes('/packages/server') ? require('path').join(process.cwd(), '../..') : process.cwd(), '.data');
  const BACKUP_DIR = process.env.BACKUP_DIR || require('path').join(DATA_DIR, 'backups');
  const backupService = new BackupService(db, BACKUP_DIR, auditService);

  const requireBackupPermission = auth.requirePermission('manage:backups');

  router.post('/', requireBackupPermission, async (req: Request, res: Response) => {
    try {
      const result = await backupService.createBackup({
        notes: req.body?.notes,
        actorId: (req as any).user?.sub,
        actorEmail: (req as any).user?.email,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ error: { message: err instanceof Error ? err.message : 'Backup creation failed', code: 'BACKUP_CREATE_FAILED' } });
    }
  });

  router.get('/', requireBackupPermission, (_req: Request, res: Response) => {
    try {
      const backups = backupService.listBackups();
      res.json(backups);
    } catch (err) {
      res.status(500).json({ error: { message: 'Failed to list backups', code: 'BACKUP_LIST_FAILED' } });
    }
  });

  router.get('/:filename', requireBackupPermission, (req: Request, res: Response) => {
    try {
      const metadata = backupService.getBackupMetadata(req.params.filename);
      if (!metadata) {
        res.status(404).json({ error: { message: 'Backup not found', code: 'BACKUP_NOT_FOUND' } });
        return;
      }
      res.json(metadata);
    } catch (err) {
      res.status(500).json({ error: { message: 'Failed to get backup metadata', code: 'BACKUP_METADATA_FAILED' } });
    }
  });

  router.get('/:filename/download', requireBackupPermission, (req: Request, res: Response) => {
    try {
      const result = backupService.downloadBackup(req.params.filename);
      if (!result) {
        res.status(404).json({ error: { message: 'Backup not found', code: 'BACKUP_NOT_FOUND' } });
        return;
      }
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
      res.setHeader('Content-Length', result.size);
      (result.stream as NodeJS.ReadableStream).pipe(res);
    } catch (err) {
      res.status(500).json({ error: { message: 'Download failed', code: 'BACKUP_DOWNLOAD_FAILED' } });
    }
  });

  router.post('/:filename/validate', requireBackupPermission, async (req: Request, res: Response) => {
    try {
      const result = await backupService.validateBackup(req.params.filename);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: { message: err instanceof Error ? err.message : 'Validation failed', code: 'BACKUP_VALIDATE_FAILED' } });
    }
  });

  router.post('/:filename/restore', requireBackupPermission, async (req: Request, res: Response) => {
    try {
      const result = await backupService.stageRestore(req.params.filename, {
        confirm: req.body?.confirm,
        actorId: (req as any).user?.sub,
        actorEmail: (req as any).user?.email,
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Restore staging failed';
      const status = message.includes('confirmation') ? 400 : message.includes('not found') ? 404 : message.includes('validation failed') ? 400 : 500;
      res.status(status).json({ error: { message, code: 'BACKUP_RESTORE_FAILED' } });
    }
  });

  return router;
}