import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export interface IntegrationReachability {
  routeFile: string;
  serviceFiles: string[];
  routeTestFiles: string[];
  serviceTestFiles: string[];
  coverage: 'http-and-service' | 'http-only' | 'service-only' | 'uncovered';
  runtimeEvidence: 'not-attributed';
}

export interface CodeAnalysisReport {
  id: string;
  timestamp: string;
  totalFiles: number;
  totalLines: number;
  deadExports: string[];
  unreachableBranches: string[];
  performanceIssues: string[];
  securityIssues: string[];
  testCoverageGaps: string[];
  architecturalIssues: string[];
  complexityHotspots: Array<{ file: string; complexity: number }>;
  recommendations: string[];
  findingCounts: Record<string, number>;
  analysisMethod: 'route-service-test-static-evidence';
  analysisLimitations: string[];
  hotspotMethod: 'file-line-count-size-proxy';
  integrationReachability: IntegrationReachability[];
}

export class SelfCodeAnalysisService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS self_code_analysis (
        id TEXT PRIMARY KEY,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  analyze(): CodeAnalysisReport {
    const files = this.scanSourceFiles();
    const totalLines = this.countLines(files);
    const deadExports = this.findDeadExports(files);
    const unreachable = this.findUnreachableCode(files);
    const perfIssues = this.findPerformanceIssues(files);
    const secIssues = this.findSecurityIssues(files);
    const integrationReachability = this.buildIntegrationReachability();
    const coverageGaps = integrationReachability
      .filter((entry) => entry.coverage !== 'http-and-service')
      .map((entry) => `${entry.routeFile}: ${entry.coverage}; services=${entry.serviceFiles.join(',') || 'none'}`);
    const archIssues = this.findArchitecturalIssues(files);
    const hotspots = this.findComplexityHotspots(files);

    const report: CodeAnalysisReport = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      totalFiles: files.length,
      totalLines,
      deadExports: deadExports.slice(0, 20),
      unreachableBranches: unreachable.slice(0, 10),
      performanceIssues: perfIssues.slice(0, 10),
      securityIssues: secIssues.slice(0, 10),
      testCoverageGaps: coverageGaps.slice(0, 20),
      architecturalIssues: archIssues.slice(0, 10),
      complexityHotspots: hotspots.slice(0, 10),
      recommendations: this.generateRecommendations(deadExports, secIssues, archIssues, hotspots),
      findingCounts: {
        deadExportCandidates: deadExports.length,
        unreachableBranchCandidates: unreachable.length,
        performanceCandidates: perfIssues.length,
        securityCandidates: secIssues.length,
        testCoverageCandidates: coverageGaps.length,
        architecturalCandidates: archIssues.length,
        complexityHotspots: hotspots.length,
        routesAnalyzed: integrationReachability.length,
        routesWithHttpAndServiceTests: integrationReachability.filter((entry) => entry.coverage === 'http-and-service').length,
      },
      analysisMethod: 'route-service-test-static-evidence',
      analysisLimitations: [
        'Dead-export and unreachable-branch findings are regex candidates, not compiler-proven facts.',
        'Runtime evidence is not yet attributed to individual route entries.',
        'Hotspot values are file line counts and must not be interpreted as cyclomatic complexity.',
      ],
      hotspotMethod: 'file-line-count-size-proxy',
      integrationReachability,
    };

    this.db.prepare('INSERT INTO self_code_analysis (id, report_json) VALUES (?, ?)').run(report.id, JSON.stringify(report));
    return report;
  }

  getLatestReport(): CodeAnalysisReport | null {
    const row = this.db.prepare('SELECT report_json FROM self_code_analysis ORDER BY created_at DESC LIMIT 1').get() as { report_json: string } | undefined;
    return row ? JSON.parse(row.report_json) as CodeAnalysisReport : null;
  }

  private scanSourceFiles(): string[] {
    const files: string[] = [];

    const scanDir = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== 'node_modules' && entry.name !== '__tests__' && entry.name !== 'dist') {
              scanDir(fullPath);
            }
          } else if (entry.name.endsWith('.ts')) {
            files.push(fullPath);
          }
        }
      } catch { /* skip */ }
    };

    // Resolve from this file's location, not cwd or a hardcoded path, so the
    // scan works in CI and in any checkout (repo root is four levels up).
    const repoRoot = path.resolve(__dirname, '../../../..');
    const dirs = [
      path.join(repoRoot, 'packages/server/src'),
      path.join(repoRoot, 'packages/shared/src'),
    ];
    for (const dir of dirs) {
      try { scanDir(dir); } catch { /* skip */ }
    }

    return files.length > 0 ? files : ['packages/server/src/services/loop-service.ts'];
  }

  private countLines(files: string[]): number {
    let total = 0;
    const fs = require('fs');
    for (const f of files) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        total += content.split('\n').length;
      } catch { /* skip */ }
    }
    return total;
  }

  private findDeadExports(files: string[]): string[] {
    const dead: string[] = [];
    const fs = require('fs');
    const exported = new Map<string, string[]>();
    const source = new Map<string, string>();

    for (const f of files) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        source.set(f, content);
        const exportMatches = content.matchAll(/export\s+(?:class|function|const|interface|type)\s+(\w+)/g);
        for (const m of exportMatches) {
          const name = m[1];
          if (!exported.has(f)) exported.set(f, []);
          exported.get(f)!.push(name);
        }
      } catch { /* skip */ }
    }

    for (const [file, names] of exported) {
      for (const name of names) {
        const referencedElsewhere = [...source.entries()].some(([candidate, content]) =>
          candidate !== file && new RegExp(`\\b${name}\\b`).test(content));
        if (!referencedElsewhere && name !== 'main' && name !== 'default') {
          dead.push(`${file}:${name}`);
        }
      }
    }

    return dead;
  }

  private findUnreachableCode(files: string[]): string[] {
    const unreachable: string[] = [];
    const fs = require('fs');
    for (const f of files) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        const returnFollowedByCode = /return\s+[^;]+;\s*\n\s*(?!.*\/\/).*[a-zA-Z]/;
        if (returnFollowedByCode.test(content)) {
          unreachable.push(f);
        }
      } catch { /* skip */ }
    }
    return unreachable;
  }

  private findPerformanceIssues(files: string[]): string[] {
    const issues: string[] = [];
    const fs = require('fs');
    for (const f of files) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        if (content.includes('JSON.parse(JSON.stringify(')) {
          issues.push(`${f}: Uses JSON.parse(JSON.stringify()) for deep clone — consider structuredClone()`);
        }
        if (/for\s*\([^)]+\)\s*\{[^}]*\.push\(/m.test(content)) {
          issues.push(`${f}: Array push in loop — consider pre-allocation or map()`);
        }
      } catch { /* skip */ }
    }
    return issues;
  }

  private findSecurityIssues(files: string[]): string[] {
    const issues: string[] = [];
    const fs = require('fs');
    for (const f of files) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        if (content.includes('execSync') && !content.includes('timeout')) {
          const lines = content.split('\n').filter((l: string) => l.includes('execSync') && !l.includes('timeout') && !l.trim().startsWith('//'));
          if (lines.length > 0) {
            issues.push(`${f}: ${lines.length} execSync calls without timeout — potential DoS`);
          }
        }
      } catch { /* skip */ }
    }
    return issues;
  }

  private buildIntegrationReachability(): IntegrationReachability[] {
    const serverRoot = path.join(this.repoRoot(), 'packages/server/src');
    const routesDir = path.join(serverRoot, 'routes');
    const testsDir = path.join(serverRoot, '__tests__');
    const routeFiles = fs.readdirSync(routesDir)
      .filter((file) => file.endsWith('.ts') && file !== 'index.ts')
      .map((file) => path.join(routesDir, file));
    const testFiles = fs.readdirSync(testsDir)
      .filter((file) => file.endsWith('.test.ts'))
      .map((file) => path.join(testsDir, file));
    const testSources = new Map(testFiles.map((file) => [file, fs.readFileSync(file, 'utf8')]));

    return routeFiles.map((routeFile) => {
      const routeSource = fs.readFileSync(routeFile, 'utf8');
      const serviceNames = [...routeSource.matchAll(/(?:from\s+|import\()['"]\.\.\/services\/([^'"]+)['"]/g)]
        .map((match) => match[1].replace(/\.js$/, ''));
      const serviceFiles = [...new Set(serviceNames)]
        .map((name) => path.join(serverRoot, 'services', `${name}.ts`))
        .filter((file) => fs.existsSync(file));
      const routeName = path.basename(routeFile, '.ts');
      const routeTestFiles = [...testSources.entries()]
        .filter(([, source]) => new RegExp(`(?:\\.\\./routes/${this.escapeRegex(routeName)}|create${this.pascalCase(routeName)}Routes\\b)`).test(source))
        .map(([file]) => path.relative(this.repoRoot(), file));
      const serviceTestFiles = [...testSources.entries()]
        .filter(([, source]) => serviceNames.some((name) => source.includes(`../services/${name}`)))
        .map(([file]) => path.relative(this.repoRoot(), file));
      const hasHttp = routeTestFiles.length > 0;
      const hasService = serviceFiles.length === 0 || serviceNames.every((name) =>
        [...testSources.values()].some((source) => source.includes(`../services/${name}`)));

      return {
        routeFile: path.relative(this.repoRoot(), routeFile),
        serviceFiles: serviceFiles.map((file) => path.relative(this.repoRoot(), file)),
        routeTestFiles,
        serviceTestFiles: [...new Set(serviceTestFiles)],
        coverage: hasHttp && hasService ? 'http-and-service' : hasHttp ? 'http-only' : hasService ? 'service-only' : 'uncovered',
        runtimeEvidence: 'not-attributed',
      };
    });
  }

  private repoRoot(): string {
    return path.resolve(__dirname, '../../../..');
  }

  private pascalCase(value: string): string {
    return value.split(/[-_]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private findArchitecturalIssues(files: string[]): string[] {
    const issues: string[] = [];
    if (files.length > 80) {
      issues.push(`Large service count (${files.length}) — consider domain-based grouping`);
    }
    return issues;
  }

  private findComplexityHotspots(files: string[]): Array<{ file: string; complexity: number }> {
    const hotspots: Array<{ file: string; complexity: number }> = [];
    const fs = require('fs');
    for (const f of files) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        const lines = content.split('\n').length;
        if (lines > 200) {
          hotspots.push({ file: f, complexity: lines });
        }
      } catch { /* skip */ }
    }
    return hotspots.sort((a, b) => b.complexity - a.complexity);
  }

  private generateRecommendations(dead: string[], sec: string[], arch: string[], hotspots: Array<{ file: string; complexity: number }>): string[] {
    const recs: string[] = [];
    if (dead.length > 0) recs.push(`Review ${dead.length} unreferenced export candidates before removal`);
    if (sec.length > 0) recs.push(`Validate ${sec.length} security candidates`);
    if (hotspots.length > 0) recs.push(`Review ${hotspots.length} large-file hotspots; split only at proven boundaries`);
    if (arch.length > 0) recs.push(...arch);
    recs.push('Prioritize uncovered route-to-service behavior before adding more service-only tests');
    return recs;
  }
}
