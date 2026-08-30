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
  source: 'speckit' | 'openspec';
  lifecycleState: string;
  layers: LayerCompliance[];
  score: number;  // 0-7
  fullCompliance: boolean;
  assuranceStatus: 'pass' | 'fail' | 'blocked';
  nextSafeAction: string;
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

export function evaluateSpecCompliance(
  specContent: string,
  specName: string,
  path: string,
  source: SpecComplianceResult['source'] = 'speckit'
): SpecComplianceResult {
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
  const missing = layers.filter(layer => !layer.present).map(layer => layer.layer);
  const blocked = /^(blocked|paused)$/i.test(lifecycleState);

  return {
    specName,
    path,
    source,
    lifecycleState,
    layers,
    score,
    fullCompliance: score === 7,
    assuranceStatus: score === 7 ? 'pass' : blocked ? 'blocked' : 'fail',
    nextSafeAction: score === 7 ? 'No action required' : `Add missing layers: ${missing.join(', ')}`,
  };
}

export function generateComplianceReport(specs: Array<{ name: string; path: string; content: string; source?: SpecComplianceResult['source'] }>): ComplianceReport {
  const results = specs.map(s => evaluateSpecCompliance(s.content, s.name, s.path, s.source));

  return {
    generatedAt: new Date().toISOString(),
    totalSpecs: results.length,
    fullComplianceCount: results.filter(r => r.fullCompliance).length,
    partialCount: results.filter(r => !r.fullCompliance && r.score >= 3).length,
    noneCount: results.filter(r => r.score < 3).length,
    specs: results,
  };
}


export function exportReportAsJson(report: ComplianceReport): string {
  return JSON.stringify(report, null, 2);
}

export function exportReportAsCsv(report: ComplianceReport): string {
  const headers = ['spec_name', 'source', 'path', 'lifecycle_state', 'assurance_status', 'score', 'next_safe_action', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];
  const rows = report.specs.map(spec => [
    spec.specName,
    spec.source,
    spec.path,
    spec.lifecycleState,
    spec.assuranceStatus,
    String(spec.score),
    spec.nextSafeAction,
    ...spec.layers.map(l => l.present ? 'pass' : 'fail'),
  ]);

  // Escape CSV values (wrap in quotes if contains comma, quote, or newline)
  const escape = (val: string) => {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return '"' + val.replace(/"/g, '""') + '"';
    }
    return val;
  };

  const csvLines = [
    headers.join(','),
    ...rows.map(row => row.map(escape).join(',')),
  ];

  return csvLines.join('\n');
}

export function scanSpecsDirectory(repoRoot = require('path').resolve(__dirname, '../../../..')): Array<{ name: string; path: string; content: string; source: SpecComplianceResult['source'] }> {
  const fs = require('fs');
  const path = require('path');
  const specsDir = path.join(repoRoot, 'specs');
  const archiveDir = path.join(specsDir, 'archive');
  const specs: Array<{ name: string; path: string; content: string; source: SpecComplianceResult['source'] }> = [];
  const seen = new Set<string>();

  for (const dir of [specsDir, archiveDir]) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const specFile = path.join(dir, entry.name, 'spec.md');
        if (!seen.has(entry.name) && fs.existsSync(specFile)) {
          const content = fs.readFileSync(specFile, 'utf-8');
          specs.push({ name: entry.name, path: specFile, content, source: 'speckit' });
          seen.add(entry.name);
        }
      }
    }
  }

  const openSpecDir = path.join(repoRoot, 'openspec', 'changes');
  if (fs.existsSync(openSpecDir)) {
    for (const entry of fs.readdirSync(openSpecDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const changeDir = path.join(openSpecDir, entry.name);
      const files = ['proposal.md', 'design.md', 'tasks.md', 'spec.md']
        .map(file => path.join(changeDir, file))
        .filter(file => fs.existsSync(file));
      if (files.length === 0) continue;
      const content = files.map(file => fs.readFileSync(file, 'utf-8')).join('\n\n');
      const tasks = files.find(file => file.endsWith('tasks.md'));
      const taskContent = tasks ? fs.readFileSync(tasks, 'utf-8') : '';
      const taskCount = (taskContent.match(/^- \[[ xX]\]/gm) || []).length;
      const doneCount = (taskContent.match(/^- \[[xX]\]/gm) || []).length;
      const lifecycle = taskCount > 0 && doneCount === taskCount ? 'implemented' : doneCount > 0 ? 'in_progress' : 'proposed';
      specs.push({
        name: `openspec/${entry.name}`,
        path: changeDir,
        content: `---\nstatus: ${lifecycle}\n---\n${content}`,
        source: 'openspec',
      });
    }
  }
  return specs;
}
