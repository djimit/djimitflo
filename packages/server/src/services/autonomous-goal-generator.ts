import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

interface GoalInput {
  objective: string;
  riskClass: 'low' | 'medium' | 'high' | 'critical';
  metadata: Record<string, unknown>;
  source: string;
}

export class AutonomousGoalGenerator {
  constructor(private db: Database) {}

  generateFromSelfImprovements(): number {
    const improvements = this.db.prepare(
      "SELECT * FROM self_improvements WHERE status = 'proposed' ORDER BY priority DESC LIMIT 5"
    ).all() as Array<{ id: string; title: string; description: string; type: string; priority: number; source: string }>;

    let created = 0;
    for (const imp of improvements) {
      const goalId = randomUUID();
      this.db.prepare(`
        INSERT OR IGNORE INTO goals (id, objective, status, risk_class, acceptance_criteria_json, budget_json, metadata, created_at, updated_at)
        VALUES (?, ?, 'created', ?, ?, '{}', ?, datetime('now'), datetime('now'))
      `).run(
        goalId,
        imp.title,
        imp.priority > 0.9 ? 'high' : imp.priority > 0.7 ? 'medium' : 'low',
        JSON.stringify(['Tests pass', 'No regressions']),
        JSON.stringify({ source: 'self-improvement', improvement_id: imp.id, type: imp.type, autonomous: true })
      );

      this.db.prepare("UPDATE self_improvements SET status = 'approved' WHERE id = ?").run(imp.id);
      created++;
    }

    return created;
  }

  generateFromSecurityFindings(): number {
    const findings = this.db.prepare(
      "SELECT * FROM security_scans WHERE created_at > datetime('now', '-1 day') ORDER BY id DESC LIMIT 1"
    ).all() as Array<{ id: string; findings_json: string }>;

    if (findings.length === 0) return 0;

    const latestScan = findings[0];
    const scanFindings = JSON.parse(latestScan.findings_json) as Array<{ severity: string; message: string; location: string }>;

    const highFindings = scanFindings.filter(f => f.severity === 'high' || f.severity === 'critical');
    if (highFindings.length === 0) return 0;

    const goalId = randomUUID();
    this.db.prepare(`
      INSERT OR IGNORE INTO goals (id, objective, status, risk_class, acceptance_criteria_json, budget_json, metadata, created_at, updated_at)
      VALUES (?, ?, 'created', ?, ?, '{}', ?, datetime('now'), datetime('now'))
    `).run(
      goalId,
      `Fix ${highFindings.length} high-severity security findings`,
      'high',
      JSON.stringify(['All security findings addressed', 'Tests pass']),
      JSON.stringify({ source: 'security-scan', scan_id: latestScan.id, findings_count: highFindings.length, autonomous: true })
    );

    return 1;
  }

  generateFromCuriosityGaps(): number {
    const gaps = this.db.prepare(
      "SELECT * FROM knowledge_gaps WHERE status = 'open' ORDER BY priority DESC LIMIT 3"
    ).all() as Array<{ id: string; domain: string; description: string; priority: number }>;

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
