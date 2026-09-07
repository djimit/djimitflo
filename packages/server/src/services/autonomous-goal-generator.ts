import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { WorkItemService } from './work-item-service';

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
        `SELECT id, subject_ref AS domain, claim AS description, confidence AS priority
         FROM swarm_claims
         WHERE predicate = 'gap' AND created_from = 'curiosity-service' AND status = 'proposed'
         ORDER BY confidence DESC LIMIT 3`
      ).all() as Array<{ id: string; domain: string; description: string; priority: number }>;
    } catch { return 0; }

    let created = 0;
    for (const gap of gaps) {
      const protocol = {
        research_question: `What evidence would close the ${gap.domain} knowledge gap?`,
        hypothesis: `A bounded independent investigation can materially increase evidence coverage for ${gap.domain}.`,
        null_hypothesis: `The investigation produces no operationally meaningful evidence gain for ${gap.domain}.`,
        independent_variables: ['evidence_source', 'reviewer_identity'],
        dependent_variables: ['supported_claim_count', 'contradiction_count', 'confidence_delta'],
        controls: ['current evidence baseline'],
        confounders: ['source overlap', 'shared model context', 'stale evidence'],
        randomization: 'paired seed set when stochastic agents are used',
        replication_count: 30,
        stopping_condition: '30 replications completed or a protected invariant fails',
        falsification_criteria: ['confidence interval crosses the minimum operational effect', 'independent reproduction fails'],
        analysis_method: 'paired comparison with separate assurance dimensions',
        limitations: ['projection is not evidence', 'external sources require mediated network access'],
        run_class: 'exploratory',
      };
      const result = new WorkItemService(this.db).createIfMissingBySourceRef({
        title: `Investigate knowledge gap: ${gap.domain}`,
        description: gap.description,
        source: 'curiosity_gap',
        source_ref: gap.id,
        risk_class: 'low',
        value_score: Math.round(Math.max(0, Math.min(1, gap.priority)) * 100),
        confidence: gap.priority,
        status: 'candidate',
        recommended_loop: 'research-loop',
        metadata: {
          objective: `Test and independently reproduce evidence for the ${gap.domain} knowledge gap`,
          constraints: ['no production mutation', 'network denied unless explicitly mediated', 'no autonomous promotion'],
          acceptance_criteria: ['preregistered protocol completed', 'independent evidence and limitations recorded'],
          falsification_tests: protocol.falsification_criteria,
          gap_id: gap.id,
          protocol,
        },
      });
      this.db.prepare("UPDATE swarm_claims SET status = 'review_required', updated_at = datetime('now') WHERE id = ?").run(gap.id);
      if (result.created) created++;
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
