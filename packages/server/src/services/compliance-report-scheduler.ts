/**
 * ComplianceReportScheduler — periodic compliance reporting, in-process.
 *
 * `ComplianceAuditService.generateReport()` has existed since the Vector 7
 * work but was only ever reachable via `POST /api/compliance/reports/generate`
 * (requires the `write:governance` permission, which sits on the ADMIN role
 * only — there's no narrower role to scope a service credential to). No
 * cron/timer ever called it, so `compliance_reports` stayed empty.
 *
 * Rather than mint a broad ADMIN-equivalent credential for an external timer,
 * this runs the same call in-process — the same pattern as
 * OpenMythosNightlyService and SelfModificationPipeline.autoPlan(): no HTTP
 * round-trip, no auth needed, because it's the server calling its own
 * service class directly.
 *
 * Default-off. Arm with:
 *   COMPLIANCE_REPORT_SCHEDULER_ENABLED=true
 *   COMPLIANCE_REPORT_TYPE=custom                    (nora|soc2|iso27001|custom, default custom)
 *   COMPLIANCE_REPORT_INTERVAL_HOURS=24               (default 24)
 */

import type { Database } from 'better-sqlite3';
import { ComplianceAuditService } from './compliance-audit-service';

type ReportGenerator = Pick<ComplianceAuditService, 'generateReport'>;
type ComplianceReport = ReturnType<ComplianceAuditService['generateReport']>;

const HOUR_MS = 60 * 60 * 1000;
const VALID_TYPES = ['nora', 'soc2', 'iso27001', 'custom'] as const;
type ReportType = (typeof VALID_TYPES)[number];

export class ComplianceReportScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly audit: ReportGenerator;

  constructor(private db: Database, audit?: ReportGenerator) {
    this.audit = audit ?? new ComplianceAuditService(db);
  }

  /** Arm the scheduler. Returns false (no-op) unless explicitly enabled. */
  start(): boolean {
    if (process.env.COMPLIANCE_REPORT_SCHEDULER_ENABLED !== 'true') return false;
    const intervalMs = this.intervalHours() * HOUR_MS;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
    this.tick(); // catch-up on boot
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reportType(): ReportType {
    const configured = process.env.COMPLIANCE_REPORT_TYPE;
    return (VALID_TYPES as readonly string[]).includes(configured || '') ? (configured as ReportType) : 'custom';
  }

  intervalHours(): number {
    const hours = Number(process.env.COMPLIANCE_REPORT_INTERVAL_HOURS ?? '24');
    return Number.isFinite(hours) && hours > 0 ? hours : 24;
  }

  /** Generate a report unless one of the configured type already exists within the current interval. */
  tick(): ComplianceReport | null {
    const type = this.reportType();
    const since = new Date(Date.now() - this.intervalHours() * HOUR_MS).toISOString();
    const recent = this.db.prepare(
      'SELECT 1 FROM compliance_reports WHERE type = ? AND generated_at >= ? LIMIT 1',
    ).get(type, since);
    if (recent) return null;

    try {
      return this.audit.generateReport({ type });
    } catch (err) {
      console.warn('ComplianceReportScheduler: report generation failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }
}
