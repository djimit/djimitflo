import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildRepoEvidencePacket } from '../services/repo-evidence-packet';
import type { GraphSummary } from '@djimitflo/shared';

const baseGraph = (overrides: Partial<GraphSummary> = {}): GraphSummary => ({
  total_nodes: 10, total_edges: 12, total_files: 5, risk_score: null,
  communities: [], top_flows: [], hub_nodes: [], bridge_nodes: [], ...overrides,
});
const baseScan = (o: Record<string, any> = {}): Record<string, any> => ({
  scanSummary: {}, stack: { detectedStacks: [] }, healthFindings: [], ...o,
});
let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'rep-')); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });
const build = (overrides: Partial<Parameters<typeof buildRepoEvidencePacket>[0]> = {}) =>
  buildRepoEvidencePacket({
    repositoryFullName: 'djimit/repo', localPath: tmpDir, scan: baseScan(),
    graph: baseGraph(), ...overrides,
  });

describe('buildRepoEvidencePacket', () => {
  it('returns identity, default token budget, and empty facts for a bare repository', () => {
    const p = build();
    expect(p.repository_full_name).toBe('djimit/repo');
    expect(p.token_budget).toBe(12_000);
    expect(p.facts).toEqual([]);
    expect(p.readme_fragments).toEqual([]);
    expect(p.agents_md_summary).toBeNull();
    expect(p.license).toBeNull();
    expect(p.package_manager).toBeNull();
    expect(p.stack).toEqual([]);
    expect(p.health).toEqual({ score: null, drivers: [], findings: [] });
    expect(p.graph).toEqual(baseGraph());
  });

  it('honours explicit tokenBudget and falls back to env var', () => {
    expect(build({ tokenBudget: 2048 }).token_budget).toBe(2048);
    process.env.DJIMITFLO_EVIDENCE_TOKEN_BUDGET = '7777';
    try { expect(build().token_budget).toBe(7777); } finally { delete process.env.DJIMITFLO_EVIDENCE_TOKEN_BUDGET; }
  });

  it('adds stack facts with scan_finding source_type', () => {
    const p = build({ scan: baseScan({ stack: { detectedStacks: ['TypeScript', 'Express'] } }) });
    expect(p.stack).toEqual(['TypeScript', 'Express']);
    const stackFacts = p.facts.filter((f) => f.claim.includes('uses '));
    expect(stackFacts.map((f) => f.claim)).toEqual([
      'The repository uses TypeScript.', 'The repository uses Express.',
    ]);
    expect(stackFacts[0].source_ref).toBe('scan:detected_stacks:TypeScript');
    expect(stackFacts[0].confidence).toBe(0.95);
  });

  it('adds license and package manager facts; suppresses "unknown" pkg manager', () => {
    const p = build({ scan: baseScan({
      scanSummary: { license: { license: 'MIT' }, dependencyManifest: { packageManager: 'npm' } },
    }) });
    expect(p.license).toBe('MIT');
    expect(p.package_manager).toBe('npm');
    expect(p.facts.some((f) => f.claim === 'The repository is licensed under MIT.')).toBe(true);
    expect(p.facts.some((f) => f.claim === 'The project uses npm as package manager.')).toBe(true);
    const u = build({ scan: baseScan({ scanSummary: { dependencyManifest: { packageManager: 'unknown' } } }) });
    expect(u.package_manager).toBe('unknown');
    expect(u.facts.some((f) => f.claim.includes('package manager'))).toBe(false);
    const fb = build({ scan: baseScan({ packageManager: 'yarn' }) });
    expect(fb.package_manager).toBe('yarn');
  });

  it('adds community, hub, bridge, and flow facts from the graph', () => {
    const graph = baseGraph({
      communities: [{ name: 'core', size: 4, cohesion: 0.5, language: 'TypeScript' }],
      hub_nodes: [{ name: 'index', file: 'src/index.ts', total_degree: 12 }],
      bridge_nodes: [{ name: 'bridge', file: 'src/bridge.ts', betweenness: 0.42 }],
      top_flows: [{ name: 'main', criticality: 0.9, depth: 3, node_count: 7 }],
    });
    const claims = build({ graph }).facts.map((f) => f.claim);
    expect(claims.some((c) => c.includes('Code community "core"'))).toBe(true);
    expect(claims.some((c) => c.includes('Hub node "index"'))).toBe(true);
    expect(claims.some((c) => c.includes('Bridge node "bridge"'))).toBe(true);
    expect(claims.some((c) => c.includes('Execution flow "main"'))).toBe(true);
  });

  it('sorts health findings by severity (critical first) and caps at 15', () => {
    const findings = Array.from({ length: 20 }, (_, i) => ({
      severity: i === 5 ? 'critical' : 'low', title: `f-${i}`, description: 'desc',
    }));
    const p = build({ scan: baseScan({ healthFindings: findings }) });
    expect(p.health.findings.length).toBe(15);
    expect(p.health.findings[0].title).toBe('f-5');
  });

  it('propagates health score and drivers from scan', () => {
    const drivers = [{ factor: 'tests', impact: 0.8, description: 'good coverage' }];
    const p = build({ scan: baseScan({ health: { score: 88, drivers } }) });
    expect(p.health.score).toBe(88);
    expect(p.health.drivers).toEqual(drivers);
  });

  it('redacts secret scan findings to a single count fact', () => {
    const p = build({ scan: baseScan({ scanSummary: { secretScan: { findings: [{}, {}, {}] } } }) });
    const sf = p.facts.filter((f) => f.source_ref === 'scan:secret_scan');
    expect(sf).toHaveLength(1);
    expect(sf[0].claim).toContain('3 finding(s)');
    expect(sf[0].confidence).toBe(1.0);
  });

  it('parses README.md into heading fragments with citations', () => {
    writeFileSync(join(tmpDir, 'README.md'), '# Project\n\nIntro body.\n\n## Usage\n\nHow to use.\n');
    const p = build();
    expect(p.readme_fragments.map((f) => f.heading)).toContain('Project');
    expect(p.readme_fragments.map((f) => f.heading)).toContain('Usage');
    const proj = p.readme_fragments.find((f) => f.heading === 'Project');
    expect(proj?.source_ref).toBe('readme:Project');
    expect(proj?.excerpt).toContain('Intro body.');
    expect(p.facts.some((f) => f.source_type === 'readme_heading')).toBe(true);
  });

  it('detects alternative README spellings (readme.md)', () => {
    writeFileSync(join(tmpDir, 'readme.md'), '# Title\n\nBody.\n');
    expect(build().readme_fragments[0].heading).toBe('Title');
  });

  it('returns empty readme fragments when no README exists', () => {
    expect(build().readme_fragments).toEqual([]);
  });

  it('truncates README excerpt to 400 characters', () => {
    writeFileSync(join(tmpDir, 'README.md'), `# Title\n\n${'A'.repeat(600)}\n`);
    expect(build().readme_fragments[0].excerpt.length).toBeLessThanOrEqual(400);
  });

  it('summarizes AGENTS.md when present and adds a file_line fact', () => {
    writeFileSync(join(tmpDir, 'AGENTS.md'), '# Agents\n\nSome instructions.\n');
    const p = build();
    expect(p.agents_md_summary).toContain('# Agents');
    const af = p.facts.find((f) => f.source_ref === 'AGENTS.md:1');
    expect(af?.source_type).toBe('file_line');
    expect(af?.file_path).toBe('AGENTS.md');
    expect(af?.claim).toContain('AGENTS.md present with');
  });

  it('adds an entry point fact when scanSummary.entryPoint is set', () => {
    const p = build({ scan: baseScan({ scanSummary: { entryPoint: 'src/index.ts' } }) });
    const ef = p.facts.find((f) => f.claim === 'Entry point: src/index.ts.');
    expect(ef?.source_ref).toBe('src/index.ts');
    expect(ef?.file_path).toBe('src/index.ts');
  });

  it('caps total facts at 60 and README fragments at 6', () => {
    const many = Array.from({ length: 100 }, (_, i) => `stack-${i}`);
    expect(build({ scan: baseScan({ stack: { detectedStacks: many } }) }).facts.length).toBeLessThanOrEqual(60);
    const headings = Array.from({ length: 10 }, (_, i) => `# H${i}\n\nBody ${i}.\n`).join('\n');
    writeFileSync(join(tmpDir, 'README.md'), headings);
    expect(build().readme_fragments.length).toBeLessThanOrEqual(6);
  });

  it('tolerates an absent scan object: every optional chain short-circuits to empty defaults', () => {
    const p = buildRepoEvidencePacket({
      repositoryFullName: 'djimit/bare', localPath: tmpDir, scan: undefined as any, graph: baseGraph(),
    });
    expect(p.facts).toEqual([]);
    expect(p.stack).toEqual([]);
    expect(p.health).toEqual({ score: null, drivers: [], findings: [] });
    expect(p.license).toBeNull();
    expect(p.package_manager).toBeNull();
  });

  it('uses the empty-array fallback when scan omits stack/healthFindings (no synthetic "Stryker was here" facts)', () => {
    const p = build({ scan: { scanSummary: {} } as any });
    expect(p.stack).toEqual([]);
    expect(p.facts.some((f) => f.claim.includes('uses '))).toBe(false);
    expect(p.facts.some((f) => f.source_ref.startsWith('scan:health:'))).toBe(false);
  });

  it('assigns sequential fact ids starting at fact-1', () => {
    const p = build({ scan: baseScan({ stack: { detectedStacks: ['TypeScript'] } }) });
    expect(p.facts[0].id).toBe('fact-1');
    expect(p.facts.map((f) => f.id)).toEqual(['fact-1']);
  });

  it('caps detected stacks at 8 facts', () => {
    const stacks = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const p = build({ scan: baseScan({ stack: { detectedStacks: stacks } }) });
    const stackFacts = p.facts.filter((f) => f.source_ref.startsWith('scan:detected_stacks:'));
    expect(stackFacts).toHaveLength(8);
    expect(p.stack).toHaveLength(10);
  });

  it('caps communities at 10, hubs/bridges/flows at 5 facts each', () => {
    const mk = <T>(n: number, fn: (i: number) => T) => Array.from({ length: n }, (_, i) => fn(i));
    const graph = baseGraph({
      communities: mk(12, (i) => ({ name: `c${i}`, size: 2, cohesion: 0.1, language: 'TS' })),
      hub_nodes: mk(7, (i) => ({ name: `h${i}`, file: `f${i}.ts`, total_degree: 3 })),
      bridge_nodes: mk(7, (i) => ({ name: `b${i}`, file: `f${i}.ts`, betweenness: 0.1 })),
      top_flows: mk(7, (i) => ({ name: `fl${i}`, criticality: 0.5, depth: 2, node_count: 4 })),
    });
    const facts = build({ graph }).facts;
    expect(facts.filter((f) => f.source_ref.startsWith('graph:community:'))).toHaveLength(10);
    expect(facts.filter((f) => f.source_ref.startsWith('graph:hub:'))).toHaveLength(5);
    expect(facts.filter((f) => f.source_ref.startsWith('graph:bridge:'))).toHaveLength(5);
    expect(facts.filter((f) => f.source_ref.startsWith('graph:flow:'))).toHaveLength(5);
  });

  it('uses the empty-array fallback when graph array fields are undefined', () => {
    const p = buildRepoEvidencePacket({
      repositoryFullName: 'djimit/g', localPath: tmpDir, scan: baseScan(),
      graph: { total_nodes: 0, total_edges: 0, total_files: 0, risk_score: null } as GraphSummary,
    });
    expect(p.facts).toEqual([]);
    expect(p.graph.communities).toBeUndefined();
  });

  it('emits exactly 15 health facts (the addFact loop cap, not the output slice) for 20 findings', () => {
    const findings = Array.from({ length: 20 }, (_, i) => ({
      severity: i === 5 ? 'critical' : 'low', title: `f-${i}`, description: 'desc',
    }));
    const facts = build({ scan: baseScan({ healthFindings: findings }) }).facts;
    expect(facts.filter((f) => f.source_ref.startsWith('scan:health:'))).toHaveLength(15);
  });

  it('ranks unknown severities after known ones via the ?? 9 fallback', () => {
    const findings = [
      { severity: 'info', title: 'ti', description: 'd' },
      { severity: 'high', title: 'th', description: 'd' },
      { severity: 'critical', title: 'tc', description: 'd' },
    ];
    const p = build({ scan: baseScan({ healthFindings: findings }) });
    expect(p.health.findings.map((f) => f.title)).toEqual(['tc', 'th', 'ti']);
  });

  it('joins README body lines with single spaces and resets the buffer between headings', () => {
    writeFileSync(join(tmpDir, 'README.md'), '# A\n\nalpha\nbeta\n\n# B\n\ngamma\n');
    const p = build();
    const a = p.readme_fragments.find((f) => f.heading === 'A');
    const b = p.readme_fragments.find((f) => f.heading === 'B');
    expect(a?.excerpt).toBe('alpha beta');
    expect(b?.excerpt).toBe('gamma');
  });

  it('only treats lines starting with 1-3 hashes as headings and strips the leading hashes exactly', () => {
    writeFileSync(join(tmpDir, 'README.md'), '# Title\n\nsee # more detail below\n');
    const p = build();
    expect(p.readme_fragments).toHaveLength(1);
    expect(p.readme_fragments[0].heading).toBe('Title');
    expect(p.readme_fragments[0].excerpt).toBe('see # more detail below');
    writeFileSync(join(tmpDir, 'README.md'), '## Two\n\nbody\n');
    expect(build().readme_fragments[0].heading).toBe('Two');
  });

  it('caps README-derived facts at 6 even when more fragments are parsed', () => {
    const headings = Array.from({ length: 10 }, (_, i) => `# H${i}\n\nBody ${i}.\n`).join('\n');
    writeFileSync(join(tmpDir, 'README.md'), headings);
    const readmeFacts = build().facts.filter((f) => f.source_type === 'readme_heading');
    expect(readmeFacts).toHaveLength(6);
  });

  it('truncates the AGENTS.md summary to 2000 characters', () => {
    writeFileSync(join(tmpDir, 'AGENTS.md'), `${'# Agents\n\n'}${'A'.repeat(2500)}\n`);
    const p = build();
    expect(p.agents_md_summary?.length).toBe(2000);
  });
});