/**
 * Spec Compliance Service — evaluates feature specs against SDD v1.1.0 Constitution
 * 7 information layers quality gates.
 *
 * Constitution v1.1.0 — Specification Quality Gates
 * L1: Language Precision (FR-### SHALL-format)
 * L2: Negative Requirements (Non-Goals)
 * L3: Measurable Criteria (SC-### with number + unit)
 * L4: Hard Constraints (Allowed/Forbidden tech)
 * L5: Codebase Anchoring (FR to file path mapping)
 * L6: Edge Cases (EC-### IF-THEN)
 * L7: Verified Library Specs (Library + version)
 */

export interface LayerCompliance {
  layer: string;
  name: string;
  present: boolean;
  evidence: string;
}

export interface SpecComplianceResult {
  specName: string;
  path: string;
  lifecycleState: string;
  layers: LayerCompliance[];
  score: number;  // 0-7
  fullCompliance: boolean;
}

export interface ComplianceReport {
  generatedAt: string;
  totalSpecs: number;
  fullComplianceCount: number;
  partialCount: number;
  noneCount: number;
  specs: SpecComplianceResult[];
}

const LAYER_DEFINITIONS = [
  { id: 'L1', name: 'Language Precision', pattern: /FR-\d{3}.*SHALL/ },
  { id: 'L2', name: 'Negative Requirements', pattern: /## Non-Goals/ },
  { id: 'L3', name: 'Measurable Criteria', pattern: /SC-\d{3}.*[<>\d]/ },
  { id: 'L4', name: 'Hard Constraints', pattern: /## Hard Constraints/ },
  { id: 'L5', name: 'Codebase Anchoring', pattern: /## Codebase Anchoring/ },
  { id: 'L6', name: 'Edge Cases', pattern: /EC-\d{3}.*IF.*THEN/ },
  { id: 'L7', name: 'Verified Library Specs', pattern: /## Verified Library Specs/ },
];

export function evaluateSpecCompliance(specContent: string, specName: string, path: string): SpecComplianceResult {
  const layers: LayerCompliance[] = LAYER_DEFINITIONS.map(def => {
    const match = def.pattern.test(specContent);
    return {
      layer: def.id,
      name: def.name,
      present: match,
      evidence: match ? `Found ${def.id} section` : `Missing ${def.id}`,
    };
  });

  // Extract lifecycle state from frontmatter
  const stateMatch = specContent.match(/status:\s*(\w+)/);
  const lifecycleState = stateMatch ? stateMatch[1] : 'unknown';

  const score = layers.filter(l => l.present).length;

  return {
    specName,
    path,
    lifecycleState,
    layers,
    score,
    fullCompliance: score === 7,
  };
}

export function generateComplianceReport(specs: Array<{ name: string; path: string; content: string }>): ComplianceReport {
  const results = specs.map(s => evaluateSpecCompliance(s.content, s.name, s.path));

  return {
    generatedAt: new Date().toISOString(),
    totalSpecs: results.length,
    fullComplianceCount: results.filter(r => r.fullCompliance).length,
    partialCount: results.filter(r => !r.fullCompliance && r.score >= 3).length,
    noneCount: results.filter(r => r.score < 3).length,
    specs: results,
  };
}
