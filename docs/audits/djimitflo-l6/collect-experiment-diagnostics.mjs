// Read-only diagnostics of experimental units, exclusions and existing frozen paired-task analysis.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {nonMakerRunSql} from '/app/packages/server/dist/services/outcome-attribution.js';
import {notFallbackRunSql} from '/app/packages/server/dist/services/ollama-outage-fallback.js';
import {tg001Evidence} from '/app/packages/server/dist/services/tg-001.js';
const db=new Database('/data/djimitflo.sqlite',{readonly:true});db.pragma('query_only=ON');db.exec('BEGIN');
const since='2026-10-08T00:00:00.000Z',results={};
function q(name,sql,...params){try{results[name]={sql,params,rows:db.prepare(sql).all(...params)}}catch(e){results[name]={sql,params,error:e.message}}}
const contexts=`WITH ctx AS (SELECT e.loop_run_id,e.created_at,e.metadata,ROW_NUMBER() OVER (PARTITION BY e.loop_run_id ORDER BY e.created_at DESC,e.rowid DESC) ord FROM loop_events e WHERE e.event_type='assignment_context' AND julianday(e.created_at)>=julianday(?)), eligible AS (SELECT e.loop_run_id,r.goal_id,r.loop_name,r.status run_status,s.status proposal_status,e.metadata,
CASE WHEN json_extract(e.metadata,'$.memory_holdout')=1 THEN 'holdout' ELSE 'rules' END arm,
${nonMakerRunSql('e.loop_run_id')} non_maker,
CASE WHEN ${notFallbackRunSql('e.loop_run_id')} THEN 0 ELSE 1 END fallback
FROM ctx e JOIN loop_runs r ON r.id=e.loop_run_id JOIN goals g ON g.id=r.goal_id JOIN self_improvements s ON s.id=g.improvement_id
WHERE e.ord=1 AND (json_extract(e.metadata,'$.memory_holdout')=1 OR json_array_length(json_extract(e.metadata,'$.rule_ids'))>0)) `;
q('assigned_population',contexts+`SELECT arm,proposal_status,non_maker,fallback,COUNT(*) runs,COUNT(DISTINCT goal_id) goals FROM eligible GROUP BY 1,2,3,4`,since);
q('analysed_cluster_sizes',contexts+`SELECT arm,COUNT(*) runs,COUNT(DISTINCT goal_id) goals,SUM(proposal_status='verified') verified,SUM(run_status NOT IN ('completed','ready_for_human_merge') AND proposal_status='verified') verified_proposal_noncompleted_runs FROM eligible WHERE proposal_status IN ('verified','regressed') AND NOT(proposal_status='regressed' AND non_maker=1) AND fallback=0 GROUP BY arm`,since);
q('memory_by_lane',contexts+`SELECT arm,loop_name,COUNT(*) n,SUM(proposal_status='verified') verified,COUNT(DISTINCT goal_id) goals FROM eligible WHERE proposal_status IN ('verified','regressed') AND NOT(proposal_status='regressed' AND non_maker=1) AND fallback=0 GROUP BY 1,2`,since);
q('memory_goal_rows',contexts+`SELECT goal_id,arm,loop_name,COUNT(*) runs,MAX(proposal_status='verified') verified FROM eligible WHERE proposal_status IN ('verified','regressed') AND NOT(proposal_status='regressed' AND non_maker=1) AND fallback=0 GROUP BY 1,2,3`,since);
q('context_crossover',`SELECT COUNT(*) runs_with_both_arms FROM (SELECT loop_run_id FROM loop_events WHERE event_type='assignment_context' AND julianday(created_at)>=julianday(?) GROUP BY loop_run_id HAVING MAX(json_extract(metadata,'$.memory_holdout')=1)=1 AND MAX(COALESCE(json_array_length(json_extract(metadata,'$.rule_ids')),0)>0)=1)`,since);
q('ace_units',"SELECT substr(j.value,13) arm,COUNT(*) outcome_rows,COUNT(DISTINCT o.task_id) task_ids,COUNT(DISTINCT r.goal_id) goals FROM skill_outcomes o JOIN json_each(o.evidence_refs_json) j LEFT JOIN loop_runs r ON r.id=o.task_id WHERE j.value LIKE 'ace-001-arm:%' AND o.skill_id LIKE 'loop-maker:%' AND julianday(o.created_at)>=julianday('2026-10-12') GROUP BY 1");
q('skill_card_survival',"SELECT c.status,CASE WHEN json_extract(r.metadata,'$.pr_outcome.settled_at') IS NULL THEN 'not_recorded_settled' ELSE 'recorded_settled' END settlement,COUNT(*) n FROM skill_cards c JOIN loop_runs r ON r.id=c.run_id GROUP BY 1,2");
q('rule_selection_concentration',"SELECT candidate_id,COUNT(*) reads,COUNT(DISTINCT agent_id) caller_runs,MAX(accessed_at) last_at FROM memory_access_log GROUP BY 1 ORDER BY reads DESC");
q('fleet_signatures',"SELECT mode,verdict,COUNT(*) n,MAX(at) last_at FROM fleet_event_signatures GROUP BY 1,2");
q('fleet_evidence_coverage',"SELECT COUNT(*) n,SUM(json_array_length(evidence_refs_json)>0) evidence_refs,SUM(model IS NOT NULL) model,SUM(tokens_used>0) measured_tokens FROM skill_outcomes WHERE domain='fleet'");
let tg;try{tg=tg001Evidence(db,process.env)}catch(e){tg={error:e.message}}
assert.equal(db.pragma('query_only',{simple:true}),1);db.exec('COMMIT');db.close();
console.log(JSON.stringify({captured_at:new Date().toISOString(),source_sha:process.env.DJIMITFLO_COMMIT_SHA,mode:'readonly + query_only; consistent read transaction',results,tg},null,2));
