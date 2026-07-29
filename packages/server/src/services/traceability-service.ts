/**
 * Spec Traceability Matrix — maps Functional Requirements to tests and files.
 * Constitution v1.1.0 — L5 Codebase Anchoring + L1 Language Precision.
 */

export interface TraceabilityEntry {
  frId: string;
  frDescription: string;
  specName: string;
  files: string[];
  hasTest: boolean;
  testFiles: string[];
  layerCoverage: {
    languagePrecision: boolean;
    negativeRequirements: boolean;
    measurableCriteria: boolean;
    hardConstraints: boolean;
    codebaseAnchoring: boolean;
    edgeCases: boolean;
    verifiedLibrarySpecs: boolean;
  };
}

export interface TraceabilityMatrix {
  generatedAt: string;
  totalFRs: number;
  coveredFRs: number;
  coveragePercent: number;
  entries: TraceabilityEntry[];
}

const FR_PATTERN = /(FR-\d{3})(?:\*\*)?\s*[：:]\s*(.+?)(?=\n|$)/g;
const FILE_PATTERN = /`([^`]+\.(?:ts|tsx|js|jsx|py|rs|go|sql))`/g;
const TEST_PATTERN = /(?:^|\/)(?:__tests__\/.*|[^/]*\.(?:test|spec))\.(?:ts|tsx|js)$/i;

export function buildTraceabilityMatrix(
  specs: Array<{ name: string; content: string }>
): TraceabilityMatrix {
  const entries: TraceabilityEntry[] = [];

  for (const spec of specs) {
    // Extract FRs
    const frs: Array<{ id: string; description: string }> = [];
    let match;
    while ((match = FR_PATTERN.exec(spec.content)) !== null) {
      frs.push({ id: match[1], description: match[2].trim() });
    }

    // Extract exact FR -> file mappings from codebase anchoring table rows.
    const filesByFr = new Map<string, string[]>();
    const anchoringMatch = spec.content.match(/## Codebase Anchoring[\s\S]*?(?=\n## |$)/);
    if (anchoringMatch) {
      for (const line of anchoringMatch[0].split('\n')) {
        const frIds = [...line.matchAll(/FR-\d{3}/g)].map((match) => match[0]);
        const paths = [...line.matchAll(FILE_PATTERN)].map((match) => match[1]);
        for (const frId of frIds) {
          filesByFr.set(frId, [...new Set([...(filesByFr.get(frId) || []), ...paths])]);
        }
      }
    }

    // Check layer coverage
    const layerCoverage = {
      languagePrecision: /FR-\d{3}.*SHALL/.test(spec.content),
      negativeRequirements: /## Non-Goals/.test(spec.content),
      measurableCriteria: /SC-\d{3}/.test(spec.content),
      hardConstraints: /## Hard Constraints/.test(spec.content),
      codebaseAnchoring: /## Codebase Anchoring/.test(spec.content),
      edgeCases: /EC-\d{3}/.test(spec.content),
      verifiedLibrarySpecs: /## Verified Library Specs/.test(spec.content),
    };

    // Build entry per FR
    for (const fr of frs) {
      const files = filesByFr.get(fr.id) || [];
      const testFiles = files.filter((file) => TEST_PATTERN.test(file));
      entries.push({
        frId: fr.id,
        frDescription: fr.description,
        specName: spec.name,
        files,
        hasTest: testFiles.length > 0,
        testFiles,
        layerCoverage,
      });
    }
  }

  const totalFRs = entries.length;
  const coveredFRs = entries.filter(e => e.hasTest && e.layerCoverage.codebaseAnchoring).length;
  const coveragePercent = totalFRs > 0 ? Math.round((coveredFRs / totalFRs) * 100) : 0;

  return {
    generatedAt: new Date().toISOString(),
    totalFRs,
    coveredFRs,
    coveragePercent,
    entries,
  };
}
