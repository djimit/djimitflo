import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createRoutes } from '../routes';
import { runMigrations } from '../database/migrate';
import { schema } from '../database/schema';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';

/**
 * Integration test: verifies all route factories mount without import errors.
 * Catches: missing route modules, broken imports, middleware chain errors.
 */
describe('Server route wiring', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('createRoutes does not throw with full auth', () => {
    const authService = new AuthService(db);
    authService.bootstrapAdmin();
    const auth = createAuthMiddleware(authService);
    expect(() => createRoutes(db, undefined, authService, auth)).not.toThrow();
  });

  it('createRoutes fails closed without auth middleware', () => {
    expect(() => createRoutes(db, undefined)).toThrow('AUTH_MIDDLEWARE_REQUIRED');
  });

  it('createRoutes returns a valid Express router with mounted layers', () => {
    const authService = new AuthService(db);
    authService.bootstrapAdmin();
    const auth = createAuthMiddleware(authService);
    const router = createRoutes(db, undefined, authService, auth);

    expect(router).toBeDefined();
    expect(typeof router).toBe('function');

    // Express Router internals: stack contains Layer objects for each middleware/route
    const layers = router.stack || [];
    expect(layers.length).toBeGreaterThan(10); // Many route factories mounted
  });

  it('router contains expected route path patterns', () => {
    const authService = new AuthService(db);
    authService.bootstrapAdmin();
    const auth = createAuthMiddleware(authService);
    const router = createRoutes(db, undefined, authService, auth);

    // Collect all route paths from the router stack
    const paths = new Set<string>();
    for (const layer of router.stack) {
      if (layer.route) {
        paths.add(layer.route.path);
      } else if (layer.name === 'router' && layer.regexp?.source) {
        // Sub-router mounted at a path — extract from regexp
        const match = layer.regexp.source.match(/\/([a-z_-]+)/);
        if (match) paths.add('/' + match[1]);
      }
    }

    // Verify key endpoints are mounted
    expect(paths.has('/version')).toBe(true);
    // Verify sub-routers are mounted as middleware layers
    const routerLayers = router.stack.filter((l: any) => l.name === 'router');
    expect(routerLayers.length).toBeGreaterThan(10); // Many sub-routers mounted
    // Verify total layer count (routes + middleware + sub-routers)
    expect(router.stack.length).toBeGreaterThan(20);
  });
});
