/**
 * SBOM routes — Software Bill of Materials generation and export.
 *
 * Generates CycloneDX-format SBOMs for supply chain security.
 * Scans package-lock.json and workspace dependencies.
 */

import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';

interface SBOMComponent {
  type: 'library' | 'framework' | 'application';
  name: string;
  version: string;
  purl?: string;
  scope: 'runtime' | 'dev' | 'optional';
  license?: string;
}

interface CycloneDXSBOM {
  bomFormat: 'CycloneDX';
  specVersion: '1.6';
  serialNumber: string;
  version: number;
  metadata: {
    timestamp: string;
    tools: Array<{ vendor: string; name: string; version: string }>;
  };
  components: SBOMComponent[];
}

export function createSBOMRoutes(_db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  // GET /api/sbom/generate — generate CycloneDX SBOM
  router.get('/generate', requirePermission('read:evidence'), (_req, res) => {
    try {
      const sbom = generateCycloneDX();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="sbom.json"');
      res.json(sbom);
    } catch (error) {
      res.status(500).json({
        error: {
          message: `SBOM generation failed: ${error instanceof Error ? error.message : String(error)}`,
          code: 'SBOM_GENERATION_ERROR',
        },
      });
    }
  });

  // GET /api/sbom/summary — dependency summary
  router.get('/summary', requirePermission('read:evidence'), (_req, res) => {
    try {
      const sbom = generateCycloneDX();
      const summary = {
        totalComponents: sbom.components.length,
        runtimeDeps: sbom.components.filter(c => c.scope === 'runtime').length,
        devDeps: sbom.components.filter(c => c.scope === 'dev').length,
        frameworks: sbom.components.filter(c => c.type === 'framework').length,
        libraries: sbom.components.filter(c => c.type === 'library').length,
        generatedAt: sbom.metadata.timestamp,
      };
      res.json(summary);
    } catch (error) {
      res.status(500).json({
        error: {
          message: `SBOM summary failed: ${error instanceof Error ? error.message : String(error)}`,
          code: 'SBOM_SUMMARY_ERROR',
        },
      });
    }
  });

  return router;
}

function generateCycloneDX(): CycloneDXSBOM {
  const components: SBOMComponent[] = [];
  const rootDir = process.cwd();

  const lockfilePath = join(rootDir, 'package-lock.json');
  if (existsSync(lockfilePath)) {
    try {
      const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'));
      const packages = lockfile.packages || {};

      for (const [pkgPath, pkgInfo] of Object.entries(packages)) {
        if (!pkgPath || !pkgInfo || typeof pkgInfo !== 'object') continue;
        const info = pkgInfo as any;
        if (!info.version) continue;

        const name = pkgPath.replace('node_modules/', '').replace(/^.*node_modules\//, '');
        if (!name || name === '') continue;

        components.push({
          type: 'library',
          name,
          version: info.version,
          purl: `pkg:npm/${encodeURIComponent(name)}@${info.version}`,
          scope: info.dev ? 'dev' : 'runtime',
          license: info.license,
        });
      }
    } catch {
      // Best-effort parsing
    }
  }

  const workspaces = ['packages/server', 'packages/dashboard', 'packages/shared', 'packages/mcp-server', 'packages/telegram'];
  for (const ws of workspaces) {
    const pkgPath = join(rootDir, ws, 'package.json');
    if (!existsSync(pkgPath)) continue;

    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      components.push({
        type: 'application',
        name: pkg.name || ws,
        version: pkg.version || '0.0.0',
        scope: 'runtime',
      });
    } catch {
      // Best-effort
    }
  }

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [
        { vendor: 'DjimFlo', name: 'sbom-generator', version: '1.0.0' },
      ],
    },
    components,
  };
}
