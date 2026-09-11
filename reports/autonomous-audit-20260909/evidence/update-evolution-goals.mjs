// Explicit progress only; does not start execution or certify unmet objectives.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const baselineBytes=readFileSync(new URL('evolution-baseline.json',import.meta.url));
const baseline=JSON.parse(baselineBytes);
assert.equal(baseline.state,'BASELINE_RECORDED');
assert.equal(baseline.source.commit,baseline.github_main);
assert.equal(baseline.production_reference.http_status,200);
assert(baseline.production_reference.authenticated_capabilities.startsWith('UNKNOWN'));
assert.equal(baseline.previous_verified_checkpoint.mission_complete,false);
assert.equal(baseline.goals.length,6);
const base='http://127.0.0.1:3187/api';
const auth=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'audit@example.test',password:'disposable-local-audit-only'})});
assert.equal(auth.status,200);const{token}=await auth.json();
async function call(path,method='GET',body){const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;}
const loopsBefore=await call('/loops/runs');
const progress=[];
for(const item of [...baseline.goals].reverse()){
  const key=item.key.slice(-2);let input;
  if(key==='E1')input={status:'completed',metadata:{acceptance_evidence:[{path:'reports/autonomous-audit-20260909/evidence/evolution-baseline.json',sha256:createHash('sha256').update(baselineBytes).digest('hex'),scope:'Attributable baseline snapshot, not current feature verification'}]}};
  else if(['E2','E3','E4'].includes(key))input={status:'running',metadata:{progress_kind:'active_external_audit',autonomous_worker_started:false,objective_complete:false}};
  else input={metadata:{progress_kind:'prerequisite_corrections_only',objective_complete:false,causal_improvement_proven:false,recurring_background_monitor_active:false}};
  const goal=await call(`/goals/${item.id}`,'PATCH',input);progress.push({key,id:goal.id,status:goal.status,metadata:goal.metadata});
}
assert.deepEqual(await call('/loops/runs'),loopsBefore);
assert.equal(progress.filter(g=>g.status==='completed').length,1);
console.log(JSON.stringify({state:'PASS',recorded_at:new Date().toISOString(),scope:'E1 baseline completed; E2/E3/E4 active audit, not workers; E5/E6 prerequisites remain open',progress},null,2));
