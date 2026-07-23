/**
 * API clients for DjimFlo backend.
 * Domain-specific clients split from monolithic api.ts.
 * 
 * Task 5.3: ApiClient domain split (1567 -> ~10 domains, ~150 lines each)
 */
export { API_BASE, getToken, request } from './api-client';
export { tasksApi } from './api/tasks';
export { agentsApi } from './api/agents';
export { governanceApi } from './api/governance';
export { loopsApi } from './api/loops';
export { swarmApi } from './api/swarm';
export { evidenceApi } from './api/evidence';
export { repositoriesApi } from './api/repositories';
export { catalogApi } from './api/catalog';
export { exportsApi } from './api/exports';
export { cognitiveApi } from './api/cognitive';

// Backward-compatible namespace (for gradual migration)
import { tasksApi } from './api/tasks';
import { request } from './api-client';
import { agentsApi } from './api/agents';
import { governanceApi } from './api/governance';
import { loopsApi } from './api/loops';
import { swarmApi } from './api/swarm';
import { evidenceApi } from './api/evidence';
import { repositoriesApi } from './api/repositories';
import { catalogApi } from './api/catalog';
import { exportsApi } from './api/exports';
import { cognitiveApi } from './api/cognitive';

/** @deprecated Use domain-specific clients instead */
export const api = {
  request,
  ...tasksApi,
  ...agentsApi,
  ...governanceApi,
  ...loopsApi,
  ...swarmApi,
  ...evidenceApi,
  ...repositoriesApi,
  ...catalogApi,
  ...exportsApi,
  ...cognitiveApi,
};

// Re-export types that consumers import from api
export type { CatalogCounts, CatalogAgent, CatalogSearchResult } from './api/catalog';
export type { UsageQuota, UsageBreakdown, UsageLog } from './api/evidence';
