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
import { resolveRepositoryRoot } from '../utils/repository-root';

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
  private routesDir: string;

  constructor(_db: Database, repositoryRoot = resolveRepositoryRoot()) {
    this.srcDir = join(repositoryRoot, 'packages', 'server', 'src', 'services');
    this.testsDir = join(repositoryRoot, 'packages', 'server', 'src', '__tests__');
    this.routesDir = join(repositoryRoot, 'packages', 'server', 'src', 'routes');
  }

  /**
   * Generate tests for all untested services.
   */
  generateAll(): TestGenerationResult[] {
    const results: TestGenerationResult[] = [];

    const serviceFiles = this.getServiceFiles();
    const evidence = this.capabilityEvidence();

    for (const file of serviceFiles) {
      const serviceName = basename(file, '.ts');
      if (!evidence.routedServices.has(serviceName) || evidence.testedServices.has(serviceName)) continue;
      const testPath = join(this.testsDir, basename(file).replace('.ts', '.test.ts'));

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
    coverageMetric: 'route_service_test_reference';
    integrationCoverage: number;
    directTestFileMatches: number;
    routedServices: number;
    routedServicesTested: number;
    routedServicesWithoutEvidence: string[];
    unmountedRouteFiles: string[];
    behaviorCoverage: null;
  } {
    const serviceFiles = this.getServiceFiles().filter((file) => {
      const content = readFileSync(file, 'utf8');
      return this.extractPublicMethods(content).length > 0;
    });
    const evidence = this.capabilityEvidence();
    const serviceNames = new Set(serviceFiles.map((file) => basename(file, '.ts')));
    const tested = [...evidence.testedServices].filter((name) => serviceNames.has(name));
    const routed = [...evidence.routedServices].filter((name) => serviceNames.has(name));
    const routedTested = routed.filter((name) => evidence.testedServices.has(name));
    const directMatches = serviceFiles.filter((file) =>
      existsSync(join(this.testsDir, basename(file).replace('.ts', '.test.ts')))
    ).length;
    const total = serviceFiles.length;
    return {
      totalServices: total,
      testedServices: tested.length,
      untestedServices: routed.length - routedTested.length,
      coverage: routed.length > 0 ? Math.round((routedTested.length / routed.length) * 100) : 100,
      coverageMetric: 'route_service_test_reference',
      integrationCoverage: routed.length > 0 ? Math.round((routedTested.length / routed.length) * 100) : 100,
      directTestFileMatches: directMatches,
      routedServices: routed.length,
      routedServicesTested: routedTested.length,
      routedServicesWithoutEvidence: routed.filter((name) => !evidence.testedServices.has(name)).sort(),
      unmountedRouteFiles: evidence.unmountedRouteFiles,
      behaviorCoverage: null,
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

  private capabilityEvidence(): {
    routedServices: Set<string>;
    testedServices: Set<string>;
    unmountedRouteFiles: string[];
  } {
    const routeFiles = new Map(this.readDirectory(this.routesDir)
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => [basename(entry, '.ts'), readFileSync(join(this.routesDir, entry), 'utf8')]));
    const mountedRouteFiles = new Set<string>();
    const queue = [...(routeFiles.get('index') || '').matchAll(/from '\.\/([a-z0-9-]+)'/g)]
      .map((match) => match[1]);
    while (queue.length > 0) {
      const routeName = queue.shift()!;
      if (mountedRouteFiles.has(routeName) || !routeFiles.has(routeName)) continue;
      mountedRouteFiles.add(routeName);
      for (const match of routeFiles.get(routeName)!.matchAll(/from '\.\/([a-z0-9-]+)'/g)) {
        queue.push(match[1]);
      }
    }
    const routeToServices = new Map<string, Set<string>>();
    for (const [routeName, content] of routeFiles) {
      if (routeName === 'index') continue;
      if (!mountedRouteFiles.has(routeName)) continue;
      routeToServices.set(routeName, new Set(
        [...content.matchAll(/(?:\.\.\/)+services\/([a-z0-9-]+)/g)].map((match) => match[1])
      ));
    }

    const testedServices = new Set<string>();
    for (const entry of this.readDirectory(this.testsDir)) {
      if (!entry.endsWith('.test.ts')) continue;
      const content = readFileSync(join(this.testsDir, entry), 'utf8');
      for (const match of content.matchAll(/(?:\.\.\/)+services\/([a-z0-9-]+)/g)) {
        testedServices.add(match[1]);
      }
      for (const match of content.matchAll(/(?:\.\.\/)+routes\/([a-z0-9-]+)/g)) {
        for (const service of routeToServices.get(match[1]) || []) testedServices.add(service);
      }
    }

    return {
      routedServices: new Set([...routeToServices.values()].flatMap((services) => [...services])),
      testedServices,
      unmountedRouteFiles: [...routeFiles.keys()]
        .filter((routeName) => routeName !== 'index')
        .filter((routeName) => !mountedRouteFiles.has(routeName))
        .sort(),
    };
  }

  private readDirectory(dir: string): string[] {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
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
