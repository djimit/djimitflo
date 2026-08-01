import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApexReportService } from '../services/apex-report-service';

describe('ApexReportService', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apex-reports-'));
    writeFileSync(join(dir, 'APEX_R1_EVOLUTION.md'),
      '# OpenMythos Evolution Step\n\n- models: `llama3.1:8b`\n');
    writeFileSync(join(dir, 'APEX_R16_CANONICAL_PROMOTION.md'),
      '# OpenMythos Apex R16 Canonical Promotion\n\n## Decision\n\n`promoted`\n');
    writeFileSync(join(dir, 'APEX_R44_RESPONSE_LEVEL_SELECTION.md'),
      '# OpenMythos R44 Response-Level Selection\n\nDecision: `negative_result` — the judge cannot rank.\n');
    writeFileSync(join(dir, 'APEX_R44_SECOND_STUDY.md'),
      '# R44 Second Study\n\nDecision: `diagnostic_complete`.\n');
    writeFileSync(join(dir, 'notes.md'), '# not an apex report\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists only APEX reports, newest round first, with parsed titles and decisions', () => {
    const reports = new ApexReportService(dir).list();

    expect(reports.map((r) => r.round)).toEqual([44, 44, 16, 1]);
    expect(reports.find((r) => r.file.includes('RESPONSE_LEVEL'))).toMatchObject({
      title: 'OpenMythos R44 Response-Level Selection',
      decision: 'negative_result',
    });
    // decision from a "## Decision" section
    expect(reports.find((r) => r.round === 16)?.decision).toBe('promoted');
    // no Decision anywhere → null, title still parsed
    expect(reports.find((r) => r.round === 1)).toMatchObject({
      title: 'OpenMythos Evolution Step',
      decision: null,
    });
    expect(reports.some((r) => r.file === 'notes.md')).toBe(false);
  });

  it('get(round) returns all reports for the round with bodies', () => {
    const reports = new ApexReportService(dir).get(44);
    expect(reports).toHaveLength(2);
    expect(reports[0].body).toContain('Decision:');
  });

  it('is empty when the path is unset or missing', () => {
    expect(new ApexReportService('').list()).toEqual([]);
    expect(new ApexReportService('/nonexistent/path').list()).toEqual([]);
    expect(new ApexReportService(dir).get(99)).toEqual([]);
  });
});
