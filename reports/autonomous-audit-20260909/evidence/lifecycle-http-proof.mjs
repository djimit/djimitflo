// Disposable local HTTP/domain proof. Mock output is explicitly not provider proof.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
const base = 'http://127.0.0.1:3187/api';
async function login(email, password) {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({email,password}) });
  assert.equal(r.status,200); return (await r.json()).token;
}
const token = await login('audit@example.test','disposable-local-audit-only');
async function api(path, method='GET', body, expected=200, credential=token) {
  const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json(); assert.equal(r.status,expected,`${method} ${path}: ${JSON.stringify(data)}`); return data;
}
const mode=process.argv[2] || 'setup';
const fixturePath=new URL('lifecycle-http-setup.json',import.meta.url);
if(mode==='setup') {
  const agent=await api('/agents/create-from-description','POST',{name:`Lifecycle browser ${Date.now()}`,description:'Read-only test fixture; no external tools.'},201);
  assert.equal(agent.status,'pending_approval');
  const heartbeat=await api(`/agents/${agent.id}/heartbeat`,'POST',{status:'active',active_tasks:0,metadata:{system_prompt:'untrusted telemetry'}});
  assert.equal(heartbeat.status,'pending_approval');
  const task=await api('/tasks','POST',{title:'Lifecycle approval fixture',description:'Read-only synthetic mock verification.',risk_level:'high',execution_mode:'local',use_swarm_context:false,metadata:{executor:'mock'}},201);
  const pending=await api(`/evidence/summary/${task.id}`);
  assert.equal(pending.final_status,'pending'); assert.equal(pending.started_at,null); assert.equal(pending.policy_decision,'unknown');
  const execution=await api(`/tasks/${task.id}/execute`,'POST',{executor:'mock'});
  assert.equal(execution.status,'awaiting_approval');
  const held=await api(`/evidence/summary/${task.id}`);
  assert.equal(held.final_status,'awaiting_approval'); assert.equal(held.started_at,null); assert.equal(held.policy_decision,'require_approval');
  console.log(JSON.stringify({agentId:agent.id,taskId:task.id,approvalId:execution.approvalId,pending,held},null,2));
} else {
  const fixture=JSON.parse(readFileSync(fixturePath,'utf8'));
  const {agentId,taskId,approvalId}=fixture;
  if(mode==='complete' || mode==='finish') {
    const checker=await login('audit-org-20260909@example.test','disposable-organization-fixture-only');
    if(mode==='complete') {
      await api(`/tasks/${taskId}`,'PATCH',{description:'Changed read-only synthetic mock verification.'});
      await api(`/approvals/${approvalId}/approve`,'POST',{reason:'Disposable local fixture only; changed input must require a new grant.'},200,checker);
    }
    const approvals=(await api('/approvals')).approvals.filter(a=>a.task_id===taskId);
    const fresh=approvals.find(a=>a.status==='pending'); assert(fresh); assert.notEqual(fresh.id,approvalId);
    const intermediate=await api(`/evidence/summary/${taskId}`); assert.equal(intermediate.final_status,'awaiting_approval'); assert.equal(intermediate.started_at,null);
    await api(`/approvals/${fresh.id}/approve`,'POST',{reason:'Same requester must be refused.'},409,checker);
    // Existing disposable approver; signed fixture credential, not human approval.
    const fixtureDb=new Database(new URL('../../../.data/audit.sqlite',import.meta.url).pathname,{readonly:true});
    const reviewer=fixtureDb.prepare('SELECT id,email,role FROM users WHERE email=?').get('audit-approver@example.test');
    fixtureDb.close(); assert(reviewer); assert.equal(reviewer.role,'approver');
    const reviewerToken=jwt.sign({sub:reviewer.id,email:reviewer.email,role:reviewer.role,organization_id:'default'},'disposable-local-audit-secret-not-for-production',{expiresIn:'5m'});
    await api(`/approvals/${fresh.id}/approve`,'POST',{reason:'Approve unchanged disposable mock fixture only.'},200,reviewerToken);
    let completed;
    for(let i=0;i<60;i++){completed=await api(`/evidence/summary/${taskId}`); if(completed.final_status==='completed')break; await new Promise(r=>setTimeout(r,250));}
    assert.equal(completed.final_status,'completed'); assert(completed.started_at); assert(completed.completed_at); assert(completed.event_count>0);
    await api(`/retirement/retire/${agentId}`,'POST',{reason:'Disposable fixture retired after pending-status browser check.'});
    await api(`/agents/${agentId}/heartbeat`,'POST',{status:'active',active_tasks:0});
    await api(`/agents/${agentId}/status`,'PATCH',{status:'active'},409);
    console.log(JSON.stringify({agentId,taskId,oldApprovalId:approvalId,newApprovalId:fresh.id,intermediate,completed,provider:'mock-simulation-only'},null,2));
  } else if(mode==='verify') {
    await api(`/agents/${agentId}/status`,'PATCH',{status:'active'},409);
    const summary=await api(`/evidence/summary/${taskId}`); assert.equal(summary.final_status,'completed');
    const retired=await api(`/retirement/status/${agentId}`); assert.equal(retired.status,'retired');
    const db=new Database(new URL('../../../.data/audit.sqlite',import.meta.url).pathname,{readonly:true});
    const archive=db.prepare('SELECT id,evidence_json FROM agent_archives WHERE agent_id=?').get(agentId); assert(archive); assert.equal(JSON.parse(archive.evidence_json).agent.id,agentId);
    const audit=db.prepare('SELECT id,action,event_type,resource_id,timestamp FROM audit_events WHERE task_id=? OR agent_id=? ORDER BY rowid').all(taskId,agentId);
    assert(audit.some(a=>a.action==='agent_retired')); assert(audit.some(a=>a.action==='execution_completed'));
    const decisions=db.prepare('SELECT id,status,metadata FROM approvals WHERE task_id=? ORDER BY rowid').all(taskId);
    assert.equal(decisions.length,2); assert(decisions.every(a=>a.status==='approved'));
    assert.notEqual(JSON.parse(decisions[0].metadata).executionInputHash,JSON.parse(decisions[1].metadata).executionInputHash);
    const review=await api(`/evidence/review/${taskId}`);
    const grants=review.audit_trail.filter(a=>a.event_type==='approval.granted');
    assert.equal(grants.length,2);
    for(const grant of grants){const recorded=audit.find(a=>a.event_type==='approval.granted' && a.resource_id===grant.resource_id);assert(recorded);assert.equal(grant.timestamp,recorded.timestamp);}
    db.close(); console.log(JSON.stringify({agentId,taskId,retired,archiveId:archive.id,summary,audit,decisions:decisions.map(a=>({id:a.id,status:a.status})),restartPersistence:true,reviewGrantCount:grants.length,reviewGrantTimestampsMatchCanonical:true},null,2));
  } else throw Error('Unknown proof mode');
}
