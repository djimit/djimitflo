import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { OperatorInterventionService } from '../services/operator-intervention';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createInterventionRoutes } from '../routes/intervention';
import { errorHandler } from '../middleware/error-handler';

let db: Database.Database;
let loops: LoopService;
let service: OperatorInterventionService;
let goalId: string;
const claim = { predicate: 'recommends', subject_ref: 'fixture:instruction', confidence: 0.9, evidence: 'Check the immutable fixture before changing code' };
beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  loops = new LoopService(db);
  service = new OperatorInterventionService(db, loops, new SwarmIntelligenceService(db));
  goalId = loops.createGoal({ objective: 'Disposable intervention fixture', acceptance_criteria: ['No provider executed'], metadata: { retained: 'goal-provenance' } }).id;
  db.prepare('INSERT INTO loop_runs(id,goal_id,loop_name,mode,status,metadata,gates_json) VALUES(?,?,?,?,?,?,?)')
    .run('run', goalId, 'doc-drift-and-small-fix-loop', 'closed', 'planning', JSON.stringify({ risk_class: 'high', retained: 'run-provenance' }), JSON.stringify([{ name: 'security_checker_verdict', status: 'fail', evidence: 'No runtime review' }]));
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

it('returns the actual durable injected claim ID, with operator provenance but no fabricated validation', () => {
  const result = service.injectKnowledge(goalId, claim);
  const stored = db.prepare('SELECT * FROM swarm_claims WHERE id=?').get(result.claim_id) as any;
  expect(stored).toBeDefined();
  expect(stored.status).toBe('proposed');
  expect(stored.verified_by_gate).toBeNull();
  expect(JSON.parse(stored.metadata).goal_id).toBe(goalId);
  expect(db.prepare('SELECT COUNT(*) n FROM audit_events').get()).toEqual({ n: 1 });
});
it.each([{ ...claim, evidence: ' ' }, { ...claim, confidence: 2 }, { ...claim, confidence: 'high' }, { ...claim, predicate: null }])('rejects malformed injection before any storage write', (input) => {
  expect(() => service.injectKnowledge(goalId, input as any)).toThrow();
  expect(db.prepare('SELECT COUNT(*) n FROM swarm_claims').get()).toEqual({ n: 0 });
});
it('rejects an unknown goal instead of creating an orphan claim', () => {
  expect(() => service.injectKnowledge('missing', claim)).toThrow();
  expect(db.prepare('SELECT COUNT(*) n FROM swarm_claims').get()).toEqual({ n: 0 });
});
it('pauses and resumes a quiescent goal without erasing metadata or changing completed runs', async () => {
  db.prepare('INSERT INTO loop_runs(id,goal_id,loop_name,mode,status,metadata) VALUES(?,?,?,?,?,?)').run('done',goalId,'doc-drift-and-small-fix-loop','closed','completed','{}');
  expect((await service.pauseGoal(goalId)).paused).toBe(true);
  expect(loops.getLoopRun('run').metadata).toMatchObject({ retained: 'run-provenance', risk_class: 'high', operator_paused: true });
  expect(loops.getGoal(goalId).metadata).toMatchObject({ retained: 'goal-provenance', operator_paused: true });
  expect(loops.getLoopRun('done').status).toBe('completed');
  expect(() => loops.continueLoopRun('run')).toThrow('LOOP_OPERATOR_PAUSED');
  expect(() => loops.verifyLoopRun('run')).toThrow('LOOP_OPERATOR_PAUSED');
  expect(() => loops.resumeInterruptedRun('run')).toThrow('LOOP_OPERATOR_PAUSED');
  expect(service.resumeGoal(goalId).resumed).toBe(true);
  expect(loops.getLoopRun('run').status).toBe('planning');
  expect(loops.getGoal(goalId).status).toBe('created');
  expect(loops.getLoopRun('run').metadata.retained).toBe('run-provenance');
});
it.each(['prepared','running'])('does not claim a safe pause when a worker is %s', async status => {
  loops.insertWorkerLease({ id:'lease',loopRunId:'run',role:'maker',runtime:'manual',findingId:null,worktreePath:null,branchName:null,now:new Date().toISOString(),metadata:{} });
  loops.updateWorkerLeaseStatus('lease',status as any,{});
  await expect(service.pauseGoal(goalId)).rejects.toThrow('OPERATOR_GOAL_BUSY');
  expect(loops.getLoopRun('run').status).toBe('planning');
  expect(loops.getGoal(goalId).status).toBe('created');
});
it('cannot relabel server-restart recovery as operator resume', () => {
  db.prepare('UPDATE loop_runs SET status=?,metadata=? WHERE id=?').run('interrupted',JSON.stringify({ interrupted_reason:'server_restart', execution_recovery_hold:true }),'run');
  expect(() => service.resumeGoal(goalId)).toThrow('GOAL_NOT_OPERATOR_PAUSED');
  expect(loops.getLoopRun('run').status).toBe('interrupted');
});
it.each(['pending','awaiting_approval','paused'])('refuses pause while an associated task remains %s even without a live lease', async status => {
  db.prepare('INSERT INTO tasks(id,title,description,status,priority,risk_level,execution_mode,metadata) VALUES(?,?,?,?,?,?,?,?)')
    .run('task','Fixture','No execution',status,'low','low','review_only',JSON.stringify({loop_run_id:'run'}));
  await expect(service.pauseGoal(goalId)).rejects.toThrow('OPERATOR_GOAL_BUSY');
  expect(loops.getGoal(goalId).metadata.operator_paused).toBeUndefined();
});
it('records an operator decision without forging executable gate evidence', () => {
  service.overrideGate(goalId,'security_checker_verdict','proceed','Request independent review');
  expect(loops.getLoopRun('run').gates[0]).toMatchObject({ status:'fail',evidence:'No runtime review' });
  expect(loops.getLoopRun('run').metadata.operator_gate_decisions).toHaveLength(1);
  expect(db.prepare('SELECT COUNT(*) n FROM audit_events').get()).toEqual({ n:1 });
});
it.each([['missing','proceed','reason'],['security_checker_verdict','nonsense','reason'],['security_checker_verdict','proceed',' ']])('rejects nonexistent/malformed gate decision %j', (gate,decision,reason) => {
  expect(() => service.overrideGate(goalId,gate,decision as any,reason)).toThrow();
});
it('rolls back pause state if its canonical audit cannot be committed', async () => {
  db.exec("CREATE TRIGGER reject_intervention_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit fixture unavailable'); END");
  await expect(service.pauseGoal(goalId)).rejects.toThrow('audit fixture unavailable');
  expect(loops.getLoopRun('run').status).toBe('planning');
  expect(loops.getGoal(goalId).status).toBe('created');
});
it('protects pause ownership from ordinary goal CRUD, decomposition and new loop creation', async () => {
  await service.pauseGoal(goalId);
  expect(() => loops.updateGoal(goalId,{metadata:{operator_paused:false}})).toThrow('GOAL_OPERATOR_METADATA_SERVER_OWNED');
  expect(() => loops.updateGoal(goalId,{status:'running'})).toThrow('LOOP_OPERATOR_PAUSED');
  expect(() => loops.decomposeGoal(goalId)).toThrow('LOOP_OPERATOR_PAUSED');
  expect(() => loops.startLoop({goal_id:goalId})).toThrow('LOOP_OPERATOR_PAUSED');
  await expect(loops.executeMaker('run')).rejects.toThrow('LOOP_OPERATOR_PAUSED');
  await expect(loops.executeChecker('run')).rejects.toThrow('LOOP_OPERATOR_PAUSED');
  expect(loops.resumeInterruptedRuns().resumed).toBe(0);
});
it('does not persist or publish an injected claim when its audit fails', () => {
  const intelligence=new SwarmIntelligenceService(db);
  const create=vi.spyOn(intelligence,'createClaim');
  service=new OperatorInterventionService(db,loops,intelligence);
  db.exec("CREATE TRIGGER reject_intervention_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'audit fixture unavailable'); END");
  expect(() => service.injectKnowledge(goalId,claim)).toThrow('audit fixture unavailable');
  expect(create).not.toHaveBeenCalled();
  expect(db.prepare('SELECT COUNT(*) n FROM swarm_claims').get()).toEqual({n:0});
});
it('uses authenticated operator identity through the actual HTTP route and rejects viewer writes', async () => {
  const authService = new AuthService(db);
  const admin = authService.createUser('intervention-admin@fixture.test','DisposableFixturePassword!123',UserRole.ADMIN);
  const viewer = authService.createUser('intervention-viewer@fixture.test','DisposableFixturePassword!123',UserRole.VIEWER);
  const auth = createAuthMiddleware(authService);
  const app=express(); app.use(express.json()); app.use('/intervention',auth.requireAuth,createInterventionRoutes(db,auth)); app.use(errorHandler);
  const response=await request(app).post(`/intervention/${goalId}/inject`).set('Authorization',`Bearer ${authService.generateToken(admin)}`).send({...claim,user_id:viewer.id});
  expect(response.status).toBe(200);
  expect(db.prepare('SELECT id FROM swarm_claims WHERE id=?').get(response.body.claim_id)).toBeDefined();
  expect(db.prepare('SELECT user_id FROM audit_events').get()).toEqual({user_id:admin.id});
  expect((await request(app).post(`/intervention/${goalId}/pause`).set('Authorization',`Bearer ${authService.generateToken(viewer)}`).send({})).status).toBe(403);
  const paused = await request(app).post(`/intervention/${goalId}/pause`).set('Authorization',`Bearer ${authService.generateToken(admin)}`).send({});
  expect(paused.status).toBe(200);
  expect(paused.body).toMatchObject({ paused: true, drained: 0 });
  const resumed = await request(app).post(`/intervention/${goalId}/resume`).set('Authorization',`Bearer ${authService.generateToken(admin)}`).send({});
  expect(resumed.status).toBe(200);
  expect(resumed.body).toMatchObject({ resumed: true, requeued: 0 });
  const overridden = await request(app).post(`/intervention/${goalId}/override`).set('Authorization',`Bearer ${authService.generateToken(admin)}`).send({ gate: 'security_checker_verdict', decision: 'proceed', reason: 'Recorded operator intent; independent verification remains required' });
  expect(overridden.status).toBe(200);
  expect(overridden.body).toEqual({ overridden: false, recorded: true });
});
