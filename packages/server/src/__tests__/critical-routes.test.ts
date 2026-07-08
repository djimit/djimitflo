import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { AuditService } from '../services/audit-service';
import { limitBodySize } from '../middleware/input-validation';

/**
 * Critical Route Factory Tests
 *
 * Strategy: Verify all route factory modules are importable (catches missing
 * modules, broken imports, circular dependencies) and that the most critical
 * routes mount with a real auth middleware.
 */

// Import all route factories — if any import fails, this test file fails
import { createDiscussionRoutes } from '../routes/discussions';
import { createTaskRoutes } from '../routes/tasks';
import { createLoopRoutes } from '../routes/loops';
import { createGoalRoutes } from '../routes/goals';
import { createAgentRoutes } from '../routes/agents';
import { createCatalogRoutes } from '../routes/catalog';
import { createApprovalRoutes } from '../routes/approvals';
import { createBackupRoutes } from '../routes/backup';
import { createExportRoutes } from '../routes/exports';
import { createMessageRoutes } from '../routes/messages';
import { createAuditRoutes } from '../routes/audit';
import { createUsageRoutes } from '../routes/usage';
import { createRepositoryRoutes, createDiffRoutes } from '../routes/repositories';
import { createAuthRoutes } from '../routes/auth';
import { createMetaOrchestrationRoutes } from '../routes/meta-orchestration';
import { createMemoryRoutes } from '../routes/memory';
import { createSkillRoutes } from '../routes/skills';
import { createLearningRoutes } from '../routes/learning';
import { createSpawnRoutes } from '../routes/spawns';
import { createSwarmRoutes } from '../routes/swarms';

describe('Critical Route Factories', () => {
  let db: ReturnType<typeof createTestDb>;
  let authService: AuthService;
  let auth: ReturnType<typeof createAuthMiddleware>;
  let auditService: AuditService;

  beforeEach(() => {
    db = createTestDb();
    authService = new AuthService(db);
    authService.bootstrapAdmin();
    auth = createAuthMiddleware(authService);
    auditService = new AuditService(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('All route factories are importable', () => {
    const factories = [
      createDiscussionRoutes,
      createTaskRoutes,
      createLoopRoutes,
      createGoalRoutes,
      createAgentRoutes,
      createCatalogRoutes,
      createApprovalRoutes,
      createBackupRoutes,
      createExportRoutes,
      createMessageRoutes,
      createAuditRoutes,
      createUsageRoutes,
      createRepositoryRoutes,
      createDiffRoutes,
      createAuthRoutes,
      createMetaOrchestrationRoutes,
      createMemoryRoutes,
      createSkillRoutes,
      createLearningRoutes,
      createSpawnRoutes,
      createSwarmRoutes,
    ];

    it('has 21 route factories', () => {
      expect(factories.length).toBe(21);
    });

    it('all factories are functions', () => {
      for (const factory of factories) {
        expect(typeof factory).toBe('function');
      }
    });
  });

  describe('Routes mount with real auth middleware', () => {
    it('createTaskRoutes mounts', () => {
      const router = createTaskRoutes(db, auth);
      expect(router).toBeDefined();
      expect(typeof router).toBe('function');
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createLoopRoutes mounts', () => {
      const router = createLoopRoutes(db, auth);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createGoalRoutes mounts', () => {
      const router = createGoalRoutes(db, auth);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createDiscussionRoutes mounts', () => {
      const router = createDiscussionRoutes(db, auth);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createAgentRoutes mounts', () => {
      const router = createAgentRoutes(db, auth);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createCatalogRoutes mounts', () => {
      const router = createCatalogRoutes(db, auth);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createApprovalRoutes mounts', () => {
      const router = createApprovalRoutes(db, auth);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createBackupRoutes mounts', () => {
      const router = createBackupRoutes(db, auth);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createExportRoutes mounts', () => {
      const router = createExportRoutes(db, auth);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createMessageRoutes mounts', () => {
      const router = createMessageRoutes(db, auth);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createAuditRoutes mounts', () => {
      const router = createAuditRoutes(db, auditService, auth);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createUsageRoutes mounts', () => {
      const router = createUsageRoutes(db, auth);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createRepositoryRoutes mounts', () => {
      const router = createRepositoryRoutes(db, auth);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createDiffRoutes mounts', () => {
      const router = createDiffRoutes(db, auth);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createAuthRoutes mounts', () => {
      const router = createAuthRoutes(authService, auth, auditService);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createMetaOrchestrationRoutes mounts', () => {
      const router = createMetaOrchestrationRoutes(db, auth);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createMemoryRoutes mounts', () => {
      const router = createMemoryRoutes(db, auth);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createSkillRoutes mounts', () => {
      const router = createSkillRoutes(db, auth);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createLearningRoutes mounts', () => {
      const router = createLearningRoutes(db, auth);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createSpawnRoutes mounts', () => {
      const router = createSpawnRoutes(db, auth, undefined);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });

    it('createSwarmRoutes mounts', () => {
      const router = createSwarmRoutes(db, auth, undefined);
      expect(router).toBeDefined();
      expect(router.stack.length).toBeGreaterThan(0);
    });
  });

  describe('Middleware chain', () => {
    it('limitBodySize allows requests under limit', () => {
      const middleware = limitBodySize(1000);
      const req = { headers: { 'content-length': '500' } } as any;
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
      const next = vi.fn();
      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('limitBodySize blocks oversized requests', () => {
      const middleware = limitBodySize(1000);
      const req = { headers: { 'content-length': '2000' } } as any;
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
      const next = vi.fn();
      middleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(413);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
