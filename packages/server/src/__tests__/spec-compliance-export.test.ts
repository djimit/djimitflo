import { describe, it, expect } from 'vitest';
import { exportReportAsJson, exportReportAsCsv, evaluateSpecCompliance, generateComplianceReport } from '../services/spec-compliance-service';

describe('Spec Coverage Export', () => {
  const sampleReport = generateComplianceReport([
    {
      name: 'test-spec',
      path: '/specs/test-spec/spec.md',
      content: `---
status: implemented
---
# Test Spec

## Non-Goals
- Out of scope

## Functional requirements
FR-001: The system SHALL do something.

## Success criteria
SC-001: Response in <2s.

## Hard Constraints
- Allowed: React

## Codebase Anchoring
| FR | File | Action |
|----|------|--------|
| FR-001 | src/foo.ts | Create |

## Edge cases
- EC-001: IF empty THEN return 400.

## Verified Library Specs
| Library | Version | API |
|---------|---------|-----|
| React | 18.x | Hooks |
`,
    },
    {
      name: 'minimal-spec',
      path: '/specs/minimal/spec.md',
      content: '# Minimal Spec\n\nFR-001: The system SHALL work.',
    },
  ]);

  describe('exportReportAsJson', () => {
    it('returns valid JSON', () => {
      const json = exportReportAsJson(sampleReport);
      const parsed = JSON.parse(json);
      expect(parsed.totalSpecs).toBe(2);
      expect(parsed.specs).toHaveLength(2);
    });

    it('includes all report fields', () => {
      const json = exportReportAsJson(sampleReport);
      const parsed = JSON.parse(json);
      expect(parsed.generatedAt).toBeDefined();
      expect(parsed.fullComplianceCount).toBeDefined();
      expect(parsed.partialCount).toBeDefined();
      expect(parsed.noneCount).toBeDefined();
    });

    it('pretty-prints with 2-space indent', () => {
      const json = exportReportAsJson(sampleReport);
      expect(json).toContain('\n  ');
    });
  });

  describe('exportReportAsCsv', () => {
    it('produces valid CSV with headers', () => {
      const csv = exportReportAsCsv(sampleReport);
      const lines = csv.split('\n');
      expect(lines[0]).toBe('spec_name,lifecycle_state,score,L1,L2,L3,L4,L5,L6,L7');
    });

    it('includes all specs', () => {
      const csv = exportReportAsCsv(sampleReport);
      const lines = csv.split('\n');
      // header + 2 specs = 3 lines
      expect(lines).toHaveLength(3);
    });

    it('marks layers as pass or fail', () => {
      const csv = exportReportAsCsv(sampleReport);
      const lines = csv.split('\n');
      const dataRow = lines[1]; // first spec
      expect(dataRow).toContain('pass');
    });

    it('escapes commas in values', () => {
      const reportWithComma = generateComplianceReport([{
        name: 'spec, with comma',
        path: '/specs/test/spec.md',
        content: 'FR-001: SHALL work.',
      }]);
      const csv = exportReportAsCsv(reportWithComma);
      expect(csv).toContain('"spec, with comma"');
    });
  });

  describe('round-trip consistency', () => {
    it('JSON and CSV contain same data', () => {
      const json = exportReportAsJson(sampleReport);
      const parsed = JSON.parse(json);
      const csv = exportReportAsCsv(sampleReport);
      const csvLines = csv.split('\n');

      expect(parsed.totalSpecs).toBe(2);
      expect(csvLines.length).toBe(3); // header + 2 data rows
    });
  });
});
