import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { AutonomousGoalGenerator } from '../services/autonomous-goal-generator';
import { SelfImprovementService } from '../services/self-improvement-service';
import { SecurityScanningAgent } from '../services/security-scanning-agent';
import { EpistemicUncertaintyService } from '../services/epistemic-uncertainty-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let generator: AutonomousGoalGenerator;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);

  new SelfImprovementService(db);
  new SecurityScanningAgent(db);
  new EpistemicUncertaintyService(db);

  generator = new AutonomousGoalGenerator(db);
});

afterEach(() => {
  db?.close();
});

describe('AutonomousGoalGenerator', () => {
  it('generates goals from self-improvements', () => {
    db.prepare(`
      INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority)
      VALUES ('imp-1', 'bug_fix', 'Fix auth', 'Fix auth bug', 'security', 'reflection', 'proposed', 0.95)
    `).run();

    const before = db.prepare("SELECT COUNT(*) as c FROM self_improvements WHERE status = 'proposed'").get() as { c: number };
    expect(before.c).toBe(1);

    const created = generator.generateFromSelfImprovements();
    expect(created).toBe(1);

    const goals = db.prepare("SELECT * FROM goals WHERE metadata LIKE '%autonomous%'").all();
    expect(goals.length).toBe(1);
  });

  it('marks improvements as approved after goal generation', () => {
    db.prepare(`
      INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority)
      VALUES ('imp-2', 'bug_fix', 'Fix X', 'Desc', 'reason', 'reflection', 'proposed', 0.8)
    `).run();

    generator.generateFromSelfImprovements();

    const imp = db.prepare("SELECT status FROM self_improvements WHERE id = 'imp-2'").get() as { status: string };
    expect(imp.status).toBe('approved');
  });

  it('generates goals from security findings', () => {
    db.prepare(`
      INSERT INTO security_scans (id, target, scan_type, findings_json, summary_json, duration_ms)
      VALUES ('scan-1', 'src', 'code', '[{"severity":"high","message":"execSync without timeout","location":"repo.ts"}]', '{}', 100)
    `).run();

    const created = generator.generateFromSecurityFindings();
    expect(created).toBe(1);
  });

  it('does not generate from low-severity security findings', () => {
    db.prepare(`
      INSERT INTO security_scans (id, target, scan_type, findings_json, summary_json, duration_ms)
      VALUES ('scan-2', 'src', 'code', '[{"severity":"low","message":"info","location":"repo.ts"}]', '{}', 100)
    `).run();

    const created = generator.generateFromSecurityFindings();
    expect(created).toBe(0);
  });

  it('generates goals from curiosity gaps', () => {
    db.prepare(`
      INSERT INTO knowledge_gaps (id, domain, description, priority, status)
      VALUES ('gap-1', 'kubernetes', 'Need to learn K8s', 0.9, 'open')
    `).run();

    const created = generator.generateFromCuriosityGaps();
    expect(created).toBe(1);
  });

  it('generateAll returns totals', () => {
    db.prepare(`
      INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority)
      VALUES ('imp-3', 'bug_fix', 'Fix Y', 'Desc', 'reason', 'reflection', 'proposed', 0.8)
    `).run();

    const result = generator.generateAll();
    expect(result.improvements).toBe(1);
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it('gets autonomous goals', () => {
    db.prepare(`
      INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority)
      VALUES ('imp-4', 'bug_fix', 'Fix Z', 'Desc', 'reason', 'reflection', 'proposed', 0.8)
    `).run();

    generator.generateAll();
    const goals = generator.getAutonomousGoals();
    expect(goals.length).toBe(1);
    expect(goals[0].metadata).toContain('autonomous');
  });
});
