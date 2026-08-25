import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { AdversarialRedTeamService } from '../services/adversarial-red-team-service';

describe('AdversarialRedTeamService', () => {
  it('runs payloads through the real sanitizer and command classifier', async () => {
    const db = new Database(':memory:');
    try {
      const report = await new AdversarialRedTeamService(db).runAssessment();
      expect(report.findings.find(finding => finding.vectorId === 'injection-001')).toMatchObject({
        blocked: true,
        detectionMethod: 'ignore_instructions',
      });
      expect(report.findings.find(finding => finding.vectorId === 'ransomware-002')).toMatchObject({
        blocked: true,
        detectionMethod: 'critical-pattern',
      });
    } finally {
      db.close();
    }
  });
});
