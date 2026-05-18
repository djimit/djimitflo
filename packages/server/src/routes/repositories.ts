import { Router, Request, Response, NextFunction } from 'express';
import type { Database } from 'better-sqlite3';
import { RepositoryScanner } from '../services/repository-scanner';
import { AgentsMdValidator } from '../services/agents-md-validator';
import { DiffCaptureService } from '../services/diff-capture';
import { createError } from '../middleware/error-handler';

export function createRepositoryRoutes(db: Database): Router {
  const router = Router();
  const scanner = new RepositoryScanner(db);
  const agentsMdValidator = new AgentsMdValidator();

  router.get('/', (_req: Request, res: Response, next: NextFunction) => {
    try {
      const repositories = scanner.getRepositories();
      res.json({ repositories });
    } catch (error) { next(error); }
  });

  router.get('/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const repository = scanner.getRepository(req.params.id);
      if (!repository) throw createError(404, 'Repository not found', 'REPOSITORY_NOT_FOUND');
      res.json({ repository });
    } catch (error) { next(error); }
  });

  router.post('/scan', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { path } = req.body;
      if (!path) throw createError(400, 'Path is required', 'INVALID_INPUT');
      const result = scanner.scan(path);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.post('/:id/rescan', (req: Request, res: Response, next: NextFunction) => {
    try {
      const repository = scanner.getRepository(req.params.id);
      if (!repository) throw createError(404, 'Repository not found', 'REPOSITORY_NOT_FOUND');
      const result = scanner.scan(repository.path);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.get('/:id/health', (req: Request, res: Response, next: NextFunction) => {
    try {
      const repository = scanner.getRepository(req.params.id);
      if (!repository) throw createError(404, 'Repository not found', 'REPOSITORY_NOT_FOUND');
      const findings = scanner.getHealthFindings(req.params.id);
      res.json({ health_score: repository.health_score, findings });
    } catch (error) { next(error); }
  });

  router.get('/:id/agents-md', (req: Request, res: Response, next: NextFunction) => {
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

  router.get('/:id/agents-md/effective', (req: Request, res: Response, next: NextFunction) => {
    try {
      const repository = scanner.getRepository(req.params.id);
      if (!repository) throw createError(404, 'Repository not found', 'REPOSITORY_NOT_FOUND');
      const files = scanner.getAgentsMdFiles(req.params.id);
      const targetPath = (req.query.path as string) || '/';
      const stack = agentsMdValidator.getEffectiveStack(repository.id, files, targetPath);
      res.json(stack);
    } catch (error) { next(error); }
  });

  router.post('/:id/agents-md/validate', (req: Request, res: Response, next: NextFunction) => {
    try {
      const repository = scanner.getRepository(req.params.id);
      if (!repository) throw createError(404, 'Repository not found', 'REPOSITORY_NOT_FOUND');
      const files = scanner.getAgentsMdFiles(req.params.id);
      const allIssues: any[] = [];
      for (const file of files) {
        const issues = agentsMdValidator.validateFile(file);
        allIssues.push(...issues);
      }
      res.json({ issues: allIssues, total: allIssues.length, critical: allIssues.filter(i => i.severity === 'critical').length, errors: allIssues.filter(i => i.severity === 'error').length, warnings: allIssues.filter(i => i.severity === 'warning').length });
    } catch (error) { next(error); }
  });

  router.get('/:id/file-changes', (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = db.prepare('SELECT * FROM file_changes WHERE repository_id = ? ORDER BY detected_at DESC').all(req.params.id) as any[];
      res.json({ file_changes: rows });
    } catch (error) { next(error); }
  });

  return router;
}

export function createDiffRoutes(db: Database): Router {
  const router = Router();
  const diffCapture = new DiffCaptureService(db);

  router.get('/tasks/:taskId/diff', (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = diffCapture.getTaskDiff(req.params.taskId);
      res.json(result);
    } catch (error) { next(error); }
  });

  router.get('/tasks/:taskId/file-changes', (req: Request, res: Response, next: NextFunction) => {
    try {
      const files = diffCapture.getTaskDiff(req.params.taskId);
      res.json({ files: files.files });
    } catch (error) { next(error); }
  });

  router.get('/tasks/:taskId/snapshots', (req: Request, res: Response, next: NextFunction) => {
    try {
      const snapshots = diffCapture.getTaskSnapshots(req.params.taskId);
      res.json({ snapshots });
    } catch (error) { next(error); }
  });

  return router;
}