import { describe, it, expect } from 'vitest';
import { buildTraceabilityMatrix } from '../services/traceability-service';
import { scanSpecsDirectory } from '../services/spec-compliance-service';

describe('Spec Traceability Matrix', () => {
  const sampleSpecs = [
    {
      name: 'test-spec',
      content: [
        '---',
        'status: implemented',
        '---',
        '# Test Spec',
        '',
        '## Non-Goals',
        '- Out of scope',
        '',
        '## Functional requirements',
        'FR-001: The system SHALL authenticate users.',
        'FR-002: The system SHALL encrypt data.',
        '',
        '## Success criteria',
        'SC-001: Auth completes in <2s.',
        '',
        '## Hard Constraints',
        '- Allowed: React 18+',
        '',
        '## Codebase Anchoring',
        '| FR | File | Action |',
        '|----|------|--------|',
        '| FR-001 | `src/auth/AuthService.ts` | Create |',
        '| FR-001 | `src/auth/AuthService.test.ts` | Test |',
        '| FR-002 | `src/crypto.ts` | Create |',
        '',
        '## Edge cases',
        '- EC-001: IF empty THEN return 400.',
        '',
        '## Verified Library Specs',
        '| Library | Version |',
        '|---------|---------|',
        '| React | 18.x |',
      ].join('\n'),
    },
    {
      name: 'minimal-spec',
      content: '# Minimal Spec\n\nFR-003: The system SHALL work.',
    },
  ];

  describe('buildTraceabilityMatrix', () => {
    it('builds matrix from specs', () => {
      const matrix = buildTraceabilityMatrix(sampleSpecs);
      expect(matrix.totalFRs).toBe(3);
      expect(matrix.entries).toHaveLength(3);
    });

    it('extracts FRs correctly', () => {
      const matrix = buildTraceabilityMatrix(sampleSpecs);
      const frIds = matrix.entries.map(e => e.frId);
      expect(frIds).toContain('FR-001');
      expect(frIds).toContain('FR-002');
      expect(frIds).toContain('FR-003');
    });

    it('extracts files from codebase anchoring', () => {
      const matrix = buildTraceabilityMatrix(sampleSpecs);
      const fr001 = matrix.entries.find(e => e.frId === 'FR-001');
      expect(fr001?.files.length).toBeGreaterThan(0);
    });

    it('checks layer coverage', () => {
      const matrix = buildTraceabilityMatrix(sampleSpecs);
      const fr001 = matrix.entries.find(e => e.frId === 'FR-001');
      expect(fr001?.layerCoverage.languagePrecision).toBe(true);
      expect(fr001?.layerCoverage.codebaseAnchoring).toBe(true);
    });

    it('marks FRs without tests', () => {
      const matrix = buildTraceabilityMatrix(sampleSpecs);
      const fr003 = matrix.entries.find(e => e.frId === 'FR-003');
      expect(fr003?.hasTest).toBe(false);
    });

    it('does not leak files between requirements', () => {
      const matrix = buildTraceabilityMatrix(sampleSpecs);
      const fr002 = matrix.entries.find(e => e.frId === 'FR-002');
      expect(fr002?.files).toEqual(['src/crypto.ts']);
      expect(fr002?.hasTest).toBe(false);
    });

    it('calculates coverage percent', () => {
      const matrix = buildTraceabilityMatrix(sampleSpecs);
      expect(matrix.coveragePercent).toBeGreaterThanOrEqual(0);
      expect(matrix.coveragePercent).toBeLessThanOrEqual(100);
    });

    it('handles empty specs', () => {
      const matrix = buildTraceabilityMatrix([]);
      expect(matrix.totalFRs).toBe(0);
    });

    it('recognizes the repository markdown requirement format', () => {
      const matrix = buildTraceabilityMatrix([{
        name: 'markdown-spec',
        content: '- **FR-001**: The system SHALL work.',
      }]);
      expect(matrix.totalFRs).toBe(1);
    });

    it('finds repository specs from the server workspace', () => {
      expect(scanSpecsDirectory().length).toBeGreaterThan(0);
    });
  });
});
