const D=require("better-sqlite3");const d=new D("/data/djimitflo.sqlite",{readonly:true,fileMustExist:true});
const out={};const q=(k,s,...a)=>{try{out[k]=d.prepare(s).all(...a)}catch(e){out[k]="ERR "+String(e).slice(0,300)}};
out.lr_cols=d.prepare("pragma table_info(loop_runs)").all().map(c=>c.name);
q("by_lane_species",`with o as (select o.success, o.skill_id, coalesce(o.model,'') model, s.evidence_refs_json r, o.evidence_refs_json orf
 from skill_outcomes o join loop_runs lr on lr.id=o.task_id join goals g on g.id=lr.goal_id join self_improvements s on s.id=g.improvement_id
 where o.created_at>=datetime('now','-30 days') and o.skill_id like 'loop-maker:%' and o.skill_id not like 'loop-maker:gym:%' and o.skill_id not like 'loop-maker:merge:%')
 select case when r like '%"mutation-gap:%' then 'mutation' when r like '%"test-gap:%#exports%' then 'exports' when r like '%"test-gap:%' then 'test-gap' else 'other' end lane,
  substr(skill_id, length('loop-maker:doc-drift-and-small-fix-loop:')+1) rt, model, count(*) n, sum(success) ok,
  sum(case when success=0 and (orf like '%outcome_class:infra_failed%' or orf like '%outcome_class:no_change%') then 1 else 0 end) unfair0
 from o group by 1,2,3 order by 1,2`);
q("attrib_by_rt",`select substr(o.skill_id, length('loop-maker:doc-drift-and-small-fix-loop:')+1) rt, json_extract(j.answers_json,'$.class') cls, count(*) n from skill_outcomes o join judgments j on j.subject_id=o.task_id and j.judgment='outcome_attribution' where o.created_at>=datetime('now','-30 days') and o.skill_id like 'loop-maker:doc-drift%' group by 1,2`);
q("attrib_sample","select subject_type, decision, substr(answers_json,1,200) a from judgments where judgment='outcome_attribution' order by created_at desc limit 2");
console.log(JSON.stringify(out));
