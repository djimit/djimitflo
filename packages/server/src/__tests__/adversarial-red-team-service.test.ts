import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { AdversarialRedTeamService } from '../services/adversarial-red-team-service';

describe('AdversarialRedTeamService', () => {
  it('runs payloads through the real sanitizer and command classifier', async () => {
    const db = new Database(':memory:');
    try {
      const report = await new AdversarialRedTeamService(db).runAssessment();
      // injection-001 is blocked by the command-risk classifier (unknown
      // instruction-override payload defaults to require_approval → blocked).
      expect(report.findings.find(finding => finding.vectorId === 'injection-001')).toMatchObject({
        blocked: true,
        detectionMethod: 'command_risk_classifier',
      });
      // ransomware-002 is blocked via the command-risk classifier's CRITICAL
      // pattern match (DROP DATABASE → deny), reported under the defense name.
      expect(report.findings.find(finding => finding.vectorId === 'ransomware-002')).toMatchObject({
        blocked: true,
        detectionMethod: 'command_risk_classifier',
      });
    } finally {
      db.close();
    }
  });
});
