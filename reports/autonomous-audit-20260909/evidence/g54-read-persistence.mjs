import Database from 'better-sqlite3';
import {execFileSync} from 'node:child_process';
const db = new Database('.data/audit.sqlite',{readonly:true});
const ids=['780bbbef-620c-4d9f-b91b-01d1f73f6b6b','6d65eb46-03ea-4d4b-9aad-b3ac75ec4151','3b83a611-881b-4640-9153-c1cabd6f7e44','678dd411-f3e8-4b5f-8439-e1e9c8ec3f3b'];
const runs=ids.map(id=>{
 const run=db.prepare('SELECT id,status,repository_path,metadata,completed_at FROM loop_runs WHERE id=?').get(id);
 const leases=db.prepare('SELECT id,role,runtime,status,metadata FROM worker_leases WHERE loop_run_id=?').all(id).map(l=>({...l,metadata:JSON.parse(l.metadata)}));
 const events=db.prepare('SELECT event_type,message,metadata,created_at FROM loop_events WHERE loop_run_id=? ORDER BY created_at').all(id).map(e=>({...e,metadata:JSON.parse(e.metadata)}));
 const tasks=leases.filter(l=>l.metadata.execution_task_id).map(l=>db.prepare('SELECT id,status,risk_level,execution_mode,started_at,completed_at,token_usage,metadata FROM tasks WHERE id=?').get(l.metadata.execution_task_id));
 const approvals=tasks.flatMap(t=>db.prepare('SELECT id,task_id,status,approved_by,approved_at,decided_by,decided_at FROM approvals WHERE task_id=?').all(t.id));
 const execution_events=tasks.flatMap(t=>db.prepare('SELECT event_type,message,timestamp,metadata FROM execution_events WHERE task_id=? ORDER BY timestamp').all(t.id));
 return {...run,metadata:JSON.parse(run.metadata),leases,events,tasks,approvals,execution_events};
});
const git=args=>execFileSync('git',['-C','/private/tmp/djimitflo-g54-browser-p86vLa',...args],{encoding:'utf8'}).trim();
console.log(JSON.stringify({evidence_class:'synthetic-mock-UI-governance-only',at:new Date().toISOString(),runs,git:{head:git(['rev-parse','HEAD']),main:git(['rev-parse','main']),status:git(['status','--porcelain']),remotes:git(['remote','-v'])}},null,2));db.close();
