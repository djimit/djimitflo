/**
 * API clients for Djimitflo backend.
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
