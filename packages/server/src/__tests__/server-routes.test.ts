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
      } else if (layer.name === 'router') {
        // Sub-router mounted at a path — extract from regexp
        const match = layer.regexp.source.match(/\/([a-z_-]+)/);
        if (match) paths.add('/' + match[1]);
      }
    }

    // Verify key endpoints are mounted
    expect(paths.has('/version')).toBe(true);
    // Sub-routers are mounted as middleware, not routes — verify by regexp match
    const allPatterns = router.stack.map((l: any) => l.regexp?.source || l.route?.path || '').join(' ');
    expect(allPatterns).toContain('/tasks');
    expect(allPatterns).toContain('/agents');
    expect(allPatterns).toContain('/goals');
    expect(allPatterns).toContain('/loops');
    expect(allPatterns).toContain('/swarms');
    expect(allPatterns).toContain('/catalog');
    expect(allPatterns).toContain('/skills');
    expect(allPatterns).toContain('/learning');
    expect(allPatterns).toContain('/work-items');
    expect(allPatterns).toContain('/repositories');
    expect(allPatterns).toContain('/backups');
    expect(allPatterns).toContain('/exports');
    expect(allPatterns).toContain('/messages');
    expect(allPatterns).toContain('/memory');
    expect(allPatterns).toContain('/mcp');
    expect(allPatterns).toContain('/approvals');
    expect(allPatterns).toContain('/policies');
    expect(allPatterns).toContain('/risk');
    expect(allPatterns).toContain('/evidence');
    expect(allPatterns).toContain('/observability');
    expect(allPatterns).toContain('/knowledge');
    expect(allPatterns).toContain('/federation');
    expect(allPatterns).toContain('/intervention');
    expect(allPatterns).toContain('/audit');
    expect(allPatterns).toContain('/discussions');
    expect(allPatterns).toContain('/usage');
  });
});
