import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createAgentRoutes } from '../routes/agents';
import { createRetirementRoutes } from '../routes/retirement';
import { AgentRetirementService } from '../services/agent-retirement-service';
import { ExecutionEngine } from '../execution/execution-engine';
import { errorHandler } from '../middleware/error-handler';
import { RuntimeLeaseRegistry } from '../services/loop-recovery-service';

let db: Database.Database;
let app: express.Express;
let admin: string;
let checker: string;
let temp: string;
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'djimitflo-agent-boundary-')); vi.stubEnv('OKF_BASE', temp);
  db = new Database(':memory:'); db.pragma('foreign_keys=ON'); db.exec(schema); runMigrations(db);
  db.prepare('INSERT INTO users(id,email,password_hash,role) VALUES(?,?,?,?)').run('admin', 'admin@test', 'unused', 'admin');
  db.prepare('INSERT INTO users(id,email,password_hash,role) VALUES(?,?,?,?)').run('checker', 'checker@test', 'unused', 'checker');
  const service = new AuthService(db); const auth = createAuthMiddleware(service);
  admin = service.generateToken(service.findUserById('admin')!); checker = service.generateToken(service.findUserById('checker')!);
  app = express(); app.use(express.json()); app.use('/agents', createAgentRoutes(db, auth));
  app.use('/retirement', auth.requireAuth, createRetirementRoutes(db, auth)); app.use(errorHandler);
  app.use('/api/retirement', auth.requireAuth, createRetirementRoutes(db, auth));
  agent('a'); agent('b');
});
afterEach(() => { RuntimeLeaseRegistry.clear(); db.close(); vi.unstubAllEnvs(); rmSync(temp, { recursive: true, force: true }); });
function agent(id: string) { db.prepare('INSERT INTO agents(id,name,description,status,capabilities,metadata) VALUES(?,?,?,?,?,?)').run(id, id, 'Fixture', 'idle', '[]', '{"system_prompt":"protected"}'); }
function task(id: string, agentId: string, status = 'completed') {
  db.prepare('INSERT INTO tasks(id,title,description,status,priority,risk_level,execution_mode,agent_id,metadata) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, 'Fixture', 'echo hello', status, 'low', 'low', 'local', agentId, '{}');
}
function lease(id: string, agentId: string, status = 'prepared') {
  db.prepare("INSERT OR IGNORE INTO loop_runs(id,loop_name,mode,status) VALUES('fixture-run','doc-drift-and-small-fix-loop','closed','running')").run();
  task(`task-${id}`, agentId);
  db.prepare('INSERT INTO worker_leases(id,loop_run_id,role,runtime,status,metadata) VALUES(?,?,?,?,?,?)')
    .run(id, 'fixture-run', 'maker', 'manual', status, JSON.stringify({ execution_task_id: `task-${id}` }));
}

it('creates a governed NL agent draft, persists its inferred config, and requires approval', async () => {
  const invalid = await request(app).post('/agents/create-from-description').auth(admin, { type: 'bearer' }).send({ description: '  ' });
  expect(invalid.status).toBe(400);
  expect(invalid.body.error.code).toBe('VALIDATION_ERROR');

  const created = await request(app).post('/agents/create-from-description').auth(admin, { type: 'bearer' })
    .send({ description: 'Review security vulnerabilities in repository changes', name: 'Security Review Fixture' });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ status: 'pending_approval', draft: true, config: { agent_type: 'security', risk_class: 'high' } });
  expect(db.prepare('SELECT status, name, retired_at FROM agents WHERE id = ?').get(created.body.id)).toEqual({ status: 'pending_approval', name: 'Security Review Fixture', retired_at: null });

  const approved = await request(app).post(`/agents/${created.body.id}/approve`).auth(admin, { type: 'bearer' }).send({});
  expect(approved.status).toBe(200);
  expect(approved.body.status).toBe('idle');
  expect(db.prepare('SELECT status FROM agents WHERE id = ?').get(created.body.id)).toEqual({ status: 'idle' });
});

it.each(['paused', 'pending_approval', 'offline'])('heartbeat cannot promote %s into executable state or replace configuration', async status => {
  db.prepare('UPDATE agents SET status=? WHERE id=?').run(status, 'a'); task('dispatch', 'a', 'pending');
  const engine = new ExecutionEngine(db);
  await expect(engine.executeTask('dispatch', 'mock')).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' });
  const response = await request(app).post('/agents/a/heartbeat').auth(checker, { type: 'bearer' })
    .send({ status: 'active', active_tasks: 0, metadata: { system_prompt: 'replaced', sample: 1 } });
  expect(response.status).toBe(200);
  const row = db.prepare('SELECT status,metadata,last_heartbeat_at FROM agents WHERE id=?').get('a') as any;
  expect(row.status).toBe(status); expect(row.last_heartbeat_at).toBeTruthy();
  expect(JSON.parse(row.metadata).system_prompt).toBe('protected');
  await expect(engine.executeTask('dispatch', 'mock')).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' });
});

it('same-ID registration preserves statistics, task ownership, child messages and controlled status', async () => {
  task('owned', 'a');
  db.prepare("UPDATE agents SET status='paused',total_tasks=7,completed_tasks=6,current_task_id='owned' WHERE id='a'").run();
  db.prepare("INSERT INTO messages(id,from_agent_id,to_agent_id,type,payload) VALUES('message','a','b','status_update','{}')").run();
  const result = await request(app).post('/agents').auth(admin, { type: 'bearer' }).send({ id: 'a', name: 'renamed', description: 'Updated', status: 'active' });
  expect(result.status).toBe(201);
  expect(result.body).toMatchObject({ id: 'a', name: 'renamed', status: 'paused', total_tasks: 7, completed_tasks: 6, current_task_id: 'owned' });
  expect(db.prepare("SELECT agent_id FROM tasks WHERE id='owned'").get()).toEqual({ agent_id: 'a' });
  expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id='message'").get()).toEqual({ n: 1 });
  expect(result.body.metadata.system_prompt).toBe('protected');
});

it('a name collision cannot replace a different registered identity', async () => {
  task('owned', 'a');
  const result = await request(app).post('/agents').auth(admin, { type: 'bearer' }).send({ id: 'different', name: 'a', description: 'Collision' });
  expect(result.status).toBe(409);
  expect(db.prepare("SELECT id FROM agents WHERE name='a'").get()).toEqual({ id: 'a' });
  expect(db.prepare("SELECT agent_id FROM tasks WHERE id='owned'").get()).toEqual({ agent_id: 'a' });
});

it('retirement cancels only exact agent-owned prepared leases and archives actual state atomically', async () => {
  const plan = await request(app).get('/api/retirement/plan/a').auth(admin, { type: 'bearer' });
  expect(plan.status).toBe(200);
  expect(plan.body).toMatchObject({ agentId: 'a', canRetire: true });
  lease('own', 'a'); lease('unrelated', 'b');
  const result = await request(app).post('/retirement/retire/a').auth(admin, { type: 'bearer' }).send({ reason: 'Fixture retirement', actor: 'forged' });
  expect(result.status).toBe(200); expect(result.body.status).toBe('completed');
  expect(db.prepare('SELECT id,status FROM worker_leases ORDER BY id').all()).toEqual([{ id: 'own', status: 'cancelled' }, { id: 'unrelated', status: 'prepared' }]);
  const retired = db.prepare("SELECT status,retired_at,retirement_reason FROM agents WHERE id='a'").get() as any;
  expect(retired).toMatchObject({ status: 'offline', retirement_reason: 'Fixture retirement' }); expect(retired.retired_at).toBeTruthy();
  const archive = db.prepare("SELECT evidence_json FROM agent_archives WHERE agent_id='a'").get() as any;
  expect(JSON.parse(archive.evidence_json).agent).toMatchObject({ id: 'a', name: 'a', capabilities: '[]' });
  const audit = db.prepare("SELECT user_id FROM audit_events WHERE action='agent_retired'").get(); expect(audit).toEqual({ user_id: 'admin' });
  expect((await request(app).get('/retirement/status/a').auth(admin, { type: 'bearer' })).body.status).toBe('retired');
  expect((await request(app).get('/retirement/list').auth(admin, { type: 'bearer' })).body.retired).toEqual([expect.objectContaining({ agentId: 'a' })]);
});

it.each(['running', 'awaiting_approval', 'queued'])('retirement refuses owned %s tasks without altering another agent or any lease', async status => {
  task('busy', 'a', status); lease('other-lease', 'b');
  const before = db.prepare('SELECT * FROM worker_leases').all();
  const response = await request(app).post('/retirement/retire/a').auth(admin, { type: 'bearer' }).send({ reason: 'Busy fixture' });
  expect(response.status).toBe(409); expect(response.body.error.code).toBe('AGENT_BUSY');
  expect(db.prepare('SELECT * FROM worker_leases').all()).toEqual(before);
  expect(db.prepare("SELECT status FROM agents WHERE id='a'").get()).toEqual({ status: 'idle' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM agent_archives').get()).toEqual({ n: 0 });
});

it('unknown retirement cannot cancel any lease or manufacture an archive', async () => {
  lease('other-lease', 'b');
  const response = await request(app).post('/retirement/retire/missing').auth(admin, { type: 'bearer' }).send({ reason: 'Missing fixture' });
  expect(response.status).toBe(404);
  expect(db.prepare('SELECT status FROM worker_leases').get()).toEqual({ status: 'prepared' });
});

it('retirement audit failure rolls back tombstone, lease changes and archive', async () => {
  lease('own', 'a');
  db.exec("CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'fixture audit failed'); END");
  await expect(new AgentRetirementService(db).retireAgent('a', 'Fixture')).rejects.toThrow('fixture audit failed');
  expect(db.prepare("SELECT status,retired_at FROM agents WHERE id='a'").get()).toEqual({ status: 'idle', retired_at: null });
  expect(db.prepare('SELECT status FROM worker_leases').get()).toEqual({ status: 'prepared' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM agent_archives').get()).toEqual({ n: 0 });
});

it('retired tombstones cannot be revived by heartbeat, registration or direct status update', async () => {
  db.prepare("UPDATE agents SET status='offline',retired_at='2026-09-09T00:00:00Z',retirement_reason='Fixture' WHERE id='a'").run();
  await request(app).post('/agents/a/heartbeat').auth(checker, { type: 'bearer' }).send({ status: 'active' });
  await request(app).post('/agents').auth(admin, { type: 'bearer' }).send({ id: 'a', name: 'a', description: 'Fixture', status: 'idle' });
  const result = await request(app).patch('/agents/a/status').auth(admin, { type: 'bearer' }).send({ status: 'idle' });
  expect(result.status).toBe(409);
  expect(db.prepare("SELECT status,retired_at FROM agents WHERE id='a'").get()).toEqual({ status: 'offline', retired_at: '2026-09-09T00:00:00Z' });
  // Defensive historical inconsistency cannot revive a tombstone through the
  // separate NL approval endpoint either.
  db.prepare("UPDATE agents SET status='pending_approval' WHERE id='a'").run();
  expect((await request(app).post('/agents/a/approve').auth(admin, { type: 'bearer' })).status).toBe(409);
});

it('rejects deleting a running agent rather than detaching its executing task', async () => {
  task('running-task', 'a', 'running');
  const result = await request(app).delete('/agents/a').auth(admin, { type: 'bearer' });
  expect(result.status).toBe(409);
  expect(db.prepare("SELECT agent_id FROM tasks WHERE id='running-task'").get()).toEqual({ agent_id: 'a' });
});

it('retired identity remains retained instead of deleting its tombstone and audit lineage', async () => {
  await new AgentRetirementService(db).retireAgent('a', 'Fixture');
  const result = await request(app).delete('/agents/a').auth(admin, { type: 'bearer' });
  expect(result.status).toBe(409);
  expect(db.prepare("SELECT retired_at FROM agents WHERE id='a'").get()).toBeTruthy();
});

it('uses only owned workload for planning and returns one retirement archive/audit across retries', async () => {
  task('unrelated-running', 'b', 'running'); lease('unrelated-prepared', 'b');
  const service = new AgentRetirementService(db);
  expect(service.planRetirement('a')).toMatchObject({ canRetire: true, stats: { pendingTasks: 0, activeLeases: 0 } });
  await service.retireAgent('a', 'Fixture', 'admin'); await service.retireAgent('a', 'Retry', 'admin');
  expect(db.prepare('SELECT COUNT(*) AS n FROM agent_archives').get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='agent_retired'").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT status FROM tasks WHERE id='unrelated-running'").get()).toEqual({ status: 'running' });
});

it('refuses a still-owned runtime registration even if its task/lease status was stale', async () => {
  lease('own-live', 'a'); RuntimeLeaseRegistry.register('own-live', async () => {});
  const response = await request(app).post('/retirement/retire/a').auth(admin, { type: 'bearer' }).send({ reason: 'Fixture' });
  expect(response.status).toBe(409); expect(RuntimeLeaseRegistry.isLive('own-live')).toBe(true);
  expect(db.prepare("SELECT status FROM worker_leases WHERE id='own-live'").get()).toEqual({ status: 'prepared' });
});

it('does not grant retirement authority to an evidence-writing checker', async () => {
  const response = await request(app).post('/retirement/retire/a').auth(checker, { type: 'bearer' }).send({ reason: 'Unauthorized' });
  expect(response.status).toBe(403);
  expect(db.prepare("SELECT status FROM agents WHERE id='a'").get()).toEqual({ status: 'idle' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM agent_archives').get()).toEqual({ n: 0 });
});
