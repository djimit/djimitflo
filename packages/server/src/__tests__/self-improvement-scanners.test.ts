import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { AutonomousCoderService } from '../services/autonomous-coder-service';
import { AutonomousTestGeneratorService } from '../services/autonomous-test-generator-service';

describe('self-improvement scanners', () => {
  it('keeps repeated scans stable and ignores test fixtures', () => {
    const db = new Database(':memory:');
    const coder = new AutonomousCoderService(db);

    coder.scan();
    const first = coder.getStats().totalOpportunities;
    coder.scan();

    expect(coder.getStats().totalOpportunities).toBe(first);
    expect(coder.getOpportunities().every((item) => !item.file.startsWith('__tests__/'))).toBe(true);
    expect(coder.getOpportunities().every((item) => item.type !== 'todo' || /^(TODO|FIXME|HACK):/.test(item.description))).toBe(true);
    db.close();
  });

  it('reports only testable services and class-level public methods', () => {
    const db = new Database(':memory:');
    const generator = new AutonomousTestGeneratorService(db);
    const candidates = generator.generateAll();
    const stats = generator.getStats();

    expect(stats.testedServices + candidates.length).toBe(stats.totalServices);
    expect(stats).toMatchObject({
      coverageMetric: 'direct_test_file_match',
      integrationCoverage: null,
    });
    expect(candidates.flatMap((item) => item.methods)).not.toContain('VALUES');
    expect(candidates.flatMap((item) => item.methods)).not.toContain('mkdirSync');
    db.close();
  });
});
