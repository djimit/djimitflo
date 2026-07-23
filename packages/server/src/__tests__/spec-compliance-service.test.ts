import { describe, it, expect } from 'vitest';
import { evaluateSpecCompliance, generateComplianceReport } from '../services/spec-compliance-service';

describe('SpecComplianceService', () => {
  const fullSpec = `---
status: implemented
---
# Test Feature

## Non-Goals
- Out of scope item

## Functional requirements
FR-001: The system SHALL do something.
FR-002: WHEN condition THEN action.

## Success criteria
SC-001: Response in <2s p95.

## Hard Constraints
- Allowed: React 18+
- Forbidden: jQuery

## Codebase Anchoring
| FR | File | Action |
|----|------|--------|
| FR-001 | src/foo.ts | Create |

## Edge cases
- EC-001: IF input is empty THEN return 400.

## Verified Library Specs
| Library | Version | API |
|---------|---------|-----|
| React | 18.x | Hooks only |
`;

  const partialSpec = `---
status: draft
---
# Partial Feature

## Functional requirements
FR-001: The system SHALL do something.

## Success criteria
SC-001: Fast response.
`;

  describe('evaluateSpecCompliance', () => {
    it('scores a fully compliant spec as 7/7', () => {
      const result = evaluateSpecCompliance(fullSpec, 'full-spec', '/specs/full');
      expect(result.score).toBe(7);
      expect(result.fullCompliance).toBe(true);
    });

    it('scores a partial spec correctly', () => {
      const result = evaluateSpecCompliance(partialSpec, 'partial-spec', '/specs/partial');
      expect(result.score).toBeGreaterThanOrEqual(1);
      expect(result.score).toBeLessThan(7);
      expect(result.fullCompliance).toBe(false);
    });

    it('detects lifecycle state from frontmatter', () => {
      const result = evaluateSpecCompliance(fullSpec, 'test', '/specs/test');
      expect(result.lifecycleState).toBe('implemented');
    });

    it('identifies missing layers', () => {
      const result = evaluateSpecCompliance(partialSpec, 'test', '/specs/test');
      const missingLayers = result.layers.filter(l => !l.present);
      expect(missingLayers.length).toBeGreaterThan(0);
    });
  });

  describe('generateComplianceReport', () => {
    it('generates a report for multiple specs', () => {
      const specs = [
        { name: 'full', path: '/specs/full', content: fullSpec },
        { name: 'partial', path: '/specs/partial', content: partialSpec },
      ];
      const report = generateComplianceReport(specs);
      expect(report.totalSpecs).toBe(2);
      expect(report.fullComplianceCount).toBe(1);
      expect(report.partialCount).toBe(0);
      expect(report.noneCount).toBe(1);
    });

    it('handles empty spec list', () => {
      const report = generateComplianceReport([]);
      expect(report.totalSpecs).toBe(0);
      expect(report.generatedAt).toBeDefined();
    });
  });
});
