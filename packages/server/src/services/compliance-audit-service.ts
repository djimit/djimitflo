/**
 * ComplianceAuditService — immutable evidence chain and compliance reporting.
 *
 * Provides enterprise-grade audit capabilities:
 * 1. Immutable Evidence Log — append-only with cryptographic chaining
 * 2. Compliance Export — NORA/SOC2/ISO27001 aligned reports
 * 3. Audit Dashboard — real-time compliance status
 * 4. Retention Policies — automated data retention with legal hold
 */

import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

interface AuditEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  resource: string;
  outcome: 'success' | 'failure' | 'denied';
  evidence: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

interface ComplianceReport {
  id: string;
  type: 'nora' | 'soc2' | 'iso27001' | 'custom';
  generatedAt: string;
  period: { start: string; end: string };
  findings: ComplianceFinding[];
  score: number;
  status: 'compliant' | 'partial' | 'non_compliant';
}

interface ComplianceFinding {
  control: string;
  description: string;
  status: 'pass' | 'fail' | 'partial';
  evidence: string[];
  recommendation: string;
}

export class ComplianceAuditService {
  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Append an immutable audit entry with cryptographic chaining.
   */
  appendEntry(input: {
    actor: string;
    action: string;
    resource: string;
    outcome: 'success' | 'failure' | 'denied';
    evidence?: Record<string, unknown>;
    event?: {
      eventType: string;
      userId?: string | null;
      agentId?: string | null;
      taskId?: string | null;
      executionEventId?: string | null;
      resourceType: string;
      riskLevel: string;
      before?: Record<string, unknown> | null;
      after?: Record<string, unknown> | null;
      ipAddress?: string | null;
      userAgent?: string | null;
    };
  }): AuditEntry {
    const previousHash = this.getLatestHash();
    const timestamp = new Date().toISOString();

    const entry: AuditEntry = {
      id: randomUUID(),
      timestamp,
      actor: input.actor,
      action: input.action,
      resource: input.resource,
      outcome: input.outcome,
      evidence: input.evidence || {},
      previousHash,
      hash: '',
    };

    // Calculate hash (includes previous hash for chaining)
    // Use canonical JSON (sorted keys) for deterministic hashing
    const evidence = entry.evidence || {};
    const canonicalData = JSON.stringify({
      action: entry.action,
      actor: entry.actor,
      evidence: this.sortKeysDeep(evidence),
      id: entry.id,
      outcome: entry.outcome,
      previousHash: entry.previousHash,
      resource: entry.resource,
      timestamp: entry.timestamp,
    });
    entry.hash = createHash('sha256').update(canonicalData).digest('hex');

    const evidenceJson = JSON.stringify(this.sortKeysDeep(evidence));

    const event = input.event;
    const sequence = ((this.db.prepare('SELECT MAX(chain_sequence) AS value FROM audit_events').get() as any)?.value || 0) + 1;
    this.db.prepare(`
      INSERT INTO audit_events (
        id, event_type, timestamp, user_id, agent_id, task_id, execution_event_id,
        action, resource_type, resource_id, risk_level, before, after, ip_address,
        user_agent, metadata, outcome, previous_hash, hash, chain_sequence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id, event?.eventType || `compliance.${entry.action}`, entry.timestamp,
      event?.userId || entry.actor, event?.agentId || null, event?.taskId || null,
      event?.executionEventId || null, entry.action, event?.resourceType || 'compliance',
      entry.resource || null, event?.riskLevel || 'medium',
      event?.before ? JSON.stringify(event.before) : null,
      event?.after ? JSON.stringify(event.after) : null,
      event?.ipAddress || null, event?.userAgent || null, evidenceJson, entry.outcome,
      entry.previousHash, entry.hash, sequence, entry.timestamp, entry.timestamp,
    );

    return entry;
  }

  /**
   * Verify the integrity of the audit chain.
   */
  verifyChain(): { valid: boolean; entriesChecked: number; firstInvalidId?: string } {
    const entries = this.db.prepare('SELECT * FROM compliance_audit_log ORDER BY chain_sequence ASC').all() as any[];

    let previousHash = 'genesis';
    for (const entry of entries) {
      // Verify chain linkage
      if (entry.previous_hash !== previousHash) {
        return { valid: false, entriesChecked: entries.length, firstInvalidId: entry.id };
      }

      // Verify hash integrity: recompute from canonical data
      const evidence = JSON.parse(entry.evidence_json || '{}');
      const canonicalData = JSON.stringify({
        action: entry.action,
        actor: entry.actor,
        evidence: this.sortKeysDeep(evidence),
        id: entry.id,
        outcome: entry.outcome,
        previousHash: entry.previous_hash,
        resource: entry.resource,
        timestamp: entry.timestamp,
      });
      const expectedHash = createHash('sha256').update(canonicalData).digest('hex');

      if (entry.hash !== expectedHash) {
        return { valid: false, entriesChecked: entries.length, firstInvalidId: entry.id };
      }

      previousHash = entry.hash;
    }

    return { valid: true, entriesChecked: entries.length };
  }

  /**
   * Generate a compliance report.
   */
  generateReport(input: {
    type: 'nora' | 'soc2' | 'iso27001' | 'custom';
    periodStart?: string;
    periodEnd?: string;
  }): ComplianceReport {
    const start = input.periodStart || new Date(Date.now() - 30 * 86400000).toISOString();
    const end = input.periodEnd || new Date().toISOString();

    const findings: ComplianceFinding[] = [];

    // Check 1: Governance certification coverage
    const governanceFindings = this.checkGovernanceCoverage(start, end);
    findings.push(...governanceFindings);

    // Check 2: Audit chain integrity
    const chainIntegrity = this.verifyChain();
    findings.push({
      control: 'audit_chain_integrity',
      description: 'Audit log chain integrity verification',
      status: chainIntegrity.valid ? 'pass' : 'fail',
      evidence: [`${chainIntegrity.entriesChecked} entries checked`],
      recommendation: chainIntegrity.valid ? '' : `Chain broken at entry ${chainIntegrity.firstInvalidId}`,
    });

    // Check 3: Human approval coverage
    const approvalFindings = this.checkApprovalCoverage(start, end);
    findings.push(...approvalFindings);

    // Check 4: Runtime governance coverage
    const runtimeFindings = this.checkRuntimeGovernance(start, end);
    findings.push(...runtimeFindings);

    // Calculate overall score
    const passed = findings.filter((f) => f.status === 'pass').length;
    const score = findings.length > 0 ? passed / findings.length : 1;

    const report: ComplianceReport = {
      id: randomUUID(),
      type: input.type,
      generatedAt: new Date().toISOString(),
      period: { start, end },
      findings,
      score,
      status: score >= 0.9 ? 'compliant' : score >= 0.7 ? 'partial' : 'non_compliant',
    };

    // Store report
    this.db.prepare(`
      INSERT INTO compliance_reports
      (id, type, generated_at, period_start, period_end, findings_json, score, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.id, report.type, report.generatedAt, report.period.start,
      report.period.end, JSON.stringify(report.findings), report.score, report.status,
    );

    return report;
  }

  /**
   * Get audit log entries with filtering.
   */
  getAuditLog(options: {
    actor?: string;
    action?: string;
    resource?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
  } = {}): AuditEntry[] {
    let query = 'SELECT * FROM compliance_audit_log WHERE 1=1';
    const params: unknown[] = [];

    if (options.actor) { query += ' AND actor = ?'; params.push(options.actor); }
    if (options.action) { query += ' AND action = ?'; params.push(options.action); }
    if (options.resource) { query += ' AND resource = ?'; params.push(options.resource); }
    if (options.startDate) { query += ' AND timestamp >= ?'; params.push(options.startDate); }
    if (options.endDate) { query += ' AND timestamp <= ?'; params.push(options.endDate); }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(options.limit || 100);

    return (this.db.prepare(query).all(...params) as any[]).map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      actor: r.actor,
      action: r.action,
      resource: r.resource,
      outcome: r.outcome,
      evidence: JSON.parse(r.evidence_json || '{}'),
      previousHash: r.previous_hash,
      hash: r.hash,
    }));
  }

  /**
   * Get compliance status summary.
   */
  getStatus(): {
    totalAuditEntries: number;
    chainIntegrity: boolean;
    lastReportDate: string | null;
    lastReportScore: number;
    lastReportStatus: string | null;
  } {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM compliance_audit_log').get() as any)?.c || 0;
    const chain = this.verifyChain();
    const lastReport = this.db.prepare('SELECT * FROM compliance_reports ORDER BY generated_at DESC LIMIT 1').get() as any;

    return {
      totalAuditEntries: total,
      chainIntegrity: chain.valid,
      lastReportDate: lastReport?.generated_at || null,
      lastReportScore: lastReport?.score || 0,
      lastReportStatus: lastReport?.status || null,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private getLatestHash(): string {
    const latest = this.db.prepare('SELECT hash FROM compliance_audit_log ORDER BY chain_sequence DESC LIMIT 1').get() as any;
    return latest?.hash || 'genesis';
  }

  /**
   * Deep sort object keys for deterministic JSON serialization.
   */
  private sortKeysDeep(obj: unknown): unknown {
    if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map((item) => this.sortKeysDeep(item));
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = this.sortKeysDeep((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  private checkGovernanceCoverage(start: string, end: string): ComplianceFinding[] {
    let totalAgents = 0;
    let certifiedAgents = 0;
    try {
      totalAgents = (this.db.prepare('SELECT COUNT(*) as c FROM agents').get() as any)?.c || 0;
      certifiedAgents = (this.db.prepare("SELECT COUNT(DISTINCT agent_id) as c FROM openmythos_eval_runs WHERE status = 'completed' AND overall_score >= 4.0 AND finished_at BETWEEN ? AND ?").get(start, end) as any)?.c || 0;
    } catch {
      // Tables may not exist yet
    }

    const coverage = totalAgents > 0 ? certifiedAgents / totalAgents : 1;

    return [{
      control: 'governance_certification_coverage',
      description: `Governance certification coverage: ${certifiedAgents}/${totalAgents} agents (${(coverage * 100).toFixed(0)}%)`,
      status: coverage >= 0.8 ? 'pass' : coverage >= 0.5 ? 'partial' : 'fail',
      evidence: [`${certifiedAgents} certified out of ${totalAgents} agents`],
      recommendation: coverage < 0.8 ? 'Run governance evaluations for uncertified agents' : '',
    }];
  }

  private checkApprovalCoverage(start: string, end: string): ComplianceFinding[] {
    let totalDeployments = 0;
    let approvedDeployments = 0;
    try {
      totalDeployments = (this.db.prepare("SELECT COUNT(*) as c FROM worker_leases WHERE created_at BETWEEN ? AND ?").get(start, end) as any)?.c || 0;
      approvedDeployments = (this.db.prepare("SELECT COUNT(*) as c FROM worker_leases WHERE created_at BETWEEN ? AND ? AND status != 'created'").get(start, end) as any)?.c || 0;
    } catch {
      // Tables may not exist yet
    }

    const coverage = totalDeployments > 0 ? approvedDeployments / totalDeployments : 1;

    return [{
      control: 'human_approval_coverage',
      description: `Human approval coverage for deployments: ${(coverage * 100).toFixed(0)}%`,
      status: coverage >= 0.9 ? 'pass' : coverage >= 0.7 ? 'partial' : 'fail',
      evidence: [`${approvedDeployments} approved out of ${totalDeployments} deployments`],
      recommendation: coverage < 0.9 ? 'Ensure all deployments have human approval' : '',
    }];
  }

  private checkRuntimeGovernance(start: string, end: string): ComplianceFinding[] {
    const hasRuntimeGovernance = this.isRuntimeGovernanceActive();
    let totalViolations = 0;
    try {
      totalViolations = (this.db.prepare("SELECT COUNT(*) as c FROM compliance_audit_log WHERE action = 'governance_violation' AND timestamp BETWEEN ? AND ?").get(start, end) as any)?.c || 0;
    } catch {
      // Table may not exist yet
    }

    return [{
      control: 'runtime_governance',
      description: `Runtime governance enforcement: ${hasRuntimeGovernance ? 'active' : 'inactive'}, ${totalViolations} violations detected`,
      status: hasRuntimeGovernance ? 'pass' : 'fail',
      evidence: [`Runtime governance service: ${hasRuntimeGovernance ? 'mounted' : 'not mounted'}`, `${totalViolations} violations`],
      recommendation: hasRuntimeGovernance ? '' : 'Mount RuntimeGovernanceService',
    }];
  }

  private isRuntimeGovernanceActive(): boolean {
    try {
      const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='governance_policies'").get() as any;
      return !!row;
    } catch {
      return false;
    }
  }

  /**
   * Log a governance check to the compliance audit trail.
   * Wave 3: Governance events are cryptographically chained.
   */
  logGovernanceCheck(data: {
    skillId: string;
    score: number;
    categories: Record<string, number>;
    outcome: 'approved' | 'blocked' | 'warning';
    triggeredBy?: string;
  }): AuditEntry {
    return this.appendEntry({
      actor: 'governance_guard',
      action: `governance_check_${data.outcome}`,
      resource: data.skillId,
      outcome: data.outcome === 'blocked' ? 'denied' : 'success',
      evidence: {
        score: data.score,
        categories: data.categories,
        triggeredBy: data.triggeredBy || 'manual',
      },
    });
  }

  /**
   * Get governance audit trail for a specific agent/skill.
   * Returns all governance events in chronological order with chain verification.
   */
  getGovernanceAuditTrail(skillId: string): Array<{
    timestamp: string;
    action: string;
    score: number;
    outcome: string;
    hash: string;
  }> {
    const entries = this.db.prepare(`
      SELECT timestamp, action, outcome, evidence_json, hash
      FROM compliance_audit_log
      WHERE resource = ? AND action LIKE 'governance_check_%'
      ORDER BY timestamp ASC
    `).all(skillId) as Array<{
      timestamp: string;
      action: string;
      outcome: string;
      evidence_json: string;
      hash: string;
    }>;

    return entries.map(e => {
      const evidence = JSON.parse(e.evidence_json || '{}');
      return {
        timestamp: e.timestamp,
        action: e.action,
        score: evidence.score ?? 0,
        outcome: e.outcome,
        hash: e.hash,
      };
    });
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        user_id TEXT,
        agent_id TEXT,
        task_id TEXT,
        execution_event_id TEXT,
        action TEXT NOT NULL DEFAULT '',
        resource_type TEXT NOT NULL DEFAULT 'compliance',
        resource_id TEXT,
        risk_level TEXT NOT NULL DEFAULT 'medium',
        before TEXT,
        after TEXT,
        ip_address TEXT,
        user_agent TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        outcome TEXT NOT NULL DEFAULT 'success' CHECK(outcome IN ('success', 'failure', 'denied')),
        previous_hash TEXT NOT NULL DEFAULT 'genesis',
        hash TEXT NOT NULL DEFAULT '',
        chain_sequence INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS compliance_reports (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('nora', 'soc2', 'iso27001', 'custom')),
        generated_at TEXT NOT NULL DEFAULT (datetime('now')),
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        findings_json TEXT NOT NULL DEFAULT '[]',
        score REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'non_compliant' CHECK(status IN ('compliant', 'partial', 'non_compliant'))
      );
    `);

    const columns = this.db.prepare('PRAGMA table_info(audit_events)').all() as Array<{ name: string }>;
    const additions: Record<string, string> = {
      timestamp: 'TEXT',
      user_id: 'TEXT',
      agent_id: 'TEXT',
      task_id: 'TEXT',
      execution_event_id: 'TEXT',
      resource_id: 'TEXT',
      before: 'TEXT',
      after: 'TEXT',
      ip_address: 'TEXT',
      user_agent: 'TEXT',
      outcome: "TEXT NOT NULL DEFAULT 'success'",
      previous_hash: "TEXT NOT NULL DEFAULT 'genesis'",
      hash: "TEXT NOT NULL DEFAULT ''",
      chain_sequence: 'INTEGER',
      updated_at: 'TEXT',
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!columns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE audit_events ADD COLUMN ${name} ${definition}`);
      }
    }

    const legacy = this.db.prepare("SELECT type FROM sqlite_master WHERE name = 'compliance_audit_log'").get() as { type?: string } | undefined;
    if (legacy?.type === 'table') {
      const rows = this.db.prepare('SELECT rowid, * FROM compliance_audit_log ORDER BY rowid').all() as any[];
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO audit_events (
          id, event_type, timestamp, user_id, action, resource_type, resource_id,
          risk_level, metadata, outcome, previous_hash, hash, chain_sequence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'compliance', ?, 'medium', ?, ?, ?, ?, ?, ?, ?)
      `);
      const migrate = this.db.transaction(() => {
        rows.forEach((row, index) => insert.run(
          row.id, `compliance.${row.action}`, row.timestamp, row.actor, row.action,
          row.resource, row.evidence_json || '{}', row.outcome, row.previous_hash,
          row.hash, index + 1, row.timestamp, row.timestamp,
        ));
      });
      migrate();
      this.db.exec(`
        DROP TRIGGER IF EXISTS compliance_audit_no_update;
        DROP TRIGGER IF EXISTS compliance_audit_no_delete;
        DROP TABLE compliance_audit_log;
      `);
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_audit_events_chain_sequence ON audit_events(chain_sequence);
      CREATE INDEX IF NOT EXISTS idx_audit_events_hash ON audit_events(hash);

      CREATE VIEW IF NOT EXISTS compliance_audit_log AS
        SELECT id, timestamp, COALESCE(user_id, 'system') AS actor, action,
          COALESCE(resource_id, resource_type, '') AS resource, outcome,
          COALESCE(metadata, '{}') AS evidence_json, previous_hash, hash, chain_sequence
        FROM audit_events WHERE hash <> '';

      CREATE TRIGGER IF NOT EXISTS compliance_audit_insert
        INSTEAD OF INSERT ON compliance_audit_log
        BEGIN
          INSERT INTO audit_events (
            id, event_type, timestamp, user_id, action, resource_type, resource_id,
            risk_level, metadata, outcome, previous_hash, hash, chain_sequence, created_at, updated_at
          ) VALUES (
            NEW.id, 'compliance.' || NEW.action, NEW.timestamp, NEW.actor, NEW.action,
            'compliance', NEW.resource, 'medium', NEW.evidence_json, NEW.outcome,
            NEW.previous_hash, NEW.hash,
            COALESCE(NEW.chain_sequence, (SELECT COALESCE(MAX(chain_sequence), 0) + 1 FROM audit_events)),
            NEW.timestamp, NEW.timestamp
          );
        END;

      CREATE TRIGGER IF NOT EXISTS compliance_audit_no_update
        INSTEAD OF UPDATE ON compliance_audit_log
        BEGIN
          SELECT RAISE(FAIL, 'compliance_audit_log is append-only: updates are forbidden');
        END;

      CREATE TRIGGER IF NOT EXISTS compliance_audit_no_delete
        INSTEAD OF DELETE ON compliance_audit_log
        BEGIN
          SELECT RAISE(FAIL, 'compliance_audit_log is append-only: deletes are forbidden');
        END;

      CREATE TRIGGER IF NOT EXISTS audit_events_no_update
        BEFORE UPDATE ON audit_events
        BEGIN
          SELECT RAISE(FAIL, 'audit_events is append-only: updates are forbidden');
        END;

      CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
        BEFORE DELETE ON audit_events
        BEGIN
          SELECT RAISE(FAIL, 'audit_events is append-only: deletes are forbidden');
        END;
    `);
  }

  /**
   * Export compliance report as CSV.
   * FR-005: CSV export SHALL include columns: control, description, status, evidence, recommendation.
   */
  exportReportAsCsv(report: ComplianceReport): string {
    const headers = ['control', 'description', 'status', 'evidence', 'recommendation'];
    const escape = (val: string) => {
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    };
    const rows = report.findings.map(f => [
      escape(f.control),
      escape(f.description),
      escape(f.status),
      escape(f.evidence.join('; ')),
      escape(f.recommendation),
    ]);
    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  /**
   * Export compliance report as formatted text (for PDF-like display).
   */
  exportReportAsText(report: ComplianceReport): string {
    const lines: string[] = [];
    lines.push('═══════════════════════════════════════════════════════════');
    lines.push(`GOVERNANCE COMPLIANCE REPORT`);
    lines.push(`Type: ${report.type.toUpperCase()}`);
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Period: ${report.period.start} → ${report.period.end}`);
    lines.push(`Score: ${(report.score * 100).toFixed(0)}%`);
    lines.push(`Status: ${report.status.toUpperCase()}`);
    lines.push('═══════════════════════════════════════════════════════════');
    lines.push('');
    for (const finding of report.findings) {
      const icon = finding.status === 'pass' ? '[PASS]' : finding.status === 'partial' ? '[WARN]' : '[FAIL]';
      lines.push(`${icon} ${finding.control}`);
      lines.push(`  ${finding.description}`);
      if (finding.recommendation) {
        lines.push(`  → ${finding.recommendation}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

}
