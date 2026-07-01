import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface SecurityScanResult {
  id: string;
  target: string;
  scanType: 'dependency' | 'secret' | 'code' | 'config';
  findings: SecurityFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  scannedAt: string;
  durationMs: number;
}

export interface SecurityFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  message: string;
  location: string;
  remediation: string;
  cve?: string;
}

interface ScanRow {
  id: string;
  target: string;
  scan_type: string;
  findings_json: string;
  summary_json: string;
  duration_ms: number;
  created_at: string;
}

export class SecurityScanningAgent {
  private agentId = 'security-scanner';
  private agentName = 'Security Scanning Agent';

  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS security_scans (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        scan_type TEXT NOT NULL,
        findings_json TEXT NOT NULL DEFAULT '[]',
        summary_json TEXT NOT NULL DEFAULT '{}',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  getAgentInfo() {
    return {
      id: this.agentId,
      name: this.agentName,
      status: 'active',
      capabilities: ['security-scanning', 'vulnerability-detection', 'secret-detection', 'dependency-audit'],
      description: 'Scans for security vulnerabilities, secrets, and dependency issues',
    };
  }

  async scanCodebase(targetPath: string): Promise<SecurityScanResult> {
    const start = Date.now();
    const findings: SecurityFinding[] = [];

    findings.push(...this.scanForSecrets(targetPath));
    findings.push(...this.scanForDependencyIssues(targetPath));
    findings.push(...this.scanForCodePatterns(targetPath));

    const summary = this.summarizeFindings(findings);
    const duration = Date.now() - start;

    const result: SecurityScanResult = {
      id: randomUUID(),
      target: targetPath,
      scanType: 'code',
      findings,
      summary,
      scannedAt: new Date().toISOString(),
      durationMs: duration,
    };

    this.db.prepare(`
      INSERT INTO security_scans (id, target, scan_type, findings_json, summary_json, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(result.id, targetPath, 'code', JSON.stringify(findings), JSON.stringify(summary), duration);

    return result;
  }

  async scanDependencies(_targetPath: string): Promise<SecurityScanResult> {
    const start = Date.now();
    const findings: SecurityFinding[] = [];

    findings.push({
      id: randomUUID(),
      severity: 'info',
      category: 'dependency',
      message: 'Run npm audit for detailed dependency vulnerability report',
      location: 'package.json',
      remediation: 'Run: npm audit --audit-level=high',
    });

    const summary = this.summarizeFindings(findings);
    const duration = Date.now() - start;

    const result: SecurityScanResult = {
      id: randomUUID(),
      target: _targetPath,
      scanType: 'dependency',
      findings,
      summary,
      scannedAt: new Date().toISOString(),
      durationMs: duration,
    };

    this.db.prepare(`
      INSERT INTO security_scans (id, target, scan_type, findings_json, summary_json, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(result.id, _targetPath, 'dependency', JSON.stringify(findings), JSON.stringify(summary), duration);

    return result;
  }

  getScanHistory(limit: number = 20): SecurityScanResult[] {
    const rows = this.db.prepare('SELECT * FROM security_scans ORDER BY created_at DESC LIMIT ?').all(limit) as ScanRow[];
    return rows.map(r => ({
      id: r.id,
      target: r.target,
      scanType: r.scan_type as SecurityScanResult['scanType'],
      findings: JSON.parse(r.findings_json) as SecurityFinding[],
      summary: JSON.parse(r.summary_json) as SecurityScanResult['summary'],
      scannedAt: r.created_at,
      durationMs: r.duration_ms,
    }));
  }

  private scanForSecrets(targetPath: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const fs = require('fs');
    const path = require('path');

    const secretPatterns = [
      { pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/gi, category: 'hardcoded-password' },
      { pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{16,}['"]/gi, category: 'hardcoded-api-key' },
      { pattern: /AKIA[0-9A-Z]{16}/g, category: 'aws-access-key' },
      { pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, category: 'private-key' },
    ];

    const scanDir = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'dist' && entry.name !== '.data') {
              scanDir(fullPath);
            }
          } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.json')) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              for (const { pattern, category } of secretPatterns) {
                const matches = content.match(pattern);
                if (matches) {
                  findings.push({
                    id: randomUUID(),
                    severity: category === 'private-key' ? 'critical' : 'high',
                    category,
                    message: `Potential ${category.replace(/-/g, ' ')} found (${matches.length} occurrences)`,
                    location: fullPath,
                    remediation: `Remove hardcoded secrets from ${fullPath} and use environment variables or a secrets manager`,
                  });
                }
              }
            } catch { /* skip unreadable */ }
          }
        }
      } catch { /* skip */ }
    };

    try { scanDir(targetPath); } catch { /* skip */ }
    return findings.slice(0, 20);
  }

  private scanForDependencyIssues(_targetPath: string): SecurityFinding[] {
    return [{
      id: randomUUID(),
      severity: 'info',
      category: 'dependency',
      message: 'Use npm audit or Snyk for comprehensive dependency scanning',
      location: 'package.json',
      remediation: 'Run: npm audit fix --force',
    }];
  }

  private scanForCodePatterns(targetPath: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const fs = require('fs');
    const path = require('path');

    const dangerousPatterns = [
      { pattern: /eval\s*\(/g, category: 'eval-usage', severity: 'high' as const },
      { pattern: /execSync\([^)]+\{[^}]*cwd[^}]*encoding(?!.*timeout)/g, category: 'execSync-no-timeout', severity: 'medium' as const },
      { pattern: /innerHTML\s*=/g, category: 'xss-risk', severity: 'medium' as const },
    ];

    const scanDir = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'dist' && entry.name !== '.data' && entry.name !== '__tests__') {
              scanDir(fullPath);
            }
          } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              for (const { pattern, category, severity } of dangerousPatterns) {
                const matches = content.match(pattern);
                if (matches && matches.length > 0) {
                  findings.push({
                    id: randomUUID(),
                    severity,
                    category,
                    message: `${category} found (${matches.length} occurrences)`,
                    location: fullPath,
                    remediation: `Review ${category} usage in ${fullPath}`,
                  });
                }
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    };

    try { scanDir(targetPath); } catch { /* skip */ }
    return findings.slice(0, 20);
  }

  private summarizeFindings(findings: SecurityFinding[]): SecurityScanResult['summary'] {
    return {
      critical: findings.filter(f => f.severity === 'critical').length,
      high: findings.filter(f => f.severity === 'high').length,
      medium: findings.filter(f => f.severity === 'medium').length,
      low: findings.filter(f => f.severity === 'low').length,
      info: findings.filter(f => f.severity === 'info').length,
    };
  }
}
