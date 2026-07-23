/**
 * Exports API client.
 * Extracted from api.ts (Task 5.3: ApiClient domain split)
 */
import { request } from "../api-client";
import type * from "../api-client";

export const exportsApi = {
    async exportTask(taskId: string, format: ExportFormat, options?: Partial<ExportRequest>): Promise<void> {
      return this.exportDownload(`/exports/task/${taskId}`, format, options);
    }
    async exportEvidence(taskId: string, format: ExportFormat, options?: Partial<ExportRequest>): Promise<void> {
      return this.exportDownload(`/exports/evidence/${taskId}`, format, options);
    }
    async exportAudit(format: ExportFormat, options?: Partial<ExportRequest>): Promise<void> {
      return this.exportDownload('/exports/audit', format, options);
    }
    async exportRepository(repositoryId: string, format: ExportFormat, options?: Partial<ExportRequest>): Promise<void> {
      return this.exportDownload(`/exports/repository/${repositoryId}`, format, options);
    }
    async exportSummaryReport(format: ExportFormat, options?: Partial<ExportRequest>): Promise<void> {
      return this.exportDownload('/exports/report/summary', format, options);
    }
};
