import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAgentCatalogDbPath } from '../services/agent-catalog-service';

describe('agent catalog database path', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('anchors the default catalog database at the monorepo root from a workspace cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'djimflo-catalog-root-'));
    mkdirSync(join(root, 'packages', 'server', 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}');
    try {
      expect(resolveAgentCatalogDbPath(join(root, 'packages', 'server'))).toBe(join(root, '.data', 'agent-catalog.sqlite'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves an explicit catalog database override', () => {
    vi.stubEnv('AGENT_CATALOG_DB', '/tmp/explicit-agent-catalog.sqlite');
    expect(resolveAgentCatalogDbPath('/unrelated/workspace')).toBe('/tmp/explicit-agent-catalog.sqlite');
  });
});
