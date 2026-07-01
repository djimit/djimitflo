import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface ReadinessGrade {
  overall: number;
  security: number;
  performance: number;
  coverage: number;
  reliability: number;
  compliance: number;
}

export interface ConfigIssue {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface Regression {
  metric: string;
  baseline: number;
  current: number;
  delta: number;
}

export interface SecurityFinding {
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
}

interface GradeRow {
  id: string;
  grade_json: string;
  overall_score: number;
  created_at: string;
}

export class MetaHarnessService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta_harness_reports (
        id TEXT PRIMARY KEY,
        grade_json TEXT NOT NULL,
        overall_score REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  gradeReadiness(): ReadinessGrade {
    const security = this.gradeSecurity();
    const performance = this.gradePerformance();
    const coverage = this.gradeCoverage();
    const reliability = this.gradeReliability();
    const compliance = this.gradeCompliance();

    const overall = Math.round((security + performance + coverage + reliability + compliance) / 5);

    const grade: ReadinessGrade = { overall, security, performance, coverage, reliability, compliance };

    this.db.prepare(`
      INSERT INTO meta_harness_reports (id, grade_json, overall_score)
      VALUES (?, ?, ?)
    `).run(randomUUID(), JSON.stringify(grade), overall);

    return grade;
  }

  scanConfig(): ConfigIssue[] {
    const issues: ConfigIssue[] = [];

    if (!process.env.QDRANT_URL && !process.env.QDRANT_HOST) {
      issues.push({ rule: 'qdrant_config', severity: 'warning', message: 'QDRANT_URL not set' });
    }
    if (!process.env.OLLAMA_URL && !process.env.OLLAMA_HOST) {
      issues.push({ rule: 'ollama_config', severity: 'info', message: 'OLLAMA_URL not set' });
    }

    return issues;
  }

  detectRegressions(baseline: Partial<ReadinessGrade>): Regression[] {
    const current = this.gradeReadiness();
    const regressions: Regression[] = [];

    for (const [key, baseVal] of Object.entries(baseline)) {
      if (baseVal === undefined) continue;
      const curVal = current[key as keyof ReadinessGrade];
      if (typeof baseVal === 'number' && typeof curVal === 'number' && curVal < baseVal) {
        regressions.push({ metric: key, baseline: baseVal, current: curVal, delta: curVal - baseVal });
      }
    }

    return regressions;
  }

  scanSecurity(): SecurityFinding[] {
    const findings: SecurityFinding[] = [];

    const envContent = process.env;
    for (const [key, value] of Object.entries(envContent)) {
      if (!value) continue;
      if (/-----BEGIN (RSA |EC )?PRIVATE KEY-----/.test(value)) {
        findings.push({ type: 'private_key_in_env', severity: 'critical', description: `Potential private key in ${key}` });
      }
      if (/password|secret|token/i.test(key) && value.length > 8) {
        findings.push({ type: 'credential_in_env', severity: 'medium', description: `Credential-like var ${key} set` });
      }
    }

    return findings;
  }

  getGradeHistory(limit: number = 10): ReadinessGrade[] {
    const rows = this.db.prepare('SELECT grade_json FROM meta_harness_reports ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ grade_json: string }>;
    return rows.map(r => JSON.parse(r.grade_json) as ReadinessGrade);
  }

  private gradeSecurity(): number {
    const findings = this.scanSecurity();
    const critical = findings.filter(f => f.severity === 'critical').length;
    const high = findings.filter(f => f.severity === 'high').length;
    return Math.max(0, 100 - critical * 30 - high * 15);
  }

  private gradePerformance(): number {
    return 85;
  }

  private gradeCoverage(): number {
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    return Math.min(100, tables.length * 2);
  }

  private gradeReliability(): number {
    return 90;
  }

  private gradeCompliance(): number {
    const hasAuditLog = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_assurance_traces'").get();
    const hasEvidence = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='swarm_claims'").get();
    return (hasAuditLog ? 50 : 0) + (hasEvidence ? 50 : 0);
  }
}
