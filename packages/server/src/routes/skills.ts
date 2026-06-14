/**
 * Skill routes — acquire, validate, push
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SkillService } from '../services/skill-service';

export function createSkillRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requireAuth = auth?.requireAuth ?? ((_req: any, _res: any, next: any) => next());
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const skillService = new SkillService(db);

  // POST /api/skills/acquire — trigger DeerFlow research → OKF Skill draft
  router.post('/acquire', requireAuth, requirePermission('write:evidence'), async (req, res): Promise<void> => {
    const { topic } = req.body ?? {};
    if (!topic || typeof topic !== 'string') {
      res.status(400).json({ error: { message: 'topic is required', code: 'INVALID_INPUT' } });
      return;
    }
    const machineId = (req as any).user?.sub || 'unknown';
    const result = await skillService.acquire(topic, machineId);
    res.status(201).json(result);
  });

  // POST /api/skills/validate — validate a draft skill
  router.post('/validate', requireAuth, requirePermission('write:evidence'), (req, res): void => {
    const { skill_path, sandbox } = req.body ?? {};
    if (!skill_path) {
      res.status(400).json({ error: { message: 'skill_path is required', code: 'INVALID_INPUT' } });
      return;
    }
    const result = skillService.validate(skill_path, sandbox || 'process');
    res.json(result);
  });

  // POST /api/skills/push — push validated skill to agent
  router.post('/push', requireAuth, requirePermission('write:evidence'), async (req, res): Promise<void> => {
    const { agent_id, skill_path, method } = req.body ?? {};
    if (!agent_id || !skill_path) {
      res.status(400).json({ error: { message: 'agent_id and skill_path are required', code: 'INVALID_INPUT' } });
      return;
    }
    const result = await skillService.push(agent_id, skill_path, method || 'ssh');
    res.json(result);
  });

  return router;
}