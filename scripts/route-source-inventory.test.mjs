import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventoryRouteSource, compareRuntimeRoutes, inventoryDashboardClient } from './route-source-inventory.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'djimitflo-route-inventory-'));
  const dir = join(root, 'packages/server/src/routes');
  mkdirSync(dir, { recursive: true });
  try { run(root, dir); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('source graph preserves aliases, nested factories, return adapters, arrays and direct routes', () => fixture((root, dir) => {
  writeFileSync(join(dir, 'index.ts'), `import { createAliasRoutes } from './child';
    export function createRoutes() { const router = Router(); router.get('/version', handler);
      mountRoutes(router, [{prefix:'/one', middleware:[], router:createAliasRoutes()}, {prefix:'/two', middleware:[], router:createAliasRoutes()}]); return router; }`);
  writeFileSync(join(dir, 'child.ts'), `export function createAliasRoutes() { return createChildRoutes(); }
    export function createChildRoutes() { const router = Router(); router.get(['/status','/status/:id'], handler); return router; }
    export function createUnusedRoutes() { const router = Router(); router.post('/phantom', handler); return router; }
    // router.delete('/comment-is-not-a-route', handler)`);
  const source = inventoryRouteSource(root);
  assert.deepEqual(source.mounted.map(route => route.mounted_path), ['/api/version', '/api/one/status', '/api/one/status/:id', '/api/two/status', '/api/two/status/:id']);
  assert.deepEqual(source.outside_api_mount_graph.map(route => route.path), ['/phantom']);
  assert.deepEqual(source.unsupported, []);
}));

test('a computed source path is explicitly unsupported, never silently green', () => fixture((root, dir) => {
  writeFileSync(join(dir, 'index.ts'), 'export function createRoutes() { router.get(computePath(), handler); }');
  assert.equal(inventoryRouteSource(root).unsupported[0].reason, 'Nonliteral route path');
}));

test('comparison detects both a removed registration and a phantom source claim', () => {
  assert.deepEqual(compareRuntimeRoutes({ mounted: [{ method: 'GET', mounted_path: '/api/missing' }], unsupported: [] }, [{ method: 'POST', path: '/api/actual' }]), {
    declared_not_registered: ['GET /api/missing'], registered_not_declared: ['POST /api/actual'], unsupported_source: [],
  });
});

test('client matching retains method mismatches and dynamic uncertainty', () => fixture((root) => {
  mkdirSync(join(root, 'packages/dashboard/src/lib'), { recursive: true });
  writeFileSync(join(root, 'packages/dashboard/src/lib/api.ts'), 'class API { get(id) { this.request(`/tasks/${id}`); this.request("/tasks", {method:"POST"}); this.request(`/tasks${query}`); } }');
  const inventory = inventoryDashboardClient(root, [{ method: 'GET', path: '/api/tasks/:id' }]);
  assert.deepEqual(inventory.calls.map(call => call.status), ['REGISTERED_PATH_MATCH_ONLY', 'NO_REGISTERED_MATCH', 'DYNAMIC_UNRESOLVED']);
}));
