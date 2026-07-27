/**
 * AutonomousTestGeneratorService — generates tests for untested code.
 *
 * Scans the codebase for untested public methods and proposes
 * explicit Vitest TODOs for the governed self-improvement loop.
 *
 * Strategy:
 * 1. Find all public methods in service files
 * 2. Check if corresponding test exists
 * 3. Generate test file with:
 *    - Database setup (in-memory SQLite)
 *    - Service instantiation
 *    - Happy path test
 *    - Error path test
 *    - Edge case tests
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

interface TestGenerationResult {
  id: string;
  sourceFile: string;
  testFile: string;
  methods: string[];
  generated: boolean;
  testContent: string;
  createdAt: string;
}

export class AutonomousTestGeneratorService {
  private srcDir: string;
  private testsDir: string;

  constructor(_db: Database) {
    this.srcDir = join(process.cwd(), 'packages', 'server', 'src', 'services');
    this.testsDir = join(process.cwd(), 'packages', 'server', 'src', '__tests__');
  }

  /**
   * Generate tests for all untested services.
   */
  generateAll(): TestGenerationResult[] {
    const results: TestGenerationResult[] = [];

    const serviceFiles = this.getServiceFiles();

    for (const file of serviceFiles) {
      const testPath = join(this.testsDir, basename(file).replace('.ts', '.test.ts'));

      if (existsSync(testPath)) continue; // Already tested

      const content = readFileSync(file, 'utf8');
      const methods = this.extractPublicMethods(content);

      if (methods.length === 0) continue;

      const testContent = this.generateTestContent(file, methods);

      results.push({
        id: randomUUID(),
        sourceFile: file.replace(this.srcDir + '/', ''),
        testFile: testPath.replace(this.testsDir + '/', ''),
        methods,
        generated: false,
        testContent,
        createdAt: new Date().toISOString(),
      });
    }

    return results;
  }

  /**
   * Generate tests for a specific service file.
   */
  generateForFile(filePath: string): TestGenerationResult | null {
    if (!existsSync(filePath)) return null;

    const content = readFileSync(filePath, 'utf8');
    const methods = this.extractPublicMethods(content);

    if (methods.length === 0) return null;

    const testContent = this.generateTestContent(filePath, methods);

    return {
      id: randomUUID(),
      sourceFile: filePath.replace(this.srcDir + '/', ''),
      testFile: filePath.replace('services/', '__tests__/').replace('.ts', '.test.ts'),
      methods,
      generated: false,
      testContent,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalServices: number;
    testedServices: number;
    untestedServices: number;
    coverage: number;
    coverageMetric: 'direct_test_file_match';
    integrationCoverage: null;
  } {
    const serviceFiles = this.getServiceFiles().filter((file) => {
      const content = readFileSync(file, 'utf8');
      return this.extractPublicMethods(content).length > 0;
    });
    let tested = 0;

    for (const file of serviceFiles) {
      const testPath = join(this.testsDir, basename(file).replace('.ts', '.test.ts'));
      if (existsSync(testPath)) tested++;
    }

    const total = serviceFiles.length;
    return {
      totalServices: total,
      testedServices: tested,
      untestedServices: total - tested,
      coverage: total > 0 ? Math.round((tested / total) * 100) : 100,
      coverageMetric: 'direct_test_file_match',
      integrationCoverage: null,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private getServiceFiles(): string[] {
    const files: string[] = [];
    const scanDir = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }
        if (stat.isDirectory()) continue;
        if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
          files.push(fullPath);
        }
      }
    };
    scanDir(this.srcDir);
    return files;
  }

  private extractPublicMethods(content: string): string[] {
    const methods: string[] = [];
    const lines = content.split('\n');
    let braceDepth = 0;
    let classDepth = 0;
    let inClass = false;

    for (const line of lines) {
      if (!inClass && /^\s*export\s+class\s+\w+/.test(line)) {
        inClass = true;
        classDepth = braceDepth + 1;
      }

      const match = inClass && braceDepth === classDepth
        ? line.match(/^  (?:async\s+)?(\w+)\s*\(/)
        : null;
      if (match && !line.includes('private') && !line.includes('protected') && !line.includes('constructor')) {
        const methodName = match[1];
        if (['if', 'for', 'while', 'switch', 'catch', 'return'].includes(methodName)) continue;
        methods.push(methodName);
      }

      braceDepth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      if (inClass && braceDepth < classDepth) inClass = false;
    }

    return [...new Set(methods)];
  }

  private generateTestContent(sourceFile: string, methods: string[]): string {
    const serviceName = basename(sourceFile, '.ts');
    const className = this.toPascalCase(serviceName);

    const testCases = methods.slice(0, 5)
      .map((method) => `  it.todo('${method}: define observable behavior and a failing oracle');`)
      .join('\n');

    return `import { describe, it } from 'vitest';

describe('${className}', () => {
${testCases});
});
`;
  }

  private toPascalCase(str: string): string {
    return str.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  }
}
