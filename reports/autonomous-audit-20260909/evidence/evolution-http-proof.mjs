import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const phase=process.argv[2]??'before';
assert(['before','after'].includes(phase));
const base='http://127.0.0.1:3187/api';
const auth=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'audit@example.test',password:'disposable-local-audit-only'})});
assert.equal(auth.status,200);const{token}=await auth.json();
async function call(path,method='GET',body,expected=200){const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,expected,`${path}: ${JSON.stringify(data)}`);return data;}
const goalType='evolution-fixed-outcomes-20260909';
if(phase==='before'){
  for(let i=0;i<10;i++)await call('/cognitive/episodes','POST',{
    loopRunId:`${goalType}-${i}`,goalId:'manual-observation-fixture',goalType,mode:'manual-observation',
    startedAt:'2026-09-09T10:00:00Z',completedAt:'2026-09-09T10:00:01Z',durationMs:1000,
    outcome:i<5?'failure':'success',strategy:'immutable-fixture',actions:[],
    metrics:{totalLeases:0,completedLeases:0,failedLeases:0,totalTokens:0,totalCostDollars:0,diffLinesChanged:0,filesModified:0,gatesPassed:0,gatesFailed:0},
    metadata:{synthetic:true,providerExecuted:false,purpose:'Measurement fidelity, not intelligence improvement'},
  },201);
}
const initial=await call(`/cognitive/strategy/${goalType}`);
assert.equal(initial.successRate,0.5);assert.equal(initial.episodeCount,10);
for(let i=0;i<9;i++)await call('/cognitive/evolve-strategies','POST',{});
const after=await call(`/cognitive/strategy/${goalType}`);
assert.equal(after.id,initial.id);assert.equal(after.successRate,0.5);assert.equal(after.episodeCount,10);
assert.equal(after.conditions.causal_support,false);
const meta=await call('/cognitive/meta-learning');const record=meta.records.find(r=>r.goalType===goalType);
assert.equal(record.bestSuccessRate,0.5);assert.equal(record.totalEpisodes,10);
const all=await call('/goals');const goals=(all.goals??all).filter(g=>g.metadata?.goal_batch?.id?.startsWith('evolution-20260909-'));
assert.equal(goals.length,6);assert.equal(goals.filter(g=>g.status==='completed').length,1);
if(phase==='after'){
  const previous=JSON.parse(readFileSync(new URL('evolution-http-before.json',import.meta.url)));
  assert.equal(after.id,previous.strategy.id);assert.deepEqual(goals.map(g=>[g.id,g.status]),previous.goals);
}
console.log(JSON.stringify({state:'PASS',phase,recorded_at:new Date().toISOString(),goalType,strategy:after,metaLearning:record,goals:goals.map(g=>[g.id,g.status]),replays:9,actualOutcomeImprovement:0,providerExecuted:false,strategyApplied:false,scope:'Actual authenticated HTTP and durable synthetic observations; not loop execution or causal improvement'},null,2));
