// Audit fixture: copy into the pinned server's src/__tests__; no network or model calls.
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import Database from 'better-sqlite3';
import {schema} from '../database/schema';
import {runMigrations} from '../database/migrate';
import {AgentCommunicationService} from '../services/agent-communication-service';
import {SelfImprovementService} from '../services/self-improvement-service';

let db: Database.Database;
beforeEach(()=>{
  db=new Database(':memory:'); db.exec(schema); runMigrations(db);
  vi.stubEnv('PROPOSAL_GROUNDING_REQUIRED','true');
  for(const id of ['a','b']) db.prepare("INSERT INTO agents(id,name,description,status,capabilities,metadata) VALUES (?,?,'audit fixture','active','[]','{}')").run(id,id);
});
afterEach(()=>{db.close();vi.unstubAllEnvs();});

it.each([0,1])('cap %i allows a learning reflection but controls proposal admission without creating a goal',cap=>{
  vi.stubEnv('REFLECTION_PROPOSALS_MAX_PER_DAY',String(cap));
  const comms=new AgentCommunicationService(db);
  comms.send({from:'b',to:'a',type:'result',action:'social.response',context:'unverified hypothesis',evidence:['file:known.ts'],threadId:'social:policy',ttl:3600,params:{topic:'bounded diagnosis',ecosystem_component:'DjimitFlo'}});
  const [message]=comms.receiveSocial('a',1);
  const out=comms.respondSocial('a',message.id,{
    answer:'This remains an untested diagnostic hypothesis',uncertainty:'No execution evidence yet',
    falsifiable_next_step:'Compare behavior on an isolated fixed case',creative_alternative:'Keep the current behavior',
    stop_condition:'Stop if the independent check contradicts the hypothesis',
    proposed_improvement:'Fix the fixture error handling',ecosystem_component:'DjimitFlo',
    evidence_refs:['file:known.ts'],runtime:'audit-mock',model_id:'mock',delivery_lease_token:message.deliveryLeaseToken,
  });
  expect(out.message.payload.action).toBe('social.learning');
  expect(out.reflection_id).toBeTruthy();
  const reflection=db.prepare('SELECT metadata FROM reflection_candidates WHERE id=?').get(out.reflection_id!) as {metadata:string};
  expect(JSON.parse(reflection.metadata).promotion_allowed).toBe(false);
  const proposals=db.prepare('SELECT id,status FROM self_improvements').all() as {id:string,status:string}[];
  expect(proposals).toHaveLength(cap);
  expect(out.message.payload.params.improvement_id??null).toBe(cap?proposals[0].id:null);
  if(cap) expect(proposals[0].status).toBe('needs_grounding');
  expect((db.prepare('SELECT COUNT(*) n FROM goals').get() as {n:number}).n).toBe(0);
});

it('cap zero also returns no existing-proposal association even when includeExisting is true',()=>{
  const service=new SelfImprovementService(db);
  const input={whatFailed:[],lessonsLearned:['unverified'],proposedImprovements:['Fix the existing fixture behavior']};
  vi.stubEnv('REFLECTION_PROPOSALS_MAX_PER_DAY','1');
  expect(service.generateFromReflection(input,true)).toHaveLength(1);
  vi.stubEnv('REFLECTION_PROPOSALS_MAX_PER_DAY','0');
  expect(service.generateFromReflection(input,true)).toEqual([]);
  expect((db.prepare('SELECT COUNT(*) n FROM self_improvements').get() as {n:number}).n).toBe(1);
});
