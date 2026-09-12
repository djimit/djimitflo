import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExternalEventIngestService } from '../services/external-event-ingest-service';
import { OutcomeLearningService } from '../services/outcome-learning-service';
import { WorkItemService } from '../services/work-item-service';
import { createSwarmIntelRoutes } from '../routes/swarm-intel';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { errorHandler } from '../middleware/error-handler';

let db: Database.Database;
let bus: Server;
let busUrl: string;
let folder: string;
let events: Record<string, unknown>[];
let app: express.Express;
let token: string;
let adminToken: string;
beforeEach(async () => {
  folder=mkdtempSync(join(tmpdir(),'djimitflo-outcome-chain-'));
  db=new Database(join(folder,'fixture.sqlite'));db.pragma('foreign_keys=ON');db.exec(schema);runMigrations(db);
  db.prepare('INSERT INTO users(id,email,password_hash,role) VALUES(?,?,?,?)').run('fixture-viewer','viewer@fixture.test','unused','viewer');
  const authService=new AuthService(db);const auth=createAuthMiddleware(authService);token=authService.generateToken(authService.findUserById('fixture-viewer')!);
  const admin=authService.createUser('fixture-admin@test','test-password-only','admin');adminToken=authService.generateToken(admin);
  app=express();app.use('/intelligence',auth.requireAuth,createSwarmIntelRoutes(db,auth));app.use('/api/swarms',auth.requireAuth,createSwarmIntelRoutes(db,auth));app.use(errorHandler);
  events=Array.from({length:3},(_,i)=>outcome(i));
  bus=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({events:[...events].reverse()}));});
  await new Promise<void>(resolve=>bus.listen(0,'127.0.0.1',resolve));busUrl=`http://127.0.0.1:${(bus.address() as AddressInfo).port}`;
});
afterEach(async()=>{await new Promise<void>(resolve=>bus.close(()=>resolve()));db.close();rmSync(folder,{recursive:true,force:true});});
function outcome(i:number):Record<string,unknown>{return {
  _id:`${i+1}-0`,event_id:`outcome-fixture:${i}`,event_type:'outcome.observed',source:'local-fixture',
  outcome_id:`observation-${i}`,subject_type:'test',subject_id:'fixture',task_id:'fixture-task',candidate_id:'fixture-candidate',capability_id:'fixture-capability',
  model_id:'no-provider',skill_hash:'fixture-only',runtime_identity:'local-http-fixture',metric:'correctness',value:'0.9',baseline:'0.5',
  observation_window:'fixture-window',evidence_refs:'["fixture:measurement"]',confidence:'0.95',causal_status:'randomized',direction:'increase',
  experiment_id:'fixture-experiment',replication_id:`rep-${i}`,observed_at:'2026-09-09T10:00:00Z',dedupe_key:`outcome-fixture:${i}`,
};}

it('closes actual event HTTP -> normalization -> assessment -> candidate -> authenticated existing API without claiming causal proof',async()=>{
  expect(await new ExternalEventIngestService(db,busUrl).pollOnce()).toBe(3);
  const assessments=new OutcomeLearningService(db).list();expect(assessments).toHaveLength(1);
  expect(assessments[0]).toMatchObject({replications:3,mean_value:0.9,baseline_value:0.5,signal_status:'SUPPORTED',status:'UNDETERMINED',causal_support:false,result:{promotion_eligible:false,evidence_authority:'reported_observations'}});
  const item=db.prepare('SELECT status,parent_goal_id,metadata FROM work_items WHERE id=?').get(assessments[0].work_item_id) as any;
  expect(item.status).toBe('candidate');expect(item.parent_goal_id).toBeNull();expect(JSON.parse(item.metadata).outcome_learning.assessment_id).toBe(assessments[0].id);
  expect((await request(app).get('/intelligence/intelligence/outcome-learning')).status).toBe(401);
  const response=await request(app).get('/intelligence/intelligence/outcome-learning').auth(token,{type:'bearer'});expect(response.status).toBe(200);expect(response.body.assessments[0].id).toBe(assessments[0].id);
  const canonicalResponse=await request(app).get('/api/swarms/intelligence/outcome-learning').auth(token,{type:'bearer'});
  expect(canonicalResponse.status).toBe(200);expect(canonicalResponse.body.assessments[0].id).toBe(assessments[0].id);
  const capabilitiesResponse=await request(app).get('/api/swarms/intelligence/capabilities?limit=10').auth(token,{type:'bearer'});
  expect(capabilitiesResponse.status).toBe(200);expect(capabilitiesResponse.body.capabilities).toEqual([]);
  const reviewerResponse=await request(app).get('/api/swarms/intelligence/reviewer-independence?limit=10').auth(token,{type:'bearer'});
  expect(reviewerResponse.status).toBe(200);expect(reviewerResponse.body.assessments).toEqual([]);
  const handoffResponse=await request(app).post('/api/swarms/intelligence/interaction-handoff/reconcile').auth(adminToken,{type:'bearer'}).send({limit:10});
  expect(handoffResponse.status).toBe(200);expect(handoffResponse.body).toMatchObject({scanned:0,candidates:0,created:0,rejected:0,status:'PASS'});
});

it('replays and reopens the actual database without duplicating observations, assessments, candidates or goals',async()=>{
  await new ExternalEventIngestService(db,busUrl).pollOnce();
  const first=new OutcomeLearningService(db).list();expect(first).toHaveLength(1);
  expect(await new ExternalEventIngestService(db,busUrl).pollOnce()).toBe(0);
  db.close();db=new Database(join(folder,'fixture.sqlite'));
  expect(await new ExternalEventIngestService(db,busUrl).pollOnce()).toBe(0);
  expect(new OutcomeLearningService(db).list()[0].work_item_id).toBe(first[0].work_item_id);
  expect(db.prepare('SELECT COUNT(*) AS n FROM external_events').get()).toEqual({n:3});
  expect(db.prepare('SELECT COUNT(*) AS n FROM outcome_learning_assessments').get()).toEqual({n:1});
  expect(db.prepare('SELECT COUNT(*) AS n FROM work_items').get()).toEqual({n:1});
  expect(db.prepare('SELECT COUNT(*) AS n FROM goals').get()).toEqual({n:0});
});

it('rolls back imported events and cursor when materialization fails, then retries the same event batch',async()=>{
  db.exec("CREATE TRIGGER fixture_assessment_failure BEFORE INSERT ON outcome_learning_assessments BEGIN SELECT RAISE(ABORT,'fixture assessment failed'); END");
  await expect(new ExternalEventIngestService(db,busUrl).pollOnce()).rejects.toThrow('fixture assessment failed');
  expect(db.prepare('SELECT COUNT(*) AS n FROM external_events').get()).toEqual({n:0});
  expect(db.prepare("SELECT value FROM system_state WHERE key='external_event_ingest_cursor:djimit.events'").get()).toBeUndefined();
  db.exec('DROP TRIGGER fixture_assessment_failure');
  expect(await new ExternalEventIngestService(db,busUrl).pollOnce()).toBe(3);expect(new OutcomeLearningService(db).list()).toHaveLength(1);
});

it('does not treat sender-supplied causal labels as independently established causality even with many repetitions',()=>{
  const insert=db.prepare("INSERT INTO external_events(id,event_type,source,occurred_at,payload) VALUES(?,'outcome.observed','fixture',?,?)");
  for(let i=0;i<35;i++)insert.run(`direct-${i}`,'2026-09-09T10:00:00Z',JSON.stringify({...outcome(i),value:0.9,baseline:0.5,confidence:1,evidence_refs:['invented:randomization']}));
  new OutcomeLearningService(db).process();
  const result=new OutcomeLearningService(db).list()[0];
  expect(result.signal_status).toBe('SUPPORTED');expect(result.causal_support).toBe(false);expect(result.status).toBe('UNDETERMINED');
});

it('refreshes only the outcome projection without erasing operator scope, goal linkage or leased ownership', async () => {
  const ingest = new ExternalEventIngestService(db, busUrl);
  await ingest.pollOnce();
  const workItems = new WorkItemService(db);
  const id = new OutcomeLearningService(db).list()[0].work_item_id!;
  const original = workItems.get(id)!;
  workItems.update(id, {
    title: 'Operator-selected title', description: 'Operator-selected bounded scope', risk_class: 'high',
    metadata: { ...original.metadata, objective: 'Narrow operator objective', operator_note: 'preserve', requires_human_approval: true },
  });
  const converted = workItems.convertToGoal(id);
  workItems.update(id, { status: 'leased', assigned_runtime: 'mock' });
  const before = workItems.get(id)!;
  expect(await ingest.pollOnce()).toBe(0);
  expect(workItems.get(id)).toMatchObject({
    title: before.title, description: before.description, status: 'leased', assigned_runtime: 'mock',
    parent_goal_id: converted.goal_id, risk_class: 'high', metadata: before.metadata,
  });
});

it('escalates refreshed observation risk without decreasing an existing operator risk', async () => {
  const ingest = new ExternalEventIngestService(db, busUrl);
  await ingest.pollOnce();
  const workItems = new WorkItemService(db);
  const id = new OutcomeLearningService(db).list()[0].work_item_id!;
  workItems.update(id, { risk_class: 'high' });
  await ingest.pollOnce();
  expect(workItems.get(id)!.risk_class).toBe('high');
  events.push({ ...outcome(3), risk_class: 'critical' });
  await ingest.pollOnce();
  expect(workItems.get(id)!.risk_class).toBe('critical');
  events.push({ ...outcome(4), risk_class: 'low' });
  await ingest.pollOnce();
  expect(workItems.get(id)!.risk_class).toBe('critical');
});

it('refreshes an existing candidate when contradictory evidence makes its signal undetermined', async () => {
  const ingest = new ExternalEventIngestService(db, busUrl);
  await ingest.pollOnce();
  const id = new OutcomeLearningService(db).list()[0].work_item_id!;
  events.push({ ...outcome(3), value: '-10' });
  await ingest.pollOnce();
  expect(new OutcomeLearningService(db).list()[0]).toMatchObject({ signal_status: 'UNDETERMINED', replications: 4 });
  expect(new WorkItemService(db).get(id)!.metadata.outcome_learning).toMatchObject({ signal_status: 'UNDETERMINED', replications: 4 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM work_items').get()).toEqual({ n: 1 });
});

it('does not create a candidate for a first batch with an undetermined signal', async () => {
  events.push({ ...outcome(3), value: '-10' });
  await new ExternalEventIngestService(db, busUrl).pollOnce();
  expect(new OutcomeLearningService(db).list()[0]).toMatchObject({ signal_status: 'UNDETERMINED', work_item_id: null });
  expect(db.prepare('SELECT COUNT(*) AS n FROM work_items').get()).toEqual({ n: 0 });
});

it('runs real recurrent polling, stops and restarts from the durable cursor without duplicating work', async () => {
  const runCycles = async () => {
    const ingest = new ExternalEventIngestService(db, busUrl, 'djimit.events', 10);
    const poll = vi.spyOn(ingest, 'pollOnce');
    try {
      ingest.start();
      await vi.waitFor(() => expect(poll.mock.calls.length).toBeGreaterThanOrEqual(2));
    } finally {
      ingest.stop();
      await Promise.all(poll.mock.results.map(result => result.value));
    }
    return poll.mock.calls.length;
  };
  expect(await runCycles()).toBeGreaterThanOrEqual(2);
  const id = new OutcomeLearningService(db).list()[0].work_item_id;
  db.close();
  db = new Database(join(folder, 'fixture.sqlite'));
  expect(await runCycles()).toBeGreaterThanOrEqual(2);
  expect(new OutcomeLearningService(db).list()[0].work_item_id).toBe(id);
  expect(db.prepare('SELECT COUNT(*) AS n FROM external_events').get()).toEqual({ n: 3 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM outcome_learning_assessments').get()).toEqual({ n: 1 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM work_items').get()).toEqual({ n: 1 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM goals').get()).toEqual({ n: 0 });
});
