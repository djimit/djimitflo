/**
 * Skills routes — dynamic skill loading and agent assignment.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SkillLoaderService } from '../services/skill-loader-service';

export function createSkillRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const loader = new SkillLoaderService(db);

  // GET /api/skills — list all skills
  router.get('/', requirePermission('read:evidence'), (_req, res) => {
    res.json({ skills: loader.listSkills() });
  });

  // GET /api/skills/stats — skill statistics
  router.get('/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(loader.getStats());
  });

  // GET /api/skills/:id — get skill details
  router.get('/:id', requirePermission('read:evidence'), (req, res) => {
    const skill = loader.getSkill(req.params.id);
    if (!skill) {
      res.status(404).json({ error: { message: 'Skill not found', code: 'NOT_FOUND' } });
      return;
    }
    res.json(skill);
  });

  // POST /api/skills/:id/enable — enable a skill
  router.post('/:id/enable', requirePermission('write:config'), (req, res) => {
    loader.setSkillEnabled(req.params.id, true);
    res.json({ enabled: true });
  });

  // POST /api/skills/:id/disable — disable a skill
  router.post('/:id/disable', requirePermission('write:config'), (req, res) => {
    loader.setSkillEnabled(req.params.id, false);
    res.json({ disabled: true });
  });

  // POST /api/skills/:id/assign/:agentId — assign skill to agent
  router.post('/:id/assign/:agentId', requirePermission('write:config'), (req, res) => {
    const assignment = loader.assignSkillToAgent(req.params.agentId, req.params.id);
    res.status(201).json(assignment);
  });

  // DELETE /api/skills/:id/assign/:agentId — remove skill from agent
  router.delete('/:id/assign/:agentId', requirePermission('write:config'), (req, res) => {
    loader.removeSkillFromAgent(req.params.agentId, req.params.id);
    res.json({ removed: true });
  });

  // GET /api/skills/agent/:agentId — get agent's skills
  router.get('/agent/:agentId', requirePermission('read:evidence'), (req, res) => {
    res.json({ skills: loader.getAgentSkills(req.params.agentId) });
  });

  // GET /api/skills/trigger/:trigger — find skills by trigger
  router.get('/trigger/:trigger', requirePermission('read:evidence'), (req, res) => {
    res.json({ skills: loader.findSkillsByTrigger(req.params.trigger) });
  });

  // POST /api/skills/reload — reload all skills from disk
  router.post('/reload', requirePermission('write:config'), (_req, res) => {
    const loaded = loader.loadSkills();
    res.json({ reloaded: loaded.length });
  });

  return router;
}
