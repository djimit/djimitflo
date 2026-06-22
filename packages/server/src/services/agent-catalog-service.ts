import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { AgentCatalog } from '@djimitflo/agent-catalog';

// Singleton catalog instance backed by its own SQLite file (does not touch the
// djimitflo core schema). Seeded once from the upstream clone if present.
let catalog: AgentCatalog | null = null;

export function getCatalog(): AgentCatalog {
  if (catalog) return catalog;
  const dbPath = process.env.AGENT_CATALOG_DB || join(process.cwd(), '.data', 'agent-catalog.sqlite');
  mkdirSync(dirname(dbPath), { recursive: true });
  catalog = new AgentCatalog(dbPath);
  // Auto-seed from upstream clone if the catalog is empty and the source exists.
  const source = process.env.AGENT_CATALOG_SOURCE || join(process.env.HOME || '', 'djimit-agent-catalog', 'upstream');
  if (catalog.counts().total === 0 && existsSync(source)) {
    try { catalog.importTree(source, 'msitarzewski/agency-agents'); } catch (e) {
      console.warn('[agent-catalog] auto-seed failed:', (e as Error).message);
    }
  }
  return catalog;
}
