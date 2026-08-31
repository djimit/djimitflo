/**
 * RepoEvidencePacket — FR-006: assembles a token-budgeted evidence object
 * from scan profile, graph summary, README, and AGENTS.md. Every fact carries
 * a citation (file:line, graph node, README heading, or scan finding).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { ExplainerFact, GraphSummary } from '@djimitflo/shared';

export interface RepoEvidencePacket {
  repository_full_name: string;
  token_budget: number;
  facts: ExplainerFact[];
  readme_fragments: Array<{ heading: string; excerpt: string; source_ref: string }>;
  agents_md_summary: string | null;
  graph: GraphSummary;
  stack: string[];
  health: {
    score: number | null;
    drivers: Array<{ factor: string; impact: number; description: string }>;
    findings: Array<{ severity: string; title: string; description: string }>;
  };
  license: string | null;
  package_manager: string | null;
}

const MAX_README_FRAGMENTS = 6;
const MAX_README_EXCERPT = 400;
const MAX_FACTS = 60;

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function buildRepoEvidencePacket(input: {
  repositoryFullName: string;
  localPath: string;
  scan: any;
  graph: GraphSummary;
  tokenBudget?: number;
}): RepoEvidencePacket {
  const { repositoryFullName, localPath, scan, graph } = input;
  const tokenBudget = input.tokenBudget ?? (Number(process.env.DJIMITFLO_EVIDENCE_TOKEN_BUDGET) || 12_000);
  const summary = scan?.scanSummary ?? {};
  const facts: ExplainerFact[] = [];

  function addFact(claim: string, sourceType: ExplainerFact['source_type'], sourceRef: string, confidence = 0.9, filePath?: string) {
    if (facts.length >= MAX_FACTS) return;
    facts.push({ id: `fact-${facts.length + 1}`, claim, source_ref: sourceRef, source_type: sourceType, file_path: filePath, confidence });
  }

  // Stack facts (scan finding)
  for (const stack of (scan?.stack?.detectedStacks || []).slice(0, 8)) {
    addFact(`The repository uses ${stack}.`, 'scan_finding', `scan:detected_stacks:${stack}`, 0.95);
  }

  // License fact
  const license = summary?.license?.license ?? null;
  if (license) addFact(`The repository is licensed under ${license}.`, 'scan_finding', 'scan:license', 0.95);

  // Package manager
  const pkgManager = summary?.dependencyManifest?.packageManager ?? scan?.packageManager ?? null;
  if (pkgManager && pkgManager !== 'unknown') {
    addFact(`The project uses ${pkgManager} as package manager.`, 'scan_finding', 'scan:dependency_manifest', 0.9);
  }

  // Graph community facts
  for (const c of (graph.communities || []).slice(0, 10)) {
    addFact(
      `Code community "${c.name}" (${c.language}, ${c.size} members, cohesion ${c.cohesion.toFixed(2)}) was detected by the structural graph.`,
      'graph_node',
      `graph:community:${c.name}`,
      0.85,
    );
  }

  // Hub / bridge nodes
  for (const h of (graph.hub_nodes || []).slice(0, 5)) {
    addFact(`Hub node "${h.name}" in ${h.file} has the highest connectivity (degree ${h.total_degree}).`, 'graph_node', `graph:hub:${h.name}`, 0.85, h.file);
  }
  for (const b of (graph.bridge_nodes || []).slice(0, 5)) {
    addFact(`Bridge node "${b.name}" in ${b.file} connects multiple communities (betweenness ${b.betweenness}).`, 'graph_node', `graph:bridge:${b.name}`, 0.85, b.file);
  }

  // Critical flows
  for (const f of (graph.top_flows || []).slice(0, 5)) {
    addFact(`Execution flow "${f.name}" spans ${f.node_count} nodes (criticality ${f.criticality}).`, 'graph_node', `graph:flow:${f.name}`, 0.85);
  }

  // Health findings (severity-ranked)
  const healthFindings = [...(scan?.healthFindings || [])].sort(
    (a: any, b: any) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );
  for (const f of healthFindings.slice(0, 15)) {
    addFact(`Health finding [${f.severity}] ${f.title}: ${f.description}`, 'scan_finding', `scan:health:${f.title}`, 0.9);
  }

  // Secret-scan redaction surface (never leak raw findings)
  const secretCount = (summary?.secretScan?.findings ?? []).length;
  if (secretCount > 0) {
    addFact(`Secret scan flagged ${secretCount} finding(s); details are redacted.`, 'scan_finding', 'scan:secret_scan', 1.0);
  }

  // README fragments with heading citations
  const readmeFragments: RepoEvidencePacket['readme_fragments'] = [];
  const readmePath = findReadme(localPath);
  if (readmePath) {
    try {
      const content = readFileSync(readmePath, 'utf8');
      const lines = content.split('\n');
      let currentHeading = 'Introduction';
      let buffer: string[] = [];
      function flush() {
        const excerpt = buffer.join(' ').trim().slice(0, MAX_README_EXCERPT);
        if (excerpt) {
          readmeFragments.push({ heading: currentHeading, excerpt, source_ref: `readme:${currentHeading}` });
        }
        buffer = [];
      }
      for (const line of lines) {
        if (/^#{1,3}\s+/.test(line)) {
          flush();
          currentHeading = line.replace(/^#+\s+/, '').trim();
        } else if (line.trim()) {
          buffer.push(line.trim());
        }
      }
      flush();
    } catch {
      // unreadable README — proceed without fragments
    }
  }
  for (const frag of readmeFragments.slice(0, MAX_README_FRAGMENTS)) {
    addFact(frag.excerpt, 'readme_heading', frag.source_ref, 0.8);
  }

  // AGENTS.md summary (file:line citation at heading)
  let agentsMdSummary: string | null = null;
  const agentsPath = join(localPath, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    try {
      const content = readFileSync(agentsPath, 'utf8');
      const lineCount = content.split('\n').length;
      agentsMdSummary = content.slice(0, 2000);
      addFact(`AGENTS.md present with ${lineCount} lines of agent instructions.`, 'file_line', 'AGENTS.md:1', 0.95, 'AGENTS.md');
    } catch {
      agentsMdSummary = null;
    }
  }

  // Entry point fact
  const entryPoint = summary?.entryPoint ?? scan?.entryPoint;
  if (entryPoint) {
    addFact(`Entry point: ${entryPoint}.`, 'file_line', String(entryPoint), 0.9, String(entryPoint));
  }

  return {
    repository_full_name: repositoryFullName,
    token_budget: tokenBudget,
    facts: facts.slice(0, MAX_FACTS),
    readme_fragments: readmeFragments.slice(0, MAX_README_FRAGMENTS),
    agents_md_summary: agentsMdSummary,
    graph,
    stack: scan?.stack?.detectedStacks || [],
    health: {
      score: scan?.health?.score ?? null,
      drivers: scan?.health?.drivers ?? [],
      findings: healthFindings.slice(0, 15),
    },
    license,
    package_manager: pkgManager,
  };
}

function findReadme(localPath: string): string | null {
  for (const name of ['README.md', 'readme.md', 'Readme.md', 'README.txt']) {
    const p = join(localPath, name);
    if (existsSync(p)) return p;
  }
  return null;
}