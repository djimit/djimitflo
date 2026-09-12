import { describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenApiSpec, collectRoutes, mountRoutes, type RouteMount } from '../utils/route-inventory';

function makeMounts(): RouteMount[] {
  const tasks = Router();
  tasks.get('/', (_req, res) => { res.end(); });
  tasks.post('/', (_req, res) => { res.end(); });
  tasks.get('/:id', (_req, res) => { res.end(); });
  const auth = Router();
  auth.post('/login', (_req, res) => { res.end(); });
  const nestedAuth = Object.assign(((_req: unknown, _res: unknown, next: () => void) => next()) as never, { requiresAuth: true });
  auth.get('/me', nestedAuth, (_req, res) => { res.end(); });
  return [
    { prefix: '/tasks', middleware: [nestedAuth], router: tasks },
    { prefix: '/auth', middleware: [], router: auth },
  ];
}

describe('collectRoutes', () => {
  it('preserves aliases, array paths, direct routes and nested mounts', () => {
    const root = Router(); const parent = Router(); const child = Router();
    root.get('/direct', (_req, res) => { res.end(); });
    child.get(['/status', '/status/:id'], (_req, res) => { res.end(); });
    mountRoutes(parent, [{ prefix: '/child', middleware: [], router: child }]);
    mountRoutes(root, ['/one', '/two'].map(prefix => ({ prefix, middleware: [], router: parent })));
    expect(collectRoutes(root).map(route => route.path)).toEqual([
      '/api/direct', '/api/one/child/status', '/api/one/child/status/:id', '/api/two/child/status', '/api/two/child/status/:id',
    ]);
  });

  it('fails instead of silently omitting an unrecorded nested router', () => {
    const root = Router(); const nested = Router();
    nested.get('/hidden', (_req, res) => { res.end(); });
    root.use('/nested', nested);
    expect(() => collectRoutes(root)).toThrow('unrecorded nested router');
  });
  it('does not confuse rate limiting or other middleware with authentication', () => {
    const router = Router();
    router.get('/public', (_req, res) => { res.end(); });
    expect(collectRoutes([{ prefix: '/', router, middleware: [(_req, _res, next) => next()] }]))
      .toEqual([{ method: 'GET', path: '/api/public', authenticated: false }]);
  });
  it('flattens mounted routers into method+path entries with auth flags', () => {
    const entries = collectRoutes(makeMounts());

    expect(entries).toEqual([
      { method: 'POST', path: '/api/auth/login', authenticated: false },
      { method: 'GET', path: '/api/auth/me', authenticated: true },
      { method: 'GET', path: '/api/tasks', authenticated: true },
      { method: 'POST', path: '/api/tasks', authenticated: true },
      { method: 'GET', path: '/api/tasks/:id', authenticated: true },
    ]);
  });
});

describe('buildOpenApiSpec', () => {
  it('renders OpenAPI 3.1 with templated params and bearer security', () => {
    const spec = buildOpenApiSpec(collectRoutes(makeMounts()), { title: 'Test API', version: '1.0.0' }) as any;

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.paths['/api/tasks/{id}'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.paths['/api/auth/login'].post.security).toBeUndefined();
    expect(spec.paths['/api/auth/me'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  });
});

describe('full aggregator inventory', () => {
  it('compares instantiated API registrations with source declarations and probes auth over real HTTP', async () => {
    const { createTestDb } = await import('./helpers/test-db.js');
    const { createRoutes } = await import('../routes/index');
    const { AuthService } = await import('../services/auth-service');
    const { createAuthMiddleware } = await import('../middleware/auth');
    const { UserRole } = await import('@djimitflo/shared');
    const { inventoryRouteSource, compareRuntimeRoutes, routeSourceFingerprint } = await import('../../../../scripts/route-source-inventory.mjs');
    const db = createTestDb();
    db.exec('DROP TABLE IF EXISTS governance_feedback');
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Provider forbidden in anonymous registration proof'); });
    try {
      const service = new AuthService(db);
      const auth = createAuthMiddleware(service);
      const router = createRoutes(db, undefined, service, auth, undefined, undefined, false);
      const routes = collectRoutes(router);
      const root = resolve(import.meta.dirname, '../../../..');
      const source = inventoryRouteSource(root);
      const comparison = compareRuntimeRoutes(source, routes);
      expect(comparison).toEqual({ declared_not_registered: [], registered_not_declared: [], unsupported_source: [] });
      const app = express().use(express.json()).use('/api', router);
      const checks = [];
      const protectedRoutes = routes.filter(route => route.authenticated);
      let probeApp = app;
      for (const [index, route] of protectedRoutes.entries()) {
        // Preserve actual limiters: fresh independent registration fixtures keep
        // the aggregate sweep below their burst windows, without spoofed IPs or
        // disabling middleware. This is auth coverage, not a rate-limit load test.
        if (index > 0 && index % 100 === 0) {
          const nextRouter = createRoutes(db, undefined, service, auth, undefined, undefined, false);
          expect(collectRoutes(nextRouter)).toEqual(routes);
          probeApp = express().use(express.json()).use('/api', nextRouter);
        }
        const path = route.path.replace(/:[A-Za-z0-9_]+/g, 'unused-auth-probe-fixture-id');
        const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';
        expect(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']).toContain(method);
        const response = await request(probeApp)[method](path).send({});
        checks.push({ method: route.method, path: route.path, request_path: path, status: response.status, error_code: response.body?.error?.code ?? null, scope: 'anonymous_auth_boundary_only' });
      }
      const version = await request(app).get('/api/version');
      expect(version.status).toBe(200);
      expect((await request(app).get('/api/health')).status).toBe(200);
      const user = service.createUser('route-inventory@example.test', 'disposable-route-fixture-only', UserRole.ADMIN);
      const token = service.generateToken(user);
      const workstation = await request(app).get('/api/workstation/urls').set('Authorization', `Bearer ${token}`);
      expect([200, 503]).toContain(workstation.status);
      if (workstation.status === 200) {
        expect(workstation.body).toEqual(expect.objectContaining({ host: expect.any(String), platform: expect.any(String), ports: expect.any(Array) }));
      } else {
        expect(workstation.body.error).toBeDefined();
      }
      const response = await request(app).get('/api/openapi.json').set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(200);
      expect(Object.values(response.body.paths).reduce((total: number, path: unknown) => total + Object.keys(path as object).length, 0)).toBe(routes.length);
      expect(db.prepare('SELECT count(*) count FROM tasks').get()).toEqual({ count: 0 });
      if (process.env.RUNTIME_ROUTE_INVENTORY_PATH) writeFileSync(resolve(root, process.env.RUNTIME_ROUTE_INVENTORY_PATH), `${JSON.stringify({
        schema_version: 1, generated_at: new Date().toISOString(), scope: 'instantiated_api_router',
        source_sha256: routeSourceFingerprint(root), routes, comparison, auth_http_probes: checks,
        auth_http_summary: { total_registered: routes.length, protected_registered: protectedRoutes.length, checked: checks.length, rejected_401: checks.filter(check => check.status === 401).length, unmarked_excluded: routes.filter(route => !route.authenticated), independent_fixture_batch_size: 100 },
        limits: ['Registration and anonymous auth boundaries only, not domain execution or role/permission completeness.', 'All auth-marked registrations probed; unmarked routes excluded from the anonymous sweep.', 'Fresh registration fixtures every 100 probes preserve real rate limiters without a burst-test claim.', 'Explicit API routes only; no implicit HEAD/OPTIONS or startup health/metrics/explore/static SPA coverage.'],
      }, null, 2)}\n`);
      expect(checks).toHaveLength(protectedRoutes.length);
      expect(new Set(checks.map(check => `${check.method} ${check.path}`)).size).toBe(protectedRoutes.length);
      expect(checks.filter(check => check.status !== 401)).toEqual([]);
      expect(provider).not.toHaveBeenCalled();
    } finally { provider.mockRestore(); db.close(); }
  }, 30_000);
  it('createRoutes exposes the platform surface through /openapi.json', async () => {
    const { createTestDb } = await import('./helpers/test-db.js');
    const { createRoutes } = await import('../routes/index');
    const { AuthService } = await import('../services/auth-service');
    const { createAuthMiddleware } = await import('../middleware/auth');
    const db = createTestDb();
    // test-db carries the legal/ecli-shaped governance_feedback; the feedback
    // service wants its own shape (latent prod name collision, tracked separately)
    db.exec('DROP TABLE IF EXISTS governance_feedback');
    const authService = new AuthService(db);
    const auth = createAuthMiddleware(authService);

    const router = createRoutes(db, undefined, authService, auth);

    // find the openapi route layer and invoke its handler directly
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/openapi.json');
    expect(layer).toBeDefined();
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    let payload: any = null;
    handler({} as any, { json: (body: unknown) => { payload = body; } } as any);

    const paths = Object.keys(payload.paths);
    expect(paths.length).toBeGreaterThan(100);
    // spot-check well-known endpoints across mounts
    expect(paths).toContain('/api/tasks/{id}');
    expect(paths).toContain('/api/openmythos/score/{agentId}');
    expect(paths).toContain('/api/apex/llm/route');
    expect(paths).toContain('/api/version');
    expect(paths).toContain('/api/openapi.json');
    expect(paths).toContain('/api/workstation/urls');
    expect(paths).toContain('/api/swarms/scheduler/tick');
    expect(payload.paths['/api/tasks/{id}'].get.security).toEqual([{ bearerAuth: [] }]);

    db.close();
  });
});
