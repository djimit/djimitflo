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
  router.post('/:id/enable', requirePermission('manage:config'), (_req, res) => {
    res.status(503).json({ error: { code: 'SKILL_ACTIVATION_UNAVAILABLE', message: 'No shared runtime skill activation mechanism is configured; a router-local inventory flag is not activation.' } });
  });

  // POST /api/skills/:id/disable — disable a skill
  router.post('/:id/disable', requirePermission('manage:config'), (_req, res) => {
    res.status(503).json({ error: { code: 'SKILL_ACTIVATION_UNAVAILABLE', message: 'No shared runtime skill deactivation mechanism is configured; a router-local inventory flag does not stop execution.' } });
  });

  // POST /api/skills/:id/assign/:agentId — assign skill to agent
  router.post('/:id/assign/:agentId', requirePermission('write:skills'), requirePermission('write:agents'), (req, res) => {
    if (!loader.getSkill(req.params.id)) {
      res.status(404).json({ error: { code: 'SKILL_NOT_ADMITTED', message: 'Skill is not admitted from the operator-configured skill directory' } });
      return;
    }
    if (!db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.agentId)) {
      res.status(404).json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } });
      return;
    }
    const assignment = loader.assignSkillToAgent(req.params.agentId, req.params.id);
    res.status(201).json(assignment);
  });

  // DELETE /api/skills/:id/assign/:agentId — remove skill from agent
  router.delete('/:id/assign/:agentId', requirePermission('write:skills'), requirePermission('write:agents'), (req, res) => {
    if (!loader.getSkill(req.params.id)) {
      res.status(404).json({ error: { code: 'SKILL_NOT_ADMITTED', message: 'Skill is not admitted from the operator-configured skill directory' } });
      return;
    }
    if (!db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.agentId)) {
      res.status(404).json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } });
      return;
    }
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
  router.post('/reload', requirePermission('manage:config'), (_req, res) => {
    res.status(503).json({ error: { code: 'SKILL_RELOAD_UNAVAILABLE', message: 'Reloading this router does not refresh execution-engine skill admission; shared runtime reload is not configured.' } });
  });

  return router;
}
