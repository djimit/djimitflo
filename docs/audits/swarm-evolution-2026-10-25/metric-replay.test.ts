// Audit-only HTTP reproduction. Copy into the pinned server's src/__tests__; no production/model access.
import express from 'express';
import request from 'supertest';
import {afterEach,expect,it} from 'vitest';
import {createTestDb} from './helpers/test-db';
import {createSwarmRoutes} from '../routes/swarms';
import {errorHandler} from '../middleware/error-handler';
const dbs: ReturnType<typeof createTestDb>[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();});

it('reproduces endpoint binary first/last labels despite a failed middle run and absent usage',async()=>{
  const db=createTestDb();dbs.push(db);
  const insert=db.prepare("INSERT INTO loop_runs(id,loop_name,mode,status,created_at,updated_at) VALUES (?,'repo-maintenance-loop','closed',?,?,?)");
  for(const [id,status,at] of [['a','completed','2026-10-20T01:00:00Z'],['b','failed','2026-10-20T02:00:00Z'],['c','completed','2026-10-20T03:00:00Z']])insert.run(id,status,at,at);
  const auth={requirePermission:()=> (_req:any,_res:any,next:any)=>next()} as any;
  const app=express().use('/swarms',createSwarmRoutes(db,auth)).use(errorHandler);
  const res=await request(app).get('/swarms/learning-curve');
  expect(res.status).toBe(200);
  expect(res.body.runs).toHaveLength(3);
  expect(res.body.runs.filter((r:{success:boolean})=>r.success)).toHaveLength(2);
  expect(res.body.first_vs_last).toMatchObject({first_success_rate:1,last_success_rate:1,first_cost:0,last_cost:0});
  expect((db.prepare('SELECT COUNT(*) n FROM worker_leases').get() as {n:number}).n).toBe(0);
});
