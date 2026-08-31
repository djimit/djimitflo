import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export class AutonomousGoalGenerator {
  constructor(private db: Database) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS security_scans (
      id TEXT PRIMARY KEY, target TEXT NOT NULL, scan_type TEXT NOT NULL DEFAULT 'code',
      findings_json TEXT NOT NULL DEFAULT '[]', summary_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_gaps (
      id TEXT PRIMARY KEY, domain TEXT NOT NULL, description TEXT NOT NULL,
      priority REAL NOT NULL DEFAULT 0.5, status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  }

  generateFromSelfImprovements(): number {
    let improvements: Array<{ id: string; title: string; description: string; type: string; priority: number; source: string }> = [];
    try {
      improvements = this.db.prepare(
        "SELECT * FROM self_improvements WHERE status = 'scheduled' ORDER BY priority DESC LIMIT 5"
      ).all() as Array<{ id: string; title: string; description: string; type: string; priority: number; source: string }>;
    } catch { return 0; }

    let created = 0;
    for (const improvement of improvements) created += this.generateImprovement(improvement.id);

    return created;
  }

  generateImprovement(id: string): number {
    return this.db.transaction(() => this.generateImprovementInTransaction(id))();
  }

  private generateImprovementInTransaction(id: string): number {
    const improvement = this.db.prepare(
      "SELECT * FROM self_improvements WHERE id = ? AND status = 'scheduled'"
    ).get(id) as { id: string; title: string; type: string; priority: number } | undefined;
    if (!improvement) return 0;

    const existing = this.db.prepare(
      "SELECT id, improvement_id FROM goals WHERE improvement_id = ? OR json_extract(metadata, '$.improvement_id') = ? LIMIT 1"
    ).get(id, id) as { id: string; improvement_id: string | null } | undefined;
    if (existing) {
      if (!existing.improvement_id) this.db.prepare('UPDATE goals SET improvement_id = ? WHERE id = ?').run(id, existing.id);
      this.db.prepare("UPDATE self_improvements SET status = 'executing' WHERE id = ?").run(id);
      return 0;
    }

    this.db.prepare(`
      INSERT INTO goals (id, objective, status, risk_class, acceptance_criteria_json, budget_json, improvement_id, metadata, created_at, updated_at)
      VALUES (?, ?, 'created', ?, ?, '{}', ?, ?, datetime('now'), datetime('now'))
    `).run(
      randomUUID(),
      improvement.title,
      improvement.priority > 0.9 ? 'high' : improvement.priority > 0.7 ? 'medium' : 'low',
      JSON.stringify(['Tests pass', 'No regressions', 'Checker evidence accepted']),
      improvement.id,
      JSON.stringify({ source: 'self-improvement', improvement_id: improvement.id, type: improvement.type, autonomous: false })
    );
    this.db.prepare("UPDATE self_improvements SET status = 'executing' WHERE id = ?").run(id);
    return 1;
  }

  generateFromSecurityFindings(): number {
    let findings: Array<{ id: string; findings_json: string }> = [];
    try {
      findings = this.db.prepare(
        "SELECT * FROM security_scans WHERE created_at > datetime('now', '-1 day') ORDER BY id DESC LIMIT 1"
      ).all() as Array<{ id: string; findings_json: string }>;
    } catch { return 0; }

    if (findings.length === 0) return 0;

    const latestScan = findings[0];
    const scanFindings = JSON.parse(latestScan.findings_json) as Array<{ severity: string; message: string; location: string }>;

    const highFindings = scanFindings.filter(f => f.severity === 'high' || f.severity === 'critical');
    if (highFindings.length === 0) return 0;

    const goalId = `security-scan:${latestScan.id}`;
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO goals (id, objective, status, risk_class, acceptance_criteria_json, budget_json, metadata, created_at, updated_at)
      VALUES (?, ?, 'created', ?, ?, '{}', ?, datetime('now'), datetime('now'))
    `).run(
      goalId,
      `Fix ${highFindings.length} high-severity security findings`,
      'high',
      JSON.stringify(['All security findings addressed', 'Tests pass']),
      JSON.stringify({ source: 'security-scan', scan_id: latestScan.id, findings_count: highFindings.length, autonomous: true })
    );

    return result.changes;
  }

  generateFromCuriosityGaps(): number {
    let gaps: Array<{ id: string; domain: string; description: string; priority: number }> = [];
    try {
      gaps = this.db.prepare(
        "SELECT * FROM knowledge_gaps WHERE status = 'open' ORDER BY priority DESC LIMIT 3"
      ).all() as Array<{ id: string; domain: string; description: string; priority: number }>;
    } catch { return 0; }

    let created = 0;
    for (const gap of gaps) {
      const goalId = randomUUID();
      this.db.prepare(`
        INSERT OR IGNORE INTO goals (id, objective, status, risk_class, acceptance_criteria_json, budget_json, metadata, created_at, updated_at)
        VALUES (?, ?, 'created', ?, ?, '{}', ?, datetime('now'), datetime('now'))
      `).run(
        goalId,
        `Investigate knowledge gap: ${gap.domain}`,
        'low',
        JSON.stringify(['Knowledge gap addressed', 'Documentation updated']),
        JSON.stringify({ source: 'curiosity-gap', gap_id: gap.id, autonomous: true })
      );

      this.db.prepare("UPDATE knowledge_gaps SET status = 'addressing' WHERE id = ?").run(gap.id);
      created++;
    }

    return created;
  }

  generateAll(): { improvements: number; security: number; curiosity: number; total: number } {
    const improvements = this.generateFromSelfImprovements();
    const security = this.generateFromSecurityFindings();
    const curiosity = this.generateFromCuriosityGaps();

    return {
      improvements,
      security,
      curiosity,
      total: improvements + security + curiosity,
    };
  }

  getAutonomousGoals(): Array<{ id: string; objective: string; risk_class: string; status: string; metadata: string }> {
    return this.db.prepare(
      "SELECT id, objective, risk_class, status, metadata FROM goals WHERE metadata LIKE '%\"autonomous\":true%' ORDER BY created_at DESC LIMIT 20"
    ).all() as Array<{ id: string; objective: string; risk_class: string; status: string; metadata: string }>;
  }
}
