// Local fixture authority only; importing goals starts no workers or schedules.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const base='http://127.0.0.1:3187/api';
const auth=await fetch(`${base}/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'audit@example.test',password:'disposable-local-audit-only'})});
assert.equal(auth.status,200);const {token}=await auth.json();
async function call(path,method='GET',body,expected=200){const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();assert.equal(r.status,expected,`${method} ${path}: ${JSON.stringify(value)}`);return value;}
const batch=JSON.parse(readFileSync(new URL('../evolution-goals.json',import.meta.url),'utf8'));
const before=await call('/loops/runs');
const batches=[];
for(let offset=0;offset<batch.ordered_goals.length;offset+=3){
  const selected_ids=batch.ordered_goals.slice(offset,offset+3).map(g=>g.key);
  const input={batch,selected_ids};const preview=await call('/goals/batch/preview','POST',input);
  assert.equal(preview.writes,0);assert.equal(preview.blocked,0);assert.equal(preview.total,3);
  const applied=await call('/goals/batch/apply','POST',input,201);assert.equal(applied.started_workers,0);
  const replay=await call('/goals/batch/apply','POST',input,201);assert.equal(replay.created_goals.length,0);assert.equal(replay.skipped.length,3);
  batches.push({selected_ids,created:applied.created_goals.length,replaySkipped:replay.skipped.length});
}
const response=await call('/goals');const all=response.goals??response;
const keys=new Set(batch.ordered_goals.map(g=>g.key));const goals=all.filter(g=>keys.has(g.metadata?.goal_batch?.id));assert.equal(goals.length,6);
const after=await call('/loops/runs');assert.deepEqual(after,before,'Goal registration must not execute or start loops');
console.log(JSON.stringify({state:'PASS',registeredAt:new Date().toISOString(),started_workers:0,background_schedule_started:false,codex_background_goal_status:'usageLimited',batches,goals},null,2));
