import { afterEach, describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { ComplianceAuditService } from '../services/compliance-audit-service';
import { createComplianceRoutes } from '../routes/compliance';
import { errorHandler } from '../middleware/error-handler';

describe('Governance Reports Export', () => {
  let db: Database.Database;
  let service: ComplianceAuditService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    service = new ComplianceAuditService(db);
  });

  afterEach(() => db.close());

  describe('exportReportAsCsv', () => {
    it('produces valid CSV with headers', () => {
      const report = service.generateReport({ type: 'nora' }) as any;
      const csv = service.exportReportAsCsv(report);
      const lines = csv.split('\n');
      expect(lines[0]).toBe('control,description,status,evidence,recommendation');
    });

    it('includes all findings', () => {
      const report = service.generateReport({ type: 'nora' }) as any;
      const csv = service.exportReportAsCsv(report);
      const lines = csv.split('\n');
      expect(lines.length).toBe(report.findings.length + 1);
    });
  });

  describe('exportReportAsText', () => {
    it('includes report metadata', () => {
      const report = service.generateReport({ type: 'nora' }) as any;
      const text = service.exportReportAsText(report);
      expect(text).toContain('GOVERNANCE COMPLIANCE REPORT');
      expect(text).toContain('NORA');
    });

    it('includes all findings', () => {
      const report = service.generateReport({ type: 'nora' }) as any;
      const text = service.exportReportAsText(report);
      for (const finding of report.findings) {
        expect(text).toContain(finding.control);
      }
    });
  });

  describe('generateReport', () => {
    it('generates a NORA report', () => {
      const report = service.generateReport({ type: 'nora' }) as any;
      expect(report.type).toBe('nora');
      expect(report.score).toBeGreaterThanOrEqual(0);
      expect(report.findings.length).toBeGreaterThan(0);
    });

    it('generates a SOC2 report', () => {
      const report = service.generateReport({ type: 'soc2' }) as any;
      expect(report.type).toBe('soc2');
    });

    it('stores the report in DB', () => {
      const report = service.generateReport({ type: 'nora' }) as any;
      const stored = db.prepare('SELECT * FROM compliance_reports WHERE id = ?').get(report.id) as any;
      expect(stored).toBeDefined();
    });
  });

  describe('getStatus', () => {
    it('returns initial status', () => {
      const status = service.getStatus();
      expect(status.totalAuditEntries).toBe(0);
      expect(status.chainIntegrity).toBe(true);
    });

    it('tracks audit entries', () => {
      service.appendEntry({ actor: 'test', action: 'test_action', resource: 'test', outcome: 'success' });
      const status = service.getStatus();
      expect(status.totalAuditEntries).toBe(1);
    });
  });

  describe('verifyChain', () => {
    it('validates empty chain', () => {
      const result = service.verifyChain();
      expect(result.valid).toBe(true);
    });

    it('validates chain with entries', () => {
      service.appendEntry({ actor: 'test', action: 'action1', resource: 'res1', outcome: 'success' });
      service.appendEntry({ actor: 'test', action: 'action2', resource: 'res2', outcome: 'success' });
      const result = service.verifyChain();
      expect(result.valid).toBe(true);
      expect(result.entriesChecked).toBe(2);
    });
  });

  it('exports CSV through the HTTP route and validates the report type', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/compliance', createComplianceRoutes(db));
    app.use(errorHandler);
    const server: Server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const csv = await fetch(`${baseUrl}/api/compliance/reports/export?type=nora&format=csv`);
      expect(csv.status).toBe(200);
      expect(csv.headers.get('content-type')).toContain('text/csv');
      expect(await csv.text()).toContain('control,description,status,evidence,recommendation');

      const invalid = await fetch(`${baseUrl}/api/compliance/reports/export?type=unknown`);
      expect(invalid.status).toBe(400);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
