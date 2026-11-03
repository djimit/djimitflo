import { expect, it } from 'vitest';

it('UX-0: coverage counts a mounted route as UI-called only on a method + path match, and keeps machine routers apart', async () => {
  const { coverageByRouter } = await import('../../../../scripts/ux-coverage.mjs');
  const mounted = [
    { factory: 'createGoalRoutes', method: 'GET', mounted_path: '/api/goals' },
    { factory: 'createGoalRoutes', method: 'POST', mounted_path: '/api/goals' },
    { factory: 'createGoalRoutes', method: 'GET', mounted_path: '/api/goals/:id' },
    { factory: 'createRemoteGymRoutes', method: 'POST', mounted_path: '/api/gym-worker/claim' },
  ];
  const calls = [
    { method: 'GET', matching_routes: ['/api/goals', '/api/goals/:id'], status: 'REGISTERED_PATH_MATCH_ONLY' },
    { method: null, matching_routes: [], status: 'DYNAMIC_UNRESOLVED' },
  ];
  const r = coverageByRouter(mounted, calls);
  expect(r.routers).toEqual([
    { router: 'createGoalRoutes', machine: false, routes: 3, covered: 2, pct: 67 },
    { router: 'createRemoteGymRoutes', machine: true, routes: 1, covered: 0, pct: 0 },
  ]);
  expect(r.totals).toMatchObject({ routes: 4, covered: 2, operator: { routes: 3, covered: 2 }, machine: { routes: 1, covered: 0 }, operator_pct: 67, unresolved_calls: 1, unmatched_calls: 0 });
});
