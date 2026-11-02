// Copy into the pinned checkout's packages/server/src/__tests__/ to run; no production access.
import {afterEach, beforeEach, expect, it} from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {schema} from '../database/schema';
import {runMigrations} from '../database/migrate';
import {AgentCommunicationService} from '../services/agent-communication-service';
import {validateGrounding} from '../services/commons-grounding';
import {buildEvidencePack} from '../services/commons-evidence-pack';
let db: Database.Database;
let root: string;
beforeEach(()=>{db=new Database(':memory:');db.exec(schema);runMigrations(db);root=fs.mkdtempSync(path.join(os.tmpdir(),'commons-audit-'));});
afterEach(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});

it('reproduces real discussions being absent from the latest page when record-only rooms dominate',()=>{
  const comms=new AgentCommunicationService(db);
  const insert=db.prepare("INSERT INTO agent_messages(id,from_agent,to_agent,type,payload_json,timestamp,status) VALUES (?, ?, ?, 'question', ?, ?, 'read')");
  const now=Date.now();
  insert.run('real','a','b',JSON.stringify({action:'social.question',thread_id:'social:real',context:'an operational question',params:{topic:'real'}}),new Date(now-60000).toISOString());
  for(let i=0;i<51;i++) insert.run(`r${i}`,'djimitflo:evidence-room','commons',JSON.stringify({action:'social.question',thread_id:`evidence-room:${i}`,context:'record only',params:{topic:'room'}}),new Date(now-1000+i).toISOString());
  const view=comms.listSocialCommons(50);
  expect(view.total_threads).toBe(52);
  expect(view.stats?.threads_7d).toBe(1);
  expect(view.threads).toHaveLength(50);
  expect(view.threads.some(t=>t.id==='social:real')).toBe(false);
});

it('confirms that grounding validity alone does not establish executable or semantically relevant tests',()=>{
  fs.writeFileSync(path.join(root,'notes.md'),'unrelated notes');
  fs.writeFileSync(path.join(root,'other.md'),'not an executable test');
  expect(validateGrounding({target:'notes.md',test:'other.md'},root).valid).toBe(true);
});

it('confirms missing source tables are represented as zero/empty in the evidence pack',()=>{
  const empty=new Database(':memory:');
  try {
    const pack=buildEvidencePack(empty);
    expect(pack.self_improvement).toEqual({verified:0,regressed:0,parked:0,needs_grounding:0});
    expect(pack.loop_runs).toEqual({});
  } finally {empty.close();}
});

it('confirms fresh external evidence refs are discarded by the ordinary response contract',()=>{
  for(const id of ['a','b']) db.prepare("INSERT INTO agents(id,name,description,status,capabilities,metadata) VALUES (?,?,'fixture','active','[]','{}')").run(id,id);
  const comms=new AgentCommunicationService(db);
  comms.send({from:'b',to:'a',type:'question',action:'social.question',context:'inspect this evidence',evidence:['file:known.ts'],threadId:'social:refs',ttl:3600,params:{topic:'known evidence'}});
  const [m]=comms.receiveSocial('a',1);
  expect(m).toBeDefined();
  const result=comms.respondSocial('a',m.id,{answer:'a hypothesis',uncertainty:'not yet executed',falsifiable_next_step:'an isolated comparison',creative_alternative:'a simpler approach',stop_condition:'stop without useful evidence',evidence_refs:['file:known.ts','artifact:new-test'],runtime:'audit-fixture',model_id:'mock',delivery_lease_token:m.deliveryLeaseToken});
  expect(result.message.payload.evidence).toContain('file:known.ts');
  expect(result.message.payload.evidence).not.toContain('artifact:new-test');
});
