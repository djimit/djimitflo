import { describe, expect, it } from 'vitest';
import { Router } from 'express';
import { buildOpenApiSpec, collectRoutes, type RouteMount } from '../utils/route-inventory';

function makeMounts(): RouteMount[] {
  const tasks = Router();
  tasks.get('/', (_req, res) => { res.end(); });
  tasks.post('/', (_req, res) => { res.end(); });
  tasks.get('/:id', (_req, res) => { res.end(); });
  const auth = Router();
  auth.post('/login', (_req, res) => { res.end(); });
  const noop = ((_req: unknown, _res: unknown, next: () => void) => next()) as never;
  return [
    { prefix: '/tasks', middleware: [noop], router: tasks },
    { prefix: '/auth', middleware: [], router: auth },
  ];
}

describe('collectRoutes', () => {
  it('flattens mounted routers into method+path entries with auth flags', () => {
    const entries = collectRoutes(makeMounts());

    expect(entries).toEqual([
      { method: 'POST', path: '/api/auth/login', authenticated: false },
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
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  });
});

describe('full aggregator inventory', () => {
  it('createRoutes exposes the platform surface through /openapi.json', async () => {
    const { createTestDb } = await import('./helpers/test-db');
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
    expect(payload.paths['/api/tasks/{id}'].get.security).toEqual([{ bearerAuth: [] }]);

    db.close();
  });
});
