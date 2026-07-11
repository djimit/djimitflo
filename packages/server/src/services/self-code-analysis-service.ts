import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

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
    const coverageGaps = this.findTestCoverageGaps(files);
    const archIssues = this.findArchitecturalIssues(files);
    const hotspots = this.findComplexityHotspots(files);

    const report: CodeAnalysisReport = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      totalFiles: files.length,
      totalLines,
      deadExports,
      unreachableBranches: unreachable,
      performanceIssues: perfIssues,
      securityIssues: secIssues,
      testCoverageGaps: coverageGaps,
      architecturalIssues: archIssues,
      complexityHotspots: hotspots,
      recommendations: this.generateRecommendations(deadExports, secIssues, archIssues, hotspots),
    };

    this.db.prepare('INSERT INTO self_code_analysis (id, report_json) VALUES (?, ?)').run(report.id, JSON.stringify(report));
    return report;
  }

  getLatestReport(): CodeAnalysisReport | null {
    const row = this.db.prepare('SELECT report_json FROM self_code_analysis ORDER BY created_at DESC LIMIT 1').get() as { report_json: string } | undefined;
    return row ? JSON.parse(row.report_json) as CodeAnalysisReport : null;
  }

  private scanSourceFiles(): string[] {
    const fs = require('fs');
    const path = require('path');
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
    const imported = new Set<string>();

    for (const f of files) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        const exportMatches = content.matchAll(/export\s+(?:class|function|const|interface|type)\s+(\w+)/g);
        for (const m of exportMatches) {
          const name = m[1];
          if (!exported.has(f)) exported.set(f, []);
          exported.get(f)!.push(name);
        }
        const importMatches = content.matchAll(/from\s+['"]([^'"]+)['"]/g);
        for (const m of importMatches) {
          imported.add(m[1]);
        }
      } catch { /* skip */ }
    }

    for (const [file, names] of exported) {
      for (const name of names) {
        const isImported = [...imported].some(imp => imp.includes(file.replace('packages/server/src/services/', './').replace('.ts', '')));
        if (!isImported && name !== 'main' && name !== 'default') {
          dead.push(`${file}:${name}`);
        }
      }
    }

    return dead.slice(0, 20);
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
    return unreachable.slice(0, 10);
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
    return issues.slice(0, 10);
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
    return issues.slice(0, 10);
  }

  private findTestCoverageGaps(files: string[]): string[] {
    const gaps: string[] = [];
    const testFiles = new Set<string>();

    try {
      const { execSync } = require('child_process');
      const testOutput = execSync("find packages/server/src/__tests__ -name '*.test.ts' 2>/dev/null || true", { encoding: 'utf8', timeout: 10_000 });
      for (const tf of testOutput.split('\n').filter(Boolean)) {
        testFiles.add(tf.replace('__tests__/', '').replace('.test.ts', '.ts'));
      }
    } catch { /* skip */ }

    for (const f of files) {
      const baseName = f.replace('packages/server/src/', '');
      const hasTest = [...testFiles].some(tf => tf.includes(baseName.replace('.ts', '')));
      if (!hasTest && !f.includes('index.') && !f.includes('schema.') && !f.includes('migrate')) {
        gaps.push(f);
      }
    }

    return gaps.slice(0, 20);
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
    return hotspots.sort((a, b) => b.complexity - a.complexity).slice(0, 10);
  }

  private generateRecommendations(dead: string[], sec: string[], arch: string[], hotspots: Array<{ file: string; complexity: number }>): string[] {
    const recs: string[] = [];
    if (dead.length > 0) recs.push(`Remove ${dead.length} dead exports to reduce bundle size`);
    if (sec.length > 0) recs.push(`Fix ${sec.length} security issues`);
    if (hotspots.length > 0) recs.push(`Refactor ${hotspots.length} large files (>200 lines)`);
    if (arch.length > 0) recs.push(...arch);
    recs.push('Add integration tests for all new Level-9/Level-10 services');
    recs.push('Implement automated performance benchmarking');
    return recs;
  }
}
