const D=require("better-sqlite3");const d=new D("/data/djimitflo.sqlite",{readonly:true,fileMustExist:true});
const out={};const q=(k,s,...a)=>{try{out[k]=d.prepare(s).all(...a)}catch(e){out[k]="ERR "+String(e).slice(0,300)}};
q("attrib_lane_rt",`with o as (select o.success, o.skill_id, s.evidence_refs_json r, (select decision from judgments j where j.subject_id=o.task_id and j.judgment='outcome_attribution' order by created_at desc limit 1) cls
 from skill_outcomes o join loop_runs lr on lr.id=o.task_id join goals g on g.id=lr.goal_id join self_improvements s on s.id=g.improvement_id
 where o.created_at>=datetime('now','-30 days') and o.skill_id like 'loop-maker:doc-drift%')
 select case when r like '%"mutation-gap:%' then 'mutation' when r like '%"test-gap:%#exports%' then 'exports' when r like '%"test-gap:%' then 'test-gap' else 'other' end lane,
  substr(skill_id, length('loop-maker:doc-drift-and-small-fix-loop:')+1) rt, coalesce(cls,'none') cls, count(*) n, sum(success) ok from o group by 1,2,3 order by 1,2,3`);
console.log(JSON.stringify(out));
