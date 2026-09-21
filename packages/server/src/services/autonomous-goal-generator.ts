import { recordAuthorityEvent } from './authority-ledger-service';
import { enqueueEvent } from './event-outbox-service';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { SelfImprovementService } from './self-improvement-service';

export class AutonomousGoalGenerator {
  constructor(private db: Database) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS security_scans (
      id TEXT PRIMARY KEY, target TEXT NOT NULL, scan_type TEXT NOT NULL DEFAULT 'code',
      findings_json TEXT NOT NULL DEFAULT '[]', summary_json TEXT NOT NULL DEFAULT '{}',
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

    const goalId = randomUUID();
    this.db.prepare(`
      INSERT INTO goals (id, objective, status, risk_class, acceptance_criteria_json, budget_json, improvement_id, metadata, created_at, updated_at)
      VALUES (?, ?, 'created', ?, ?, '{}', ?, ?, datetime('now'), datetime('now'))
    `).run(
      goalId,
      improvement.title,
      improvement.priority > 0.9 ? 'high' : improvement.priority > 0.7 ? 'medium' : 'low',
      JSON.stringify(['Tests pass', 'No regressions', 'Checker evidence accepted']),
      improvement.id,
      JSON.stringify({ source: 'self-improvement', improvement_id: improvement.id, type: improvement.type, autonomous: false })
    );
    this.db.prepare("UPDATE self_improvements SET status = 'executing' WHERE id = ?").run(id);
    // The panel authorised this goal: record it as the PLAN_APPROVED ALLOW the (optional) authority gate looks for.
    recordAuthorityEvent(this.db, { correlationId: goalId, artifactId: goalId, actorSubject: 'specialist-panel', actorType: 'agent', requestedState: 'PLAN_APPROVED', decision: 'ALLOW', payload: { improvement_id: id, title: improvement.title }, evidenceRefs: [`improvement:${id}`] });
    enqueueEvent(this.db, { type: 'djimitflo.goal.created', aggregateId: goalId, payload: { goal_id: goalId, improvement_id: id, title: improvement.title, source: 'self-improvement' } });
    return 1;
  }

  /**
   * Found 2026-09-21: this used to create a goal directly at risk_class:'high',
   * fully autonomous, with no specialist panel review at all — the one
   * category needing the most scrutiny skipped it entirely. Now routes
   * through SelfImprovementService's reviewed pipeline, exactly like every
   * other proposal source — a goal is still created, but only once a
   * specialist panel authorizes it (via the existing generateFromSelfImprovements()
   * path above). Incidental fix: dedup is now by finding content
   * (fingerprint), not scan id, so an hourly re-scan reporting the same
   * unresolved finding no longer creates a fresh duplicate every cycle.
   */
  generateFromSecurityFindings(): number {
    let scans: Array<{ id: string; findings_json: string }> = [];
    try {
      scans = this.db.prepare(
        "SELECT * FROM security_scans WHERE created_at > datetime('now', '-1 day') ORDER BY id DESC LIMIT 1"
      ).all() as Array<{ id: string; findings_json: string }>;
    } catch { return 0; }

    if (scans.length === 0) return 0;

    const latestScan = scans[0];
    const scanFindings = JSON.parse(latestScan.findings_json) as Array<{ severity: string; category?: string; message: string; location?: string }>;

    const highFindings = scanFindings.filter(f => f.severity === 'high' || f.severity === 'critical');
    if (highFindings.length === 0) return 0;

    const descriptions = highFindings.map(f =>
      `${f.severity}${f.category ? ` ${f.category}` : ''} finding${f.location ? ` at ${f.location}` : ''}: ${f.message}`
    );
    return new SelfImprovementService(this.db).generateFromSecurityFindings(descriptions).length;
  }

  generateAll(): { improvements: number; security: number; total: number } {
    const improvements = this.generateFromSelfImprovements();
    const security = this.generateFromSecurityFindings();

    return {
      improvements,
      security,
      total: improvements + security,
    };
  }

  getAutonomousGoals(): Array<{ id: string; objective: string; risk_class: string; status: string; metadata: string }> {
    return this.db.prepare(
      "SELECT id, objective, risk_class, status, metadata FROM goals WHERE metadata LIKE '%\"autonomous\":true%' ORDER BY created_at DESC LIMIT 20"
    ).all() as Array<{ id: string; objective: string; risk_class: string; status: string; metadata: string }>;
  }
}
