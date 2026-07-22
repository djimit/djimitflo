import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExportService, ExportError } from '../services/export-service';
import { AuditService } from '../services/audit-service';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { AuditEventType, ExportFormat, UserRole } from '@djimitflo/shared';

const TEST_DIR = join(__dirname, '../../.data/test-export-int');
const TEST_DB_PATH = join(TEST_DIR, 'test.sqlite');

let db: Database.Database;
let exportService: ExportService;
let auditService: AuditService;

function createDb(): Database.Database {
  const database = new Database(TEST_DB_PATH) as unknown as Database.Database;
  database.pragma('foreign_keys = ON');
  database.exec(schema);
  runMigrations(database as any);
  return database;
}

function makeUser(role: UserRole, userId: string) {
  return { sub: userId, email: `${userId}@test.com`, role, iat: 0, exp: 0 } as any;
}

function seedTask(db: Database.Database, overrides: Record<string, unknown> = {}) {
  const id = overrides.id as string || crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, created_by, owner_user_id, tags, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    overrides.title as string || 'Test Task',
    overrides.description as string || 'Test description',
    overrides.status as string || 'completed',
    overrides.priority as string || 'medium',
    overrides.risk_level as string || 'low',
    overrides.execution_mode as string || 'local',
    overrides.created_by as string || null,
    overrides.owner_user_id as string || null,
    '[]',
    '{}',
    now,
    now
  );
  return id;
}

function seedAuditEvent(db: Database.Database, overrides: Record<string, unknown> = {}) {
  const id = overrides.id as string || crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO audit_events (id, event_type, timestamp, user_id, action, resource_type, risk_level, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    overrides.event_type as string || AuditEventType.TASK_CREATED,
    overrides.timestamp as string || now,
    overrides.user_id as string || 'system',
    overrides.action as string || 'task.created',
    overrides.resource_type as string || 'task',
    overrides.risk_level as string || 'low',
    '{}',
    now,
    now
  );
  return id;
}

function seedRepository(db: Database.Database, overrides: Record<string, unknown> = {}) {
  const id = overrides.id as string || crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO repositories (id, name, description, path, is_active, has_git, provider, status, detected_stacks, package_manager, test_commands, build_commands, lint_commands, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    overrides.name as string || 'test-repo',
    overrides.description as string || 'Test repo',
    overrides.path as string || '/tmp/test-repo',
    overrides.is_active as number ?? 1,
    overrides.has_git as number ?? 1,
    overrides.provider as string || 'local',
    overrides.status as string || 'ready',
    '[]',
    'npm',
    '[]',
    '[]',
    '[]',
    '{}',
    now,
    now
  );
  return id;
}

describe('ExportService', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDb();
    auditService = new AuditService(db as any);
    exportService = new ExportService(db as any);
  });

  afterEach(() => {
    db.close();
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  describe('exportTask', () => {
    it('allows admin to export any task', () => {
      const taskId = seedTask(db, { owner_user_id: 'other-user', created_by: 'other-user' });
      const admin = makeUser(UserRole.ADMIN, 'admin-1');
      const result = exportService.exportTask(taskId, admin, { format: ExportFormat.JSON });
      expect(result.contentType).toBe('application/json');
      expect(result.filename).toBe(`task-${taskId}.json`);
      const parsed = JSON.parse(result.data);
      expect(parsed.manifest.scope).toBe('task');
      expect(parsed.manifest.sourceTaskId).toBe(taskId);
      expect(parsed.manifest.redactionApplied).toBe(false);
      expect(parsed.manifest.generatedBy).toBe('admin-1');
      expect(parsed.manifest.generatedByRole).toBe('admin');
    });

    it('allows operator to export own task', () => {
      const taskId = seedTask(db, { owner_user_id: 'op-1', created_by: 'op-1' });
      const operator = makeUser(UserRole.OPERATOR, 'op-1');
      const result = exportService.exportTask(taskId, operator, { format: ExportFormat.JSON });
      expect(result.contentType).toBe('application/json');
      const parsed = JSON.parse(result.data);
      expect(parsed.manifest.redactionApplied).toBe(true);
    });

    it('denies operator from exporting another operator task (404)', () => {
      const taskId = seedTask(db, { owner_user_id: 'op-2', created_by: 'op-2' });
      const operator = makeUser(UserRole.OPERATOR, 'op-1');
      expect(() => exportService.exportTask(taskId, operator, { format: ExportFormat.JSON })).toThrow(ExportError);
      try {
        exportService.exportTask(taskId, operator, { format: ExportFormat.JSON });
      } catch (e: any) {
        expect(e.statusCode).toBe(404);
      }
    });

    it('viewer can export own task', () => {
      const taskId = seedTask(db, { created_by: 'viewer-1' });
      const viewer = makeUser(UserRole.VIEWER, 'viewer-1');
      const result = exportService.exportTask(taskId, viewer, { format: ExportFormat.JSON });
      expect(result.contentType).toBe('application/json');
      const parsed = JSON.parse(result.data);
      expect(parsed.manifest.redactionApplied).toBe(true);
    });

    it('viewer cannot export inaccessible task (404)', () => {
      const taskId = seedTask(db, { owner_user_id: 'other-user', created_by: 'other-user' });
      const viewer = makeUser(UserRole.VIEWER, 'viewer-1');
      expect(() => exportService.exportTask(taskId, viewer, { format: ExportFormat.JSON })).toThrow(ExportError);
    });

    it('includes manifest with appVersion, generatedBy, and scope', () => {
      const taskId = seedTask(db);
      const admin = makeUser(UserRole.ADMIN, 'admin-1');
      const result = exportService.exportTask(taskId, admin, { format: ExportFormat.JSON });
      const parsed = JSON.parse(result.data);
      expect(parsed.manifest.exportVersion).toBe('1.0.0');
      expect(parsed.manifest.appVersion).toBeDefined();
      expect(parsed.manifest.generatedBy).toBe('admin-1');
      expect(parsed.manifest.generatedByRole).toBe('admin');
      expect(parsed.manifest.scope).toBe('task');
    });

    it('records audit event on successful export', () => {
      const taskId = seedTask(db);
      const admin = makeUser(UserRole.ADMIN, 'admin-1');
      exportService.exportTask(taskId, admin, { format: ExportFormat.JSON });
      const events = db.prepare("SELECT * FROM audit_events WHERE event_type = 'export.created'").all() as any[];
      expect(events.length).toBe(1);
      expect(events[0].action).toBe('export.created');
      expect(events[0].resource_type).toBe('task');
      expect(events[0].resource_id).toBe(taskId);
      expect(events[0].user_id).toBe('admin-1');
    });

    it('records export.denied audit event on authorization failure', () => {
      const taskId = seedTask(db, { owner_user_id: 'op-2', created_by: 'op-2' });
      const operator = makeUser(UserRole.OPERATOR, 'op-1');
      try { exportService.exportTask(taskId, operator, { format: ExportFormat.JSON }); } catch {}
      const events = db.prepare("SELECT * FROM audit_events WHERE event_type = 'export.denied'").all() as any[];
      expect(events.length).toBe(1);
      expect(events[0].user_id).toBe('op-1');
    });

    it('omits diffs when includeDiffs is false', () => {
      const taskId = seedTask(db);
      const admin = makeUser(UserRole.ADMIN, 'admin-1');
      const result = exportService.exportTask(taskId, admin, { format: ExportFormat.JSON, includeDiffs: false });
      const parsed = JSON.parse(result.data);
      expect(parsed.manifest.warnings).toContain('Diffs and evidence excluded by request');
      expect(parsed.evidence).toEqual([]);
      expect(parsed.fileChanges).toEqual([]);
    });

    it('omits audit trail when includeAudit is false', () => {
      const taskId = seedTask(db);
      const admin = makeUser(UserRole.ADMIN, 'admin-1');
      const result = exportService.exportTask(taskId, admin, { format: ExportFormat.JSON, includeAudit: false });
      const parsed = JSON.parse(result.data);
      expect(parsed.manifest.warnings).toContain('Audit trail excluded by request');
    });

    it('does not include password_hash or jwt_secret in JSON export', () => {
      const taskId = seedTask(db);
      const admin = makeUser(UserRole.ADMIN, 'admin-1');
      const result = exportService.exportTask(taskId, admin, { format: ExportFormat.JSON });
      expect(result.data).not.toContain('password_hash');
      expect(result.data).not.toContain('jwt_secret');
      expect(result.data).not.toContain('JWT_SECRET');
    });
  });

  describe('exportAudit', () => {
    it('allows admin to export audit trail', () => {
      seedAuditEvent(db);
      const admin = makeUser(UserRole.ADMIN, 'admin-1');
      const result = exportService.exportAudit(admin, { format: ExportFormat.JSON });
      expect(result.contentType).toBe('application/json');
      const parsed = JSON.parse(result.data);
      expect(parsed.manifest.scope).toBe('audit');
      expect(parsed.manifest.redactionApplied).toBe(false);
      expect(parsed.events.length).toBeGreaterThanOrEqual(1);
    });

    it('denies non-admin from audit export (403)', () => {
      const maker = makeUser(UserRole.MAKER, 'm-1');
      expect(() => exportService.exportAudit(maker, { format: ExportFormat.JSON })).toThrow(ExportError);
      try { exportService.exportAudit(maker, { format: ExportFormat.JSON }); } catch (e: any) {
        expect(e.statusCode).toBe(403);
      }
    });

    it('denies viewer from audit export (403)', () => {
      const viewer = makeUser(UserRole.VIEWER, 'viewer-1');
      expect(() => exportService.exportAudit(viewer, { format: ExportFormat.JSON })).toThrow(ExportError);
    });
  });

  describe('exportRepository', () => {
    it('redacts path and metadata for non-admin', () => {
      const repoId = seedRepository(db, { path: '/secret/path', metadata: '{}' });
      const maker = makeUser(UserRole.MAKER, 'm-1');
      const result = exportService.exportRepository(repoId, maker, { format: ExportFormat.JSON });
      const parsed = JSON.parse(result.data);
      expect(parsed.manifest.redactionApplied).toBe(true);
      expect(parsed.repository.path).toBeNull();
      expect(parsed.repository.metadata).toBeNull();
    });

    it('includes path and metadata for admin', () => {
      const repoId = seedRepository(db, { path: '/secret/path', metadata: '{}' });
      const admin = makeUser(UserRole.ADMIN, 'admin-1');
      const result = exportService.exportRepository(repoId, admin, { format: ExportFormat.JSON });
      const parsed = JSON.parse(result.data);
      expect(parsed.manifest.redactionApplied).toBe(false);
      expect(parsed.repository.path).toBe('/secret/path');
    });

    it('returns 404 for nonexistent repository', () => {
      const admin = makeUser(UserRole.ADMIN, 'admin-1');
      expect(() => exportService.exportRepository('nonexistent-id', admin, { format: ExportFormat.JSON })).toThrow(ExportError);
      try { exportService.exportRepository('nonexistent-id', admin, { format: ExportFormat.JSON }); } catch (e: any) {
        expect(e.statusCode).toBe(404);
      }
    });
  });

  describe('CSV format', () => {
    it('escapes dangerous formula prefixes (=, +, -, @)', () => {
      const taskId = seedTask(db);
      const admin = makeUser(UserRole.ADMIN, 'admin-1');
      const result = exportService.exportTask(taskId, admin, { format: ExportFormat.CSV });
      expect(result.contentType).toBe('text/csv');
      expect(result.filename).toMatch(/\.csv$/);
      const dangerousLines = result.data.split('\n').filter(line => /^[=+\-@]/.test(line.trim()));
      expect(dangerousLines.length).toBe(0);
    });

    it('produces valid CSV with manifest header', () => {
      const taskId = seedTask(db);
      const admin = makeUser(UserRole.ADMIN, 'admin-1');
      const result = exportService.exportTask(taskId, admin, { format: ExportFormat.CSV });
      expect(result.data).toContain('# Export Manifest');
      expect(result.data).toContain('exportVersion');
      expect(result.data).toContain('appVersion');
    });
  });

  describe('Markdown format', () => {
    it('produces valid markdown with manifest table', () => {
      const taskId = seedTask(db);
      const admin = makeUser(UserRole.ADMIN, 'admin-1');
      const result = exportService.exportTask(taskId, admin, { format: ExportFormat.MARKDOWN });
      expect(result.contentType).toBe('text/markdown');
      expect(result.filename).toMatch(/\.md$/);
      expect(result.data).toContain('# Djimitflo Export');
      expect(result.data).toContain('## Manifest');
      expect(result.data).toContain('| Export Version |');
      expect(result.data).toContain('Confidential');
    });

    it('includes redaction note when redactionApplied is true', () => {
      const taskId = seedTask(db, { owner_user_id: 'op-1', created_by: 'op-1' });
      const operator = makeUser(UserRole.OPERATOR, 'op-1');
      const result = exportService.exportTask(taskId, operator, { format: ExportFormat.MARKDOWN });
      expect(result.data).toContain('Sensitive fields have been redacted');
    });
  });

  describe('exportSummaryReport', () => {
    it('allows admin to export summary report', () => {
      const admin = makeUser(UserRole.ADMIN, 'admin-1');
      const result = exportService.exportSummaryReport(admin, { format: ExportFormat.JSON });
      expect(result.contentType).toBe('application/json');
      const parsed = JSON.parse(result.data);
      expect(parsed.manifest.scope).toBe('summary');
      expect(parsed.summary).toBeDefined();
    });

    it('denies non-admin from summary report (403)', () => {
      const operator = makeUser(UserRole.OPERATOR, 'op-1');
      expect(() => exportService.exportSummaryReport(operator, { format: ExportFormat.JSON })).toThrow(ExportError);
    });
  });

  describe('nonexistent task', () => {
    it('returns 404 for nonexistent task', () => {
      const admin = makeUser(UserRole.ADMIN, 'admin-1');
      expect(() => exportService.exportTask('nonexistent-id', admin, { format: ExportFormat.JSON })).toThrow(ExportError);
      try { exportService.exportTask('nonexistent-id', admin, { format: ExportFormat.JSON }); } catch (e: any) {
        expect(e.statusCode).toBe(404);
      }
    });
  });
});