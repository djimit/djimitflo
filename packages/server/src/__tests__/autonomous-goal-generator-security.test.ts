import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AutonomousGoalGenerator } from '../services/autonomous-goal-generator';
import { SelfImprovementService } from '../services/self-improvement-service';

/**
 * Regression coverage for the fix to the gap found 2026-09-21:
 * generateFromSecurityFindings() used to create a goal directly at
 * risk_class:'high', fully autonomous, with no specialist panel review at
 * all — the one category needing the most scrutiny skipped it entirely.
 * It now routes through SelfImprovementService's reviewed pipeline instead.
 */
describe('AutonomousGoalGenerator.generateFromSecurityFindings (reviewed routing)', () => {
  let db: Database.Database;
  let generator: AutonomousGoalGenerator;
  let improvements: SelfImprovementService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    generator = new AutonomousGoalGenerator(db);
    improvements = new SelfImprovementService(db);
  });

  afterEach(() => {
    db?.close();
  });

  function seedScan(findings: Array<{ severity: string; category?: string; message: string; location?: string }>) {
    db.prepare(`
      INSERT INTO security_scans (id, target, scan_type, findings_json, summary_json, created_at)
      VALUES (?, 'repo', 'code', ?, '{}', datetime('now'))
    `).run('scan-1', JSON.stringify(findings));
  }

  it('creates a reviewed self-improvement proposal instead of an unreviewed goal for high/critical findings', () => {
    seedScan([{ severity: 'high', category: 'auth', message: 'token not validated', location: 'src/auth.ts' }]);
    const created = generator.generateFromSecurityFindings();
    expect(created).toBe(1);

    const proposals = improvements.listImprovements('proposed');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].type).toBe('security');
    expect(proposals[0].description).toContain('token not validated');

    // No goal exists yet — one is only created once a specialist panel authorizes this proposal,
    // via the already-wired generateFromSelfImprovements() path.
    expect((db.prepare("SELECT COUNT(*) as n FROM goals WHERE json_extract(metadata,'$.source')='security-scan'").get() as { n: number }).n).toBe(0);
  });

  it('ignores low/medium findings, same as before', () => {
    seedScan([{ severity: 'low', message: 'minor style issue' }]);
    expect(generator.generateFromSecurityFindings()).toBe(0);
    expect(improvements.listImprovements('proposed')).toHaveLength(0);
  });

  it('does not create a duplicate proposal for the same unresolved finding on a repeat scan (content-fingerprint dedup)', () => {
    seedScan([{ severity: 'high', message: 'token not validated', location: 'src/auth.ts' }]);
    generator.generateFromSecurityFindings();
    // A second scan reports the identical finding (new scan id, same content) — mirrors an hourly re-scan.
    db.prepare(`
      INSERT INTO security_scans (id, target, scan_type, findings_json, summary_json, created_at)
      VALUES ('scan-2', 'repo', 'code', ?, '{}', datetime('now'))
    `).run(JSON.stringify([{ severity: 'high', message: 'token not validated', location: 'src/auth.ts' }]));
    generator.generateFromSecurityFindings();
    expect(improvements.listImprovements('proposed')).toHaveLength(1);
  });
});
