/**
 * Exports API client.
 * Extracted from api.ts (Task 5.3: ApiClient domain split)
 */
import { getToken } from "../api-client";
import type { ExportFormat, ExportRequest } from '@djimitflo/shared';

async function exportDownload(endpoint: string, format: ExportFormat, options?: Partial<ExportRequest>): Promise<void> {
  const token = await getToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`/api${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ format, ...options }),
  });

  if (!response.ok) throw new Error(`Export failed: ${response.status}`);

  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `export.${format}`;
  a.click();
  window.URL.revokeObjectURL(url);
}

export const exportsApi = {
    async exportTask(taskId: string, format: ExportFormat, options?: Partial<ExportRequest>): Promise<void> {
      return exportDownload(`/exports/task/${taskId}`, format, options);
    },
    async exportEvidence(taskId: string, format: ExportFormat, options?: Partial<ExportRequest>): Promise<void> {
      return exportDownload(`/exports/evidence/${taskId}`, format, options);
    },
    async exportAudit(format: ExportFormat, options?: Partial<ExportRequest>): Promise<void> {
      return exportDownload('/exports/audit', format, options);
    },
    async exportRepository(repositoryId: string, format: ExportFormat, options?: Partial<ExportRequest>): Promise<void> {
      return exportDownload(`/exports/repository/${repositoryId}`, format, options);
    },
    async exportSummaryReport(format: ExportFormat, options?: Partial<ExportRequest>): Promise<void> {
      return exportDownload('/exports/report/summary', format, options);
    }
};
