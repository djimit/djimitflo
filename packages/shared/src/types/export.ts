/**
 * Export and reporting types for Djimitflo
 */

export enum ExportFormat {
  JSON = 'json',
  CSV = 'csv',
  MARKDOWN = 'markdown',
}

export interface ExportRequest {
  format: ExportFormat;
  includeDiffs?: boolean;
  includeAudit?: boolean;
  includeMetadata?: boolean;
  dateFrom?: string;
  dateTo?: string;
}

export interface ExportManifest {
  exportVersion: string;
  appVersion: string;
  generatedAt: string;
  generatedBy: string;
  generatedByRole: string;
  scope: 'task' | 'evidence' | 'audit' | 'repository' | 'summary';
  sourceTaskId?: string;
  sourceRepositoryId?: string;
  filters?: {
    dateFrom?: string;
    dateTo?: string;
    includeDiffs?: boolean;
    includeAudit?: boolean;
    includeMetadata?: boolean;
  };
  recordCounts: Record<string, number>;
  redactionApplied: boolean;
  warnings: string[];
}

export interface TaskExport {
  manifest: ExportManifest;
  task: Record<string, unknown>;
  summary?: Record<string, unknown> | null;
  evidence?: Record<string, unknown>[];
  fileChanges?: Record<string, unknown>[];
  auditTrail?: Record<string, unknown>[];
}

export interface AuditExport {
  manifest: ExportManifest;
  events: Record<string, unknown>[];
}

export interface RepositoryExport {
  manifest: ExportManifest;
  repository: Record<string, unknown>;
  health?: Record<string, unknown> | null;
}

export interface SummaryReport {
  manifest: ExportManifest;
  summary: Record<string, unknown>;
}

export interface ExportResult {
  contentType: string;
  filename: string;
  data: string;
}