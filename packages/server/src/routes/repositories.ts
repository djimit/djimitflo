import { Router, Request, Response, NextFunction } from 'express';
import type { Database } from 'better-sqlite3';
import { RepositoryScanner } from '../services/repository-scanner';
import { AgentsMdValidator } from '../services/agents-md-validator';
import { DiffCaptureService } from '../services/diff-capture';
import { createError } from '../middleware/error-handler';
import { AuditEventType, AuthTokenPayload, RiskLevel } from '@djimitflo/shared';
import { AuthorizationService } from '../services/authorization-service';
import { AuditService } from '../services/audit-service';
import type { AuthMiddleware } from '../middleware/auth';

function sanitizeRepository(repo: any, isAdmin: boolean): any {
  if (isAdmin) return repo;
  return {
    ...repo,
    path: null,
    metadata: null,
  };
}

export function createRepositoryRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const scanner = new RepositoryScanner(db);
  const agentsMdValidator = new AgentsMdValidator();
  const requireAuth = auth?.requireAuth ?? ((_req: any, _res: any, next: any) => next());
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  function getUser(req: Request): AuthTokenPayload {
    return (req as any).user;
  }

  router.get('/', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getUser(req);
      const isAdmin = AuthorizationService.isAdmin(user);
      const repositories = scanner.getRepositories();
      res.json({ repositories: repositories.map((r: any) => sanitizeRepository(r, isAdmin)) });
    } catch (error) { next(error); }
  });

  router.get('/:id', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getUser(req);
      const isAdmin = AuthorizationService.isAdmin(user);
      const repository = scanner.getRepository(req.params.id);
      if (!repository) throw createError(404, 'Repository not found', 'REPOSITORY_NOT_FOUND');
      res.json({ repository: sanitizeRepository(repository, isAdmin) });
    } catch (error) { next(error); }
  });

  router.post('/scan', requirePermission('scan:repository'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const { path } = req.body;
      if (!path) throw createError(400, 'Path is required', 'INVALID_INPUT');
      const actorId = (req as any).user?.sub;

      const result = scanner.scan(path);

      if (actorId && result.repository?.id) {
        try {
          db.prepare('UPDATE repositories SET added_by = ? WHERE id = ?').run(actorId, result.repository.id);
        } catch {}
      }

      res.json(result);
    } catch (error) { next(error); }
  });

  router.post('/:id/rescan', requirePermission('scan:repository'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const repository = scanner.getRepository(req.params.id);
      if (!repository) throw createError(404, 'Repository not found', 'REPOSITORY_NOT_FOUND');
      const result = scanner.scan(repository.path);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post('/:id/deployment-provenance', requirePermission('approve:task'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const before = scanner.getRepository(req.params.id);
      const beforeDeployment = before?.metadata?.deployment_provenance;
      const repository = scanner.recordDeploymentProvenance(req.params.id, {
        commit: String(req.body?.commit || ''),
        source_archive_sha256: String(req.body?.source_archive_sha256 || ''),
        image_digest: String(req.body?.image_digest || ''),
        runtime_instance: String(req.body?.runtime_instance || ''),
        canonical_source_state: req.body?.canonical_source_state,
        verified_by: getUser(req)?.sub || '',
      });
      new AuditService(db).record({
        event_type: AuditEventType.CONFIG_CHANGED,
        user_id: getUser(req)?.sub,
        action: 'repository.deployment_provenance.recorded',
        resource_type: 'repository',
        resource_id: req.params.id,
        risk_level: RiskLevel.HIGH,
        before: beforeDeployment && typeof beforeDeployment === 'object' ? beforeDeployment as Record<string, unknown> : undefined,
        after: repository.metadata?.deployment_provenance as Record<string, unknown>,
      });
      res.status(201).json({ repository });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'DEPLOYMENT_PROVENANCE_INVALID';
      next(createError(code === 'REPOSITORY_NOT_FOUND' ? 404 : 409, code, code));
    }
  });

  // Detailed repository internals require scan:repository permission (operator/admin)
  router.get('/:id/health', requirePermission('scan:repository'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const repository = scanner.getRepository(req.params.id);
      if (!repository) throw createError(404, 'Repository not found', 'REPOSITORY_NOT_FOUND');
      const findings = scanner.getHealthFindings(req.params.id);
      res.json({ health_score: repository.health_score, findings });
    } catch (error) { next(error); }
  });

  router.get('/:id/agents-md', requirePermission('scan:repository'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const repository = scanner.getRepository(req.params.id);
      if (!repository) throw createError(404, 'Repository not found', 'REPOSITORY_NOT_FOUND');
      const files = scanner.getAgentsMdFiles(req.params.id);
      const allIssues: any[] = [];
      for (const file of files) {
        const issues = agentsMdValidator.validateFile(file);
        allIssues.push(...issues);
      }
      res.json({ files, issues: allIssues });
    } catch (error) { next(error); }
  });

  router.get('/:id/agents-md/effective', requirePermission('scan:repository'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const repository = scanner.getRepository(req.params.id);
      if (!repository) throw createError(404, 'Repository not found', 'REPOSITORY_NOT_FOUND');
      const files = scanner.getAgentsMdFiles(req.params.id);
      const targetPath = (req.query.path as string) || '/';
      const stack = agentsMdValidator.getEffectiveStack(repository.id, files, targetPath);
      res.json(stack);
    } catch (error) { next(error); }
  });

  router.post('/:id/agents-md/validate', requirePermission('scan:repository'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const repository = scanner.getRepository(req.params.id);
      if (!repository) throw createError(404, 'Repository not found', 'REPOSITORY_NOT_FOUND');
      const files = scanner.getAgentsMdFiles(req.params.id);
      const allIssues: any[] = [];
      for (const file of files) {
        const issues = agentsMdValidator.validateFile(file);
        allIssues.push(...issues);
      }
      res.json({ issues: allIssues, total: allIssues.length, critical: allIssues.filter((i: any) => i.severity === 'critical').length, errors: allIssues.filter((i: any) => i.severity === 'error').length, warnings: allIssues.filter((i: any) => i.severity === 'warning').length });
    } catch (error) { next(error); }
  });

  // Repository-level file changes: admin-only (may expose cross-user data)
  router.get('/:id/file-changes', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getUser(req);
      if (!AuthorizationService.isAdmin(user)) {
        res.status(403).json({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } });
        return;
      }
      const rows = db.prepare('SELECT * FROM file_changes WHERE repository_id = ? ORDER BY detected_at DESC').all(req.params.id) as any[];
      res.json({ file_changes: rows });
    } catch (error) { next(error); }
  });

  return router;
}

export function createDiffRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const diffCapture = new DiffCaptureService(db);
  const requireAuth = auth?.requireAuth ?? ((_req: any, _res: any, next: any) => next());

  function getUser(req: Request): AuthTokenPayload {
    return (req as any).user;
  }

  function checkTaskAccess(req: Request, res: Response, taskId: string): boolean {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) {
      res.status(404).json({ error: { message: 'Task not found', code: 'TASK_NOT_FOUND' } });
      return false;
    }
    const user = getUser(req);
    if (!AuthorizationService.canReadTask(user, task)) {
      res.status(404).json({ error: { message: 'Task not found', code: 'TASK_NOT_FOUND' } });
      return false;
    }
    return true;
  }

  router.get('/tasks/:taskId/diff', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!checkTaskAccess(req, res, req.params.taskId)) return;
      const result = diffCapture.getTaskDiff(req.params.taskId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.get('/tasks/:taskId/file-changes', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!checkTaskAccess(req, res, req.params.taskId)) return;
      const files = diffCapture.getTaskDiff(req.params.taskId);
      res.json({ files: files.files });
    } catch (error) { next(error); }
  });

  router.get('/tasks/:taskId/snapshots', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!checkTaskAccess(req, res, req.params.taskId)) return;
      const snapshots = diffCapture.getTaskSnapshots(req.params.taskId);
      res.json({ snapshots });
    } catch (error) { next(error); }
  });

  return router;
}
