import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from './helpers/test-db';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createSkillRoutes } from '../routes/skills';
import { SkillLoaderService } from '../services/skill-loader-service';
import { SkillFactoryService } from '../services/skill-factory-service';
import { ExecutableSkills } from '../services/executable-skills';

let db: ReturnType<typeof createTestDb>;
let app: express.Express;
let tokens: Record<string, string>;
beforeEach(() => {
  vi.stubEnv('SKILL_FIRST_MODE', 'on');
  vi.stubEnv('DJIMITFLO_SKILLS_DIR', '');
  db = createTestDb();
  db.exec("ALTER TABLE tasks ADD COLUMN owner_user_id TEXT; ALTER TABLE tasks ADD COLUMN created_by TEXT;");
  const service = new AuthService(db);
  tokens = {};
  for (const [id, role] of [['owner', 'maker'], ['other', 'maker'], ['viewer', 'viewer'], ['admin', 'admin']]) {
    db.prepare('INSERT INTO users(id,email,password_hash,role) VALUES(?,?,?,?)').run(id, `${id}@example.test`, 'unused', role);
    tokens[id] = service.generateToken(service.findUserById(id)!);
  }
  db.prepare("INSERT INTO tasks(id,title,description,status,priority,risk_level,execution_mode,owner_user_id,created_by) VALUES('task-1','fixture','fixture','completed','low','low','local','owner','owner')").run();
  app = express(); app.use(express.json()); app.use('/skills', createSkillRoutes(db, createAuthMiddleware(service)));
});
afterEach(() => { db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const bearer = (id = 'owner') => `Bearer ${tokens[id]}`;

describe('executable skill API trust boundary', () => {
  it('fails closed without router auth configuration or authentication', async () => {
    const unconfigured = express(); unconfigured.use(express.json()); unconfigured.use('/skills', createSkillRoutes(db));
    for (const target of [app, unconfigured]) {
      expect((await request(target).get('/skills/executable/discover?capability=fixture')).status).toBe(401);
      expect((await request(target).post('/skills/executable/request').send({ capability: 'fixture', objective: 'Make fixture' })).status).toBe(401);
      expect((await request(target).post('/skills/fixture/capture').send({ task_id: 'task-1' })).status).toBe(401);
    }
  });

  it('is disabled by default and exposes discovery only in shadow', async () => {
    vi.stubEnv('SKILL_FIRST_MODE', '');
    expect((await request(app).get('/skills/executable/discover?capability=fixture').set('Authorization', bearer())).status).toBe(503);
    vi.stubEnv('SKILL_FIRST_MODE', 'shadow');
    const discover = vi.spyOn(ExecutableSkills.prototype, 'discover').mockReturnValue([]);
    expect((await request(app).get('/skills/executable/discover?capability=fixture').set('Authorization', bearer())).body).toMatchObject({ mode: 'shadow', matches: [] });
    expect(discover).toHaveBeenCalledOnce();
    expect((await request(app).post('/skills/executable/request').set('Authorization', bearer()).send({ capability: 'fixture', objective: 'Make fixture' })).status).toBe(503);
    expect((await request(app).post('/skills/fixture/capture').set('Authorization', bearer()).send({ task_id: 'task-1' })).status).toBe(503);
    expect(db.prepare('SELECT COUNT(*) n FROM goals').get()).toEqual({ n: 0 });
  });

  it('metadata discovery does not load executable files or skill instructions', async () => {
    const read = vi.spyOn(SkillLoaderService.prototype, 'loadSkills');
    const metadataApp = express();
    const service = new AuthService(db);
    metadataApp.use('/skills', createSkillRoutes(db, createAuthMiddleware(service)));
    const token = service.generateToken(service.findUserById('owner')!);
    const response = await request(metadataApp).get('/skills/executable/discover?capability=fixture').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.matches).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('requires create permission and creates one real owned goal across repeated requests', async () => {
    vi.spyOn(ExecutableSkills.prototype, 'discover').mockReturnValue([]);
    const body = { capability: 'fixture', objective: 'Build fixture with verification' };
    expect((await request(app).post('/skills/executable/request').set('Authorization', bearer('viewer')).send(body)).status).toBe(403);
    const first = await request(app).post('/skills/executable/request').set('Authorization', bearer()).send(body);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ status: 'implementation_required' });
    const second = await request(app).post('/skills/executable/request').set('Authorization', bearer()).send(body);
    expect(second.body.goal_id).toBe(first.body.goal_id);
    expect(db.prepare('SELECT owner_user_id FROM goals WHERE id=?').get(first.body.goal_id)).toEqual({ owner_user_id: 'owner' });
  });

  it.each([
    { capability: '../escape', objective: 'x' },
    { capability: 'fixture', objective: ' ' },
    { capability: 'fixture', objective: 'x', owner: 'other' },
    { capability: ['fixture'], objective: 'x' },
  ])('rejects malformed requests without dispatch: %j', async body => {
    const dispatch = vi.spyOn(ExecutableSkills.prototype, 'request');
    const result = await request(app).post('/skills/executable/request').set('Authorization', bearer()).send(body);
    expect(result.status).toBe(400); expect(dispatch).not.toHaveBeenCalled();
  });

  it('validates discovery query and capture input strictly', async () => {
    const discover = vi.spyOn(ExecutableSkills.prototype, 'discover');
    for (const query of ['', '?capability=fixture&extra=1', '?capability=a&capability=b']) {
      expect((await request(app).get(`/skills/executable/discover${query}`).set('Authorization', bearer())).status).toBe(400);
    }
    expect(discover).not.toHaveBeenCalled();
    expect((await request(app).post('/skills/fixture/capture').set('Authorization', bearer()).send({ task_id: 'task-1', actor: 'admin' })).status).toBe(400);
  });

  it('checks task ownership before capture and takes actor from current principal', async () => {
    const capture = vi.spyOn(ExecutableSkills.prototype, 'capture').mockReturnValue({ id: 'skill:fixture@1.0.0', status: 'candidate' } as ReturnType<ExecutableSkills['capture']>);
    expect((await request(app).post('/skills/fixture/capture').set('Authorization', bearer('other')).send({ task_id: 'task-1' })).status).toBe(403);
    expect((await request(app).post('/skills/fixture/capture').set('Authorization', bearer('viewer')).send({ task_id: 'task-1' })).status).toBe(403);
    expect(capture).not.toHaveBeenCalled();
    const response = await request(app).post('/skills/fixture/capture').set('Authorization', bearer()).send({ task_id: 'task-1' });
    expect(response.status).toBe(201); expect(response.body.status).toBe('candidate');
    expect(capture).toHaveBeenCalledWith('fixture', 'task-1', 'owner');
  });

  it('does not expose filesystem errors or bypass actual verification', async () => {
    const missing = await request(app).post('/skills/fixture/capture').set('Authorization', bearer()).send({ task_id: 'missing' });
    expect(missing.status).toBe(404);
    const unverified = await request(app).post('/skills/fixture/capture').set('Authorization', bearer()).send({ task_id: 'task-1' });
    expect(unverified.status).toBe(409);
    vi.spyOn(ExecutableSkills.prototype, 'capture').mockImplementation(() => { throw new Error("ENOENT /private/operator/secret-skill/SKILL.md"); });
    const broken = await request(app).post('/skills/fixture/capture').set('Authorization', bearer()).send({ task_id: 'task-1' });
    expect(broken.status).toBe(500); expect(JSON.stringify(broken.body)).not.toContain('/private');
  });
});


describe('skill factory routes', () => {
  const prefix = '/skills/executable/factory/goal-1';
  const input = { repository_path: '/fixture/repository', runtime: 'codex' };
  it('rejects unauthenticated, unprivileged, disabled and malformed dispatch before service calls', async () => {
    const prepare = vi.spyOn(SkillFactoryService.prototype, 'prepare');
    const advance = vi.spyOn(SkillFactoryService.prototype, 'advance');
    for (const suffix of ['prepare', 'advance']) {
      const body = suffix === 'prepare' ? input : {};
      expect((await request(app).post(`${prefix}/${suffix}`).send(body)).status).toBe(401);
      expect((await request(app).post(`${prefix}/${suffix}`).set('Authorization', bearer('viewer')).send(body)).status).toBe(403);
      vi.stubEnv('SKILL_FIRST_MODE', 'shadow');
      expect((await request(app).post(`${prefix}/${suffix}`).set('Authorization', bearer()).send(body)).status).toBe(503);
      vi.stubEnv('SKILL_FIRST_MODE', 'on');
      expect((await request(app).post(`${prefix}/${suffix}`).set('Authorization', bearer()).send({ ...body, skip_permissions: true })).status).toBe(400);
    }
    expect(prepare).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled();
  });

  it('uses real factory ownership checks before preparing a foreign goal', async () => {
    db.prepare("INSERT INTO goals(id,objective,owner_user_id,metadata) VALUES('goal-1','fixture','other',?)").run(JSON.stringify({ skill_factory_key: 'fixture', skill_factory_capability: 'fixture' }));
    const result = await request(app).post(`${prefix}/prepare`).set('Authorization', bearer()).send(input);
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('SKILL_FACTORY_OWNER_REQUIRED');
    expect(db.prepare('SELECT COUNT(*) n FROM loop_runs').get()).toEqual({ n: 0 });
  });

  it('passes validated arguments/current actor and awaits asynchronous completion', async () => {
    const state = { run_id: 'run-1', run_status: 'running', leases: [], next_action: 'Continue' };
    const prepare = vi.spyOn(SkillFactoryService.prototype, 'prepare').mockReturnValue(state);
    const advance = vi.spyOn(SkillFactoryService.prototype, 'advance').mockResolvedValue({ ...state, status: 'awaiting_approval' });
    const result = await request(app).post(`${prefix}/prepare`).set('Authorization', bearer()).send(input);
    expect(result.status).toBe(202); expect(result.body.run_id).toBe('run-1');
    expect(prepare).toHaveBeenCalledWith('goal-1', 'owner', input);
    const step = await request(app).post(`${prefix}/advance`).set('Authorization', bearer()).send({ timeout_ms: 1000 });
    expect(step.status).toBe(200); expect(step.body.status).toBe('awaiting_approval');
    expect(advance).toHaveBeenCalledWith('goal-1', 'owner', { timeout_ms: 1000 });
    advance.mockRejectedValue(new Error('spawn /private/operator/runtime permission denied'));
    const failure = await request(app).post(`${prefix}/advance`).set('Authorization', bearer()).send({});
    expect(failure.status).toBe(500); expect(failure.text).not.toContain('/private');
  });
});
