import type { Database } from 'better-sqlite3';
import { AuditEventType, ExportFormat, RiskLevel } from '@djimitflo/shared';
import type { AuthTokenPayload, ExportRequest, ExportManifest, ExportResult, TaskExport, AuditExport, RepositoryExport, SummaryReport } from '@djimitflo/shared';
import { AuthorizationService } from './authorization-service';
import { EvidenceService } from './evidence-service';
import { AuditService } from './audit-service';
import { getAppVersion } from '../utils/version';

const EXPORT_VERSION = '1.0.0';

const SECRET_FIELDS = new Set([
  'password_hash', 'jwt_secret', 'auth_bootstrap_admin_password',
  'secret', 'token', 'password', 'private_key',
]);

const REDACTABLE_FIELDS = new Set([
  'path', 'metadata', 'command', 'args', 'env', 'url',
]);

function redactObject(obj: Record<string, unknown>, isAdmin: boolean): Record<string, unknown> {
  if (isAdmin) return obj;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_FIELDS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else if (REDACTABLE_FIELDS.has(key.toLowerCase())) {
      result[key] = null;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactObject(value as Record<string, unknown>, isAdmin);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export class ExportService {
  private evidenceService: EvidenceService;
  private auditService: AuditService;

  constructor(
    private db: Database,
  ) {
    this.evidenceService = new EvidenceService(db);
    this.auditService = new AuditService(db);
  }

  exportTask(taskId: string, user: AuthTokenPayload, options: ExportRequest): ExportResult {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    if (!task) {
      throw new ExportError('Task not found', 'TASK_NOT_FOUND', 404);
    }
    if (!AuthorizationService.canReadTask(user, task)) {
      this.auditService.record({
        event_type: AuditEventType.EXPORT_DENIED,
        user_id: user.sub,
        action: 'export.denied',
        resource_type: 'task',
        resource_id: taskId,
        risk_level: RiskLevel.MEDIUM,
        metadata: { format: options.format, scope: 'task', reason: 'insufficient_permissions' },
      });
      throw new ExportError('Task not found', 'TASK_NOT_FOUND', 404);
    }

    const isAdmin = AuthorizationService.isAdmin(user);
    const parsedTask = {
      ...task,
      tags: JSON.parse(task.tags || '[]'),
      metadata: JSON.parse(task.metadata || '{}'),
    };

    let summary = null;
    let evidence: any[] = [];
    let fileChanges: any[] = [];
    let auditTrail: any[] = [];
    const warnings: string[] = [];
    const recordCounts: Record<string, number> = { task: 1 };

    try {
      summary = this.evidenceService.getExecutionSummary(taskId);
      if (summary) recordCounts.summary = 1;
    } catch { warnings.push('Summary generation failed'); }

    if (options.includeDiffs !== false) {
      evidence = this.evidenceService.getTaskEvidence(taskId);
      recordCounts.evidence = evidence.length;
      fileChanges = this.evidenceService.getFileChanges(taskId);
      recordCounts.fileChanges = fileChanges.length;
    } else {
      warnings.push('Diffs and evidence excluded by request');
    }

    if (options.includeAudit !== false) {
      auditTrail = this.evidenceService.getAuditTrail(taskId);
      recordCounts.auditTrail = auditTrail.length;
    } else {
      warnings.push('Audit trail excluded by request');
    }

    const safeTask = deepClone(parsedTask);
    const redactedTask = options.includeMetadata !== false
      ? (isAdmin ? safeTask : redactObject(safeTask, isAdmin))
      : (() => { warnings.push('Metadata excluded by request'); const t = deepClone(safeTask); delete t.metadata; return isAdmin ? t : redactObject(t, isAdmin); })();

    const safeSummary = summary ? (deepClone(summary) as unknown as Record<string, unknown>) : null;
    const safeEvidence = evidence.map((e: any) => deepClone(e));
    const safeFileChanges = fileChanges.map((fc: any) => {
      const clone = deepClone(fc);
      if (!isAdmin) clone.diff = null;
      return clone;
    });
    const safeAuditTrail = auditTrail.map((a: any) => deepClone(a));

    const manifest: ExportManifest = {
      exportVersion: EXPORT_VERSION,
      appVersion: getAppVersion(),
      generatedAt: new Date().toISOString(),
      generatedBy: user.sub,
      generatedByRole: user.role,
      scope: 'task',
      sourceTaskId: taskId,
      filters: {
        dateFrom: options.dateFrom,
        dateTo: options.dateTo,
        includeDiffs: options.includeDiffs ?? true,
        includeAudit: options.includeAudit ?? true,
        includeMetadata: options.includeMetadata ?? true,
      },
      recordCounts,
      redactionApplied: !isAdmin,
      warnings,
    };

    const payload: TaskExport = {
      manifest,
      task: redactedTask,
      summary: safeSummary,
      evidence: safeEvidence,
      fileChanges: safeFileChanges,
      auditTrail: safeAuditTrail,
    };

    this.auditService.record({
      event_type: AuditEventType.EXPORT_CREATED,
      user_id: user.sub,
      action: 'export.created',
      resource_type: 'task',
      resource_id: taskId,
      risk_level: RiskLevel.LOW,
      metadata: { format: options.format, scope: 'task', recordCounts, redactionApplied: !isAdmin },
    });

    return this.formatExport(payload, options.format, `task-${taskId}`);
  }

  exportEvidence(taskId: string, user: AuthTokenPayload, options: ExportRequest): ExportResult {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    if (!task) {
      throw new ExportError('Task not found', 'TASK_NOT_FOUND', 404);
    }
    if (!AuthorizationService.canReadEvidenceForTask(user, task)) {
      this.auditService.record({
        event_type: AuditEventType.EXPORT_DENIED,
        user_id: user.sub,
        action: 'export.denied',
        resource_type: 'evidence',
        resource_id: taskId,
        risk_level: RiskLevel.MEDIUM,
        metadata: { format: options.format, scope: 'evidence', reason: 'insufficient_permissions' },
      });
      throw new ExportError('Task not found', 'TASK_NOT_FOUND', 404);
    }

    const isAdmin = AuthorizationService.isAdmin(user);
    const evidence = this.evidenceService.getTaskEvidence(taskId);
    const safeEvidence = evidence.map((e: any) => {
      const clone = deepClone(e);
      return isAdmin ? clone : redactObject(clone, isAdmin);
    });

    const recordCounts = { evidence: safeEvidence.length };
    const warnings: string[] = [];

    const manifest: ExportManifest = {
      exportVersion: EXPORT_VERSION,
      appVersion: getAppVersion(),
      generatedAt: new Date().toISOString(),
      generatedBy: user.sub,
      generatedByRole: user.role,
      scope: 'evidence',
      sourceTaskId: taskId,
      filters: { includeDiffs: options.includeDiffs, includeAudit: options.includeAudit, includeMetadata: options.includeMetadata },
      recordCounts,
      redactionApplied: !isAdmin,
      warnings,
    };

    const payload = { manifest, evidence: safeEvidence };

    this.auditService.record({
      event_type: AuditEventType.EXPORT_CREATED,
      user_id: user.sub,
      action: 'export.created',
      resource_type: 'evidence',
      resource_id: taskId,
      risk_level: RiskLevel.LOW,
      metadata: { format: options.format, scope: 'evidence', recordCounts, redactionApplied: !isAdmin },
    });

    return this.formatExport(payload, options.format, `evidence-${taskId}`);
  }

  exportAudit(user: AuthTokenPayload, options: ExportRequest): ExportResult {
    if (!AuthorizationService.isAdmin(user)) {
      this.auditService.record({
        event_type: AuditEventType.EXPORT_DENIED,
        user_id: user.sub,
        action: 'export.denied',
        resource_type: 'audit',
        risk_level: RiskLevel.HIGH,
        metadata: { format: options.format, scope: 'audit', reason: 'admin_required' },
      });
      throw new ExportError('Admin access required for audit export', 'FORBIDDEN', 403);
    }

    let query = 'SELECT * FROM audit_events WHERE 1=1';
    const params: any[] = [];
    if (options.dateFrom) { query += ' AND timestamp >= ?'; params.push(options.dateFrom); }
    if (options.dateTo) { query += ' AND timestamp <= ?'; params.push(options.dateTo); }
    query += ' ORDER BY timestamp ASC';
    const events = (this.db.prepare(query).all(...params) as any[]).map((row: any) => ({
      ...row,
      before: row.before ? JSON.parse(row.before) : null,
      after: row.after ? JSON.parse(row.after) : null,
      metadata: JSON.parse(row.metadata || '{}'),
    }));

    const recordCounts = { events: events.length };
    const warnings: string[] = [];

    const manifest: ExportManifest = {
      exportVersion: EXPORT_VERSION,
      appVersion: getAppVersion(),
      generatedAt: new Date().toISOString(),
      generatedBy: user.sub,
      generatedByRole: user.role,
      scope: 'audit',
      filters: { dateFrom: options.dateFrom, dateTo: options.dateTo, includeMetadata: options.includeMetadata },
      recordCounts,
      redactionApplied: false,
      warnings,
    };

    const payload: AuditExport = { manifest, events };

    this.auditService.record({
      event_type: AuditEventType.EXPORT_CREATED,
      user_id: user.sub,
      action: 'export.created',
      resource_type: 'audit',
      risk_level: RiskLevel.MEDIUM,
      metadata: { format: options.format, scope: 'audit', recordCounts },
    });

    return this.formatExport(payload, options.format, 'audit-export');
  }

  exportRepository(repositoryId: string, user: AuthTokenPayload, options: ExportRequest): ExportResult {
    const repo = this.db.prepare('SELECT * FROM repositories WHERE id = ?').get(repositoryId) as any;
    if (!repo) {
      throw new ExportError('Repository not found', 'REPOSITORY_NOT_FOUND', 404);
    }
    if (!AuthorizationService.canReadRepositoryDetail(user)) {
      this.auditService.record({
        event_type: AuditEventType.EXPORT_DENIED,
        user_id: user.sub,
        action: 'export.denied',
        resource_type: 'repository',
        resource_id: repositoryId,
        risk_level: RiskLevel.MEDIUM,
        metadata: { format: options.format, scope: 'repository', reason: 'insufficient_permissions' },
      });
      throw new ExportError('Insufficient permissions', 'FORBIDDEN', 403);
    }

    const isAdmin = AuthorizationService.isAdmin(user);
    const safeRepo = deepClone({ ...repo, metadata: JSON.parse(repo.metadata || '{}'), detected_stacks: JSON.parse(repo.detected_stacks || '[]') });
    const redactedRepo = isAdmin ? safeRepo : redactObject(safeRepo, isAdmin);

    let health = null;
    const warnings: string[] = [];
    if (options.includeMetadata !== false) {
      try {
        const healthRow = this.db.prepare('SELECT * FROM repository_health_findings WHERE repository_id = ?').all(repositoryId) as any[];
        if (healthRow.length > 0) {
          health = { health_score: repo.health_score, findings: healthRow };
        }
      } catch { warnings.push('Health data unavailable'); }
    }

    const taskCount = (this.db.prepare('SELECT COUNT(*) as count FROM tasks WHERE repository_id = ?').get(repositoryId) as any).count;
    const recordCounts: Record<string, number> = { repository: 1, relatedTasks: taskCount };

    const manifest: ExportManifest = {
      exportVersion: EXPORT_VERSION,
      appVersion: getAppVersion(),
      generatedAt: new Date().toISOString(),
      generatedBy: user.sub,
      generatedByRole: user.role,
      scope: 'repository',
      sourceRepositoryId: repositoryId,
      filters: { includeMetadata: options.includeMetadata },
      recordCounts,
      redactionApplied: !isAdmin,
      warnings,
    };

    const payload: RepositoryExport = { manifest, repository: redactedRepo, health };

    this.auditService.record({
      event_type: AuditEventType.EXPORT_CREATED,
      user_id: user.sub,
      action: 'export.created',
      resource_type: 'repository',
      resource_id: repositoryId,
      risk_level: RiskLevel.LOW,
      metadata: { format: options.format, scope: 'repository', recordCounts, redactionApplied: !isAdmin },
    });

    return this.formatExport(payload, options.format, `repository-${repositoryId}`);
  }

  exportSummaryReport(user: AuthTokenPayload, options: ExportRequest): ExportResult {
    if (!AuthorizationService.isAdmin(user)) {
      this.auditService.record({
        event_type: AuditEventType.EXPORT_DENIED,
        user_id: user.sub,
        action: 'export.denied',
        resource_type: 'summary_report',
        risk_level: RiskLevel.MEDIUM,
        metadata: { format: options.format, scope: 'summary', reason: 'insufficient_permissions' },
      });
      throw new ExportError('Insufficient permissions', 'FORBIDDEN', 403);
    }

    const metrics = this.evidenceService.getObservabilityMetrics();
    const recordCounts = { tasks: metrics.total_tasks, active: metrics.active_tasks, completed: metrics.completed_tasks, failed: metrics.failed_tasks };
    const warnings: string[] = [];

    const manifest: ExportManifest = {
      exportVersion: EXPORT_VERSION,
      appVersion: getAppVersion(),
      generatedAt: new Date().toISOString(),
      generatedBy: user.sub,
      generatedByRole: user.role,
      scope: 'summary',
      filters: { dateFrom: options.dateFrom, dateTo: options.dateTo },
      recordCounts,
      redactionApplied: false,
      warnings,
    };

    const payload: SummaryReport = { manifest, summary: metrics as unknown as Record<string, unknown> };

    this.auditService.record({
      event_type: AuditEventType.EXPORT_CREATED,
      user_id: user.sub,
      action: 'export.created',
      resource_type: 'summary_report',
      risk_level: RiskLevel.LOW,
      metadata: { format: options.format, scope: 'summary', recordCounts },
    });

    return this.formatExport(payload, options.format, 'summary-report');
  }

  private formatExport(data: unknown, format: ExportFormat, baseName: string): ExportResult {
    switch (format) {
      case ExportFormat.JSON:
        return {
          contentType: 'application/json',
          filename: `${baseName}.json`,
          data: JSON.stringify(data, null, 2),
        };
      case ExportFormat.CSV:
        return {
          contentType: 'text/csv',
          filename: `${baseName}.csv`,
          data: this.toCSV(data),
        };
      case ExportFormat.MARKDOWN:
        return {
          contentType: 'text/markdown',
          filename: `${baseName}.md`,
          data: this.toMarkdown(data),
        };
      default:
        throw new ExportError(`Unsupported format: ${format}`, 'INVALID_FORMAT', 400);
    }
  }

  private toCSV(data: unknown): string {
    const obj = data as Record<string, unknown>;
    const manifest = obj.manifest as ExportManifest | undefined;
    const rows: string[] = [];

    rows.push('# Export Manifest');
    rows.push(csvLine(['key', 'value']));
    rows.push(csvLine(['exportVersion', manifest?.exportVersion ?? '']));
    rows.push(csvLine(['appVersion', manifest?.appVersion ?? '']));
    rows.push(csvLine(['generatedAt', manifest?.generatedAt ?? '']));
    rows.push(csvLine(['generatedBy', manifest?.generatedBy ?? '']));
    rows.push(csvLine(['generatedByRole', manifest?.generatedByRole ?? '']));
    rows.push(csvLine(['scope', manifest?.scope ?? '']));
    rows.push(csvLine(['redactionApplied', String(manifest?.redactionApplied ?? '')]));
    rows.push(csvLine(['warnings', (manifest?.warnings ?? []).join('; ')]));
    rows.push('');

    const dataKeys = Object.keys(obj).filter(k => k !== 'manifest');
    for (const key of dataKeys) {
      const section = obj[key];
      if (Array.isArray(section)) {
        if (section.length === 0) continue;
        rows.push(`# ${key}`);
        const headers = Object.keys(section[0] as Record<string, unknown>);
        rows.push(csvLine(headers));
        for (const item of section) {
          rows.push(csvLine(headers.map(h => safeCsvValue((item as Record<string, unknown>)[h]))));
        }
        rows.push('');
      } else if (section && typeof section === 'object') {
        rows.push(`# ${key}`);
        const entries = Object.entries(section as Record<string, unknown>);
        rows.push(csvLine(['field', 'value']));
        for (const [k, v] of entries) {
          rows.push(csvLine([k, safeCsvValue(v)]));
        }
        rows.push('');
      }
    }

    return rows.join('\n');
  }

  private toMarkdown(data: unknown): string {
    const obj = data as Record<string, unknown>;
    const manifest = obj.manifest as ExportManifest | undefined;
    const lines: string[] = [];

    lines.push('# Djimitflo Export');
    lines.push('');
    lines.push('## Manifest');
    lines.push('');
    lines.push(`| Field | Value |`);
    lines.push(`|-------|-------|`);
    lines.push(`| Export Version | ${manifest?.exportVersion ?? ''} |`);
    lines.push(`| App Version | ${manifest?.appVersion ?? ''} |`);
    lines.push(`| Generated At | ${manifest?.generatedAt ?? ''} |`);
    lines.push(`| Generated By | ${manifest?.generatedBy ?? ''} (${manifest?.generatedByRole ?? ''}) |`);
    lines.push(`| Scope | ${manifest?.scope ?? ''} |`);
    lines.push(`| Redaction Applied | ${manifest?.redactionApplied ?? false} |`);
    if (manifest?.sourceTaskId) lines.push(`| Source Task | ${manifest.sourceTaskId} |`);
    if (manifest?.sourceRepositoryId) lines.push(`| Source Repository | ${manifest.sourceRepositoryId} |`);

    if (manifest?.warnings && manifest.warnings.length > 0) {
      lines.push('');
      lines.push('> **Warnings:** ' + manifest.warnings.join('; '));
    }

    if (manifest?.redactionApplied) {
      lines.push('');
      lines.push('> **Note:** Sensitive fields have been redacted for non-admin access.');
    }

    lines.push('');
    lines.push('> **Confidential:** This export is intended for authorized personnel only. Do not distribute without proper authorization.');
    lines.push('');

    const dataKeys = Object.keys(obj).filter(k => k !== 'manifest');
    for (const key of dataKeys) {
      const section = obj[key];
      if (Array.isArray(section)) {
        if (section.length === 0) continue;
        lines.push(`## ${formatHeading(key)}`);
        lines.push('');
        const headers = Object.keys(section[0] as Record<string, unknown>);
        lines.push('| ' + headers.join(' | ') + ' |');
        lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');
        for (const item of section) {
          const vals = headers.map(h => mdCellValue((item as Record<string, unknown>)[h]));
          lines.push('| ' + vals.join(' | ') + ' |');
        }
        lines.push('');
      } else if (section && typeof section === 'object') {
        lines.push(`## ${formatHeading(key)}`);
        lines.push('');
        const entries = Object.entries(section as Record<string, unknown>);
        for (const [k, v] of entries) {
          lines.push(`- **${k}:** ${mdCellValue(v)}`);
        }
        lines.push('');
      } else if (section !== null && section !== undefined) {
        lines.push(`## ${formatHeading(key)}`);
        lines.push('');
        lines.push(String(section));
        lines.push('');
      }
    }

    return lines.join('\n');
  }
}

export class ExportError extends Error {
  code: string;
  statusCode: number;
  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function csvLine(values: unknown[]): string {
  return values.map(csvEscape).join(',');
}

function safeCsvValue(value: unknown): unknown {
  if (typeof value === 'string' && /^[=+\-@]/.test(value)) {
    return "'" + value;
  }
  return value;
}

function mdCellValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return `\`${JSON.stringify(value).substring(0, 100)}\``;
  return String(value).replace(/\|/g, '\\|');
}

function formatHeading(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}