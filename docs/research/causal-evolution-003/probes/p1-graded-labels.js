const D=require("better-sqlite3");const d=new D("/data/djimitflo.sqlite",{readonly:true,fileMustExist:true});
const out={at:new Date().toISOString()};
const J=(s)=>{try{return JSON.parse(s||'{}')}catch{return {}}};
// all completed maker leases with graded score (same population as gradedVsLabels)
const rows=d.prepare(`SELECT l.id lease, l.loop_run_id run, l.runtime, l.status lstatus, l.created_at, l.updated_at, l.metadata lm,
  r.loop_name, r.status rstatus, r.metadata rm, s.status sstatus, s.id sid, s.evidence_refs_json ev, s.approved_by
  FROM worker_leases l JOIN loop_runs r ON r.id=l.loop_run_id LEFT JOIN goals g ON g.id=r.goal_id LEFT JOIN self_improvements s ON s.id=g.improvement_id
  WHERE l.role='maker' AND l.status='completed' AND json_extract(l.metadata,'$.superseded_by_maker_lease_id') IS NULL
  AND json_type(l.metadata,'$.graded.score') IN ('integer','real') ORDER BY l.updated_at`).all();
const per=new Map(); for(const r of rows) per.set(r.run,r);
const ck=d.prepare(`SELECT role, status, json_extract(metadata,'$.verdict') v FROM worker_leases WHERE json_extract(metadata,'$.maker_lease_id')=? AND role IN ('checker','security_checker') ORDER BY created_at`);
out.items=[...per.values()].map(r=>{const m=J(r.lm), rm=J(r.rm); const g=m.graded||{};
  const checks=Array.isArray(m.deterministic_checks)?m.deterministic_checks.map(c=>({n:c.name,s:c.status,sh:c.shadow_status})):null;
  const cs=ck.all(r.lease);
  return {run:r.run.slice(0,8),lease:r.lease.slice(0,8),loop:r.loop_name,runtime:r.runtime,model:m.model||null,created:r.created_at,
   lane:g.lane||null,kind:g.kind,score:g.score,killed:g.killed??null,total:g.total??null,
   rstatus:r.rstatus,sstatus:r.sstatus,approved_by:(r.approved_by||'').replace(/:.*/,''),
   survived:rm.pr_outcome?rm.pr_outcome.survived??null:null, merged:rm.pr_outcome?!!rm.pr_outcome.merged_at:null,
   changed:Array.isArray(m.changed_files)?m.changed_files.length:null, diff_lines:m.diff_lines??m.diff_stats?.lines??null,
   failure_reason:(rm.failure_reason||m.failure_reason||'').slice(0,80), checkers:cs.map(c=>`${c.role}:${c.status}:${c.v}`),
   checks, genome:m.genome_id||null, bandit:m.bandit?m.bandit.reason?.slice(0,30):null}});
// population of completed makers on test-writing lanes WITHOUT a graded score, by skip reason (selection into graded)
const all=d.prepare(`SELECT l.metadata lm, s.evidence_refs_json ev, s.status sstatus FROM worker_leases l JOIN loop_runs r ON r.id=l.loop_run_id LEFT JOIN goals g ON g.id=r.goal_id LEFT JOIN self_improvements s ON s.id=g.improvement_id
  WHERE l.role='maker' AND (s.evidence_refs_json LIKE '%test-gap:%' OR s.evidence_refs_json LIKE '%mutation-gap:%') AND l.created_at>='2026-10-08'`).all();
const sel={};for(const a of all){const m=J(a.lm);const lane=/mutation-gap:/.test(a.ev)?'mutation':/test-gap:[^"]*#exports/.test(a.ev)?'exports':'test-gap';
 const st=(m.graded&&typeof m.graded.score==='number')?'graded':(m.graded&&m.graded.skipped)?('skip:'+m.graded.skipped):'none';
 const k=`${lane}|${st}|${a.sstatus}`;sel[k]=(sel[k]||0)+1;}
out.selection=sel;
out.status_flags={GRADED_FITNESS_MODE:process.env.GRADED_FITNESS_MODE,GRADED_CONTEST_MODE:process.env.GRADED_CONTEST_MODE,WEAK_ASSERTION_CHECK_MODE:process.env.WEAK_ASSERTION_CHECK_MODE,SETTLEMENT_EXECUTION_MODE:process.env.SETTLEMENT_EXECUTION_MODE,LOOP_DAEMON_CHECK_SCRIPTS:process.env.LOOP_DAEMON_CHECK_SCRIPTS,LOOP_BANDIT_SPECIES:process.env.LOOP_BANDIT_SPECIES,LOOP_BANDIT_MAX_SHARE:process.env.LOOP_BANDIT_MAX_SHARE,GENOME_APPLY_MODE:process.env.GENOME_APPLY_MODE??null,LOOP_AUTO_MERGE_MODE:process.env.LOOP_AUTO_MERGE_MODE??null,MEMORY_HOLDOUT_RATE:process.env.MEMORY_HOLDOUT_RATE??null};
console.log(JSON.stringify(out));
