/**
 * Skills routes — dynamic skill loading and agent assignment.
 */

import { rateLimit } from 'express-rate-limit';
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { SkillLoaderService } from '../services/skill-loader-service';
import { ExecutableSkills, skillFirstMode, skillParent } from '../services/executable-skills';
import { AuthorizationService, type OwnableResource } from '../services/authorization-service';
import { SkillFactoryService, skillFactoryPrepareInput, skillFactoryAdvanceInput } from '../services/skill-factory-service';
import { LoopService } from '../services/loop-service';

const skillName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const taskId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const discoveryInput = z.object({ capability: skillName }).strict();
const requestInput = z.object({ capability: skillName, objective: z.string().trim().min(1).max(4000), source_run_id: taskId.optional(), parent: skillParent.optional() }).strict();
const captureInput = z.object({ task_id: taskId }).strict();

function skillError(res: Response, error: unknown): void {
  // Only fixed service codes cross the HTTP boundary; filesystem and parser messages can contain operator paths.
  const message = error instanceof Error ? error.message : '';
  const code = /^SKILL_[A-Z_]{1,70}$/.test(message) ? message : 'SKILL_OPERATION_FAILED';
  const status = code === 'SKILL_OPERATION_FAILED' ? 500 : code === 'SKILL_FACTORY_OWNER_REQUIRED' ? 403 : code === 'SKILL_FACTORY_GOAL_NOT_FOUND' ? 404 : 409;
  res.status(status).json({ error: { code, message: code === 'SKILL_OPERATION_FAILED' ? 'Skill operation failed' : 'Skill prerequisites are not satisfied' } });
}

export function createSkillRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  router.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false })); // per-router limiter CodeQL can see; /api also caps 300/min
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  let loader: SkillLoaderService | undefined;
  const getLoader = () => loader ??= new SkillLoaderService(db);

  const executable = new ExecutableSkills(db);
  const authenticated: RequestHandler = auth?.requireAuth ?? ((_req, res) => {
    res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });
  });
  const enabled = (write: boolean): RequestHandler => (_req, res, next) => {
    const mode = skillFirstMode();
    if (mode === 'off' || (write && mode !== 'on')) {
      res.status(503).json({ error: { code: 'SKILL_FIRST_DISABLED', message: write ? 'Executable skill writes are disabled' : 'Executable skills are disabled' } });
      return;
    }
    next();
  };
  const invalid = (res: Response) => res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid executable skill request' } });

  router.get('/executable/discover', authenticated, requirePermission('read:evidence'), enabled(false), (req, res) => {
    const parsed = discoveryInput.safeParse(req.query);
    if (!parsed.success) { invalid(res); return; }
    try { res.json({ mode: skillFirstMode(), matches: executable.discover(parsed.data.capability) }); }
    catch (error) { skillError(res, error); }
  });

  router.post('/executable/request', authenticated, requirePermission('create:task'), enabled(true), (req, res) => {
    const parsed = requestInput.safeParse(req.body);
    if (!parsed.success) { invalid(res); return; }
    try {
      const result = executable.request(parsed.data.capability, parsed.data.objective, req.user!.sub, parsed.data.source_run_id, parsed.data.parent);
      res.status(result.status === 'implementation_required' ? 202 : 200).json(result);
    } catch (error) { skillError(res, error); }
  });

  let factory: SkillFactoryService | undefined;
  const getFactory = () => factory ??= new SkillFactoryService(db, new LoopService(db));
  router.post('/executable/factory/:goalId/prepare', authenticated, requirePermission('create:task'), requirePermission('execute:task'), enabled(true), (req, res) => {
    const parsed = skillFactoryPrepareInput.safeParse(req.body);
    const goal = taskId.safeParse(req.params.goalId);
    if (!parsed.success || !goal.success) { invalid(res); return; }
    try { res.status(202).json(getFactory().prepare(goal.data, req.user!.sub, parsed.data)); }
    catch (error) { skillError(res, error); }
  });
  router.post('/executable/factory/:goalId/advance', authenticated, requirePermission('create:task'), requirePermission('execute:task'), enabled(true), async (req, res) => {
    const parsed = skillFactoryAdvanceInput.safeParse(req.body);
    const goal = taskId.safeParse(req.params.goalId);
    if (!parsed.success || !goal.success) { invalid(res); return; }
    try { res.json(await getFactory().advance(goal.data, req.user!.sub, parsed.data)); }
    catch (error) { skillError(res, error); }
  });

  router.post('/:id/capture', authenticated, requirePermission('write:skills'), enabled(true), (req, res) => {
    const parsed = captureInput.safeParse(req.body);
    const id = skillName.safeParse(req.params.id);
    if (!parsed.success || !id.success) { invalid(res); return; }
    try {
      const task = db.prepare('SELECT owner_user_id, created_by FROM tasks WHERE id = ?').get(parsed.data.task_id) as OwnableResource | undefined;
      if (!task) { res.status(404).json({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } }); return; }
      if (!AuthorizationService.canReadTask(req.user!, task) || !AuthorizationService.canModifyTask(req.user!, task)) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Task access denied' } }); return;
      }
      res.status(201).json(executable.capture(id.data, parsed.data.task_id, req.user!.sub));
    } catch (error) { skillError(res, error); }
  });

  // GET /api/skills — list all skills
  router.get('/', requirePermission('read:evidence'), (_req, res) => {
    res.json({ skills: getLoader().listSkills() });
  });

  // GET /api/skills/stats — skill statistics
  router.get('/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(getLoader().getStats());
  });

  // GET /api/skills/:id — get skill details
  router.get('/:id', requirePermission('read:evidence'), (req, res) => {
    const skill = getLoader().getSkill(req.params.id);
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
    if (!getLoader().getSkill(req.params.id)) {
      res.status(404).json({ error: { code: 'SKILL_NOT_ADMITTED', message: 'Skill is not admitted from the operator-configured skill directory' } });
      return;
    }
    if (!db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.agentId)) {
      res.status(404).json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } });
      return;
    }
    const assignment = getLoader().assignSkillToAgent(req.params.agentId, req.params.id);
    res.status(201).json(assignment);
  });

  // DELETE /api/skills/:id/assign/:agentId — remove skill from agent
  router.delete('/:id/assign/:agentId', requirePermission('write:skills'), requirePermission('write:agents'), (req, res) => {
    if (!getLoader().getSkill(req.params.id)) {
      res.status(404).json({ error: { code: 'SKILL_NOT_ADMITTED', message: 'Skill is not admitted from the operator-configured skill directory' } });
      return;
    }
    if (!db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.agentId)) {
      res.status(404).json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } });
      return;
    }
    getLoader().removeSkillFromAgent(req.params.agentId, req.params.id);
    res.json({ removed: true });
  });

  // GET /api/skills/agent/:agentId — get agent's skills
  router.get('/agent/:agentId', requirePermission('read:evidence'), (req, res) => {
    res.json({ skills: getLoader().getAgentSkills(req.params.agentId) });
  });

  // GET /api/skills/trigger/:trigger — find skills by trigger
  router.get('/trigger/:trigger', requirePermission('read:evidence'), (req, res) => {
    res.json({ skills: getLoader().findSkillsByTrigger(req.params.trigger) });
  });

  // POST /api/skills/reload — reload all skills from disk
  router.post('/reload', requirePermission('manage:config'), (_req, res) => {
    res.status(503).json({ error: { code: 'SKILL_RELOAD_UNAVAILABLE', message: 'Reloading this router does not refresh execution-engine skill admission; shared runtime reload is not configured.' } });
  });

  return router;
}
