// Run via: ssh vps-agentical 'docker exec -i djimitflo-live node --input-type=module' < this-file
// Read-only aggregates only: no credentials, descriptions, prompts, or user records are exported.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
const db = new Database('/data/djimitflo.sqlite', { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');
const now = new Date();
const since = (days) => new Date(now.getTime() - days * 86400000).toISOString();
const results = {};
function query(name, sql, ...params) {
  try { results[name] = { sql, params, rows: db.prepare(sql).all(...params) }; }
  catch (e) { results[name] = { sql, params, error: e.message }; }
}
query('proposal_statuses', 'SELECT status, COUNT(*) n FROM self_improvements GROUP BY status');
query('panel_decisions', "SELECT json_extract(consensus_json, '$.decision') decision,COUNT(*) n FROM specialist_panels WHERE consensus_json IS NOT NULL GROUP BY 1");
query('panel_links', 'SELECT COUNT(panel_id) proposal_links,COUNT(DISTINCT panel_id) distinct_panels FROM self_improvements');
query('unreferenced_panels', "SELECT json_extract(p.consensus_json, '$.decision') decision,COUNT(*) n FROM specialist_panels p WHERE NOT EXISTS (SELECT 1 FROM self_improvements s WHERE s.panel_id=p.id) GROUP BY 1");
query('refinement_statuses', 'SELECT status,COUNT(*) n FROM self_improvements WHERE refined_from_id IS NOT NULL GROUP BY status');
query('refinement_goal_links', 'SELECT g.status,COUNT(*) goals,COUNT(DISTINCT s.id) children FROM goals g JOIN self_improvements s ON s.id=g.improvement_id WHERE s.refined_from_id IS NOT NULL GROUP BY g.status');
query('refinement_links_all', 'SELECT COUNT(*) goals,COUNT(DISTINCT s.id) children FROM goals g JOIN self_improvements s ON s.id=g.improvement_id WHERE s.refined_from_id IS NOT NULL');
query('funnel_yield_exact_iso', 'SELECT status,COUNT(*) n FROM self_improvements WHERE updated_at>=? GROUP BY status', since(7));
query('panel_created_24h_exact_iso', 'SELECT COUNT(*) n FROM specialist_panels WHERE created_at>=?', since(1));
query('reviews_24h_exact_iso', 'SELECT COUNT(*) n,COUNT(DISTINCT panel_id) panels FROM specialist_reviews WHERE created_at>=?', since(1));
query('panel_created_7d_exact_iso', 'SELECT COUNT(*) n FROM specialist_panels WHERE created_at>=?', since(7));
query('verification_hours', "SELECT (julianday(updated_at)-julianday(created_at))*24 hours FROM self_improvements WHERE status IN ('verified','evaluating','applied') AND updated_at>=? AND updated_at>created_at ORDER BY hours", since(30));
const hours = results.verification_hours.rows?.map(r => r.hours) ?? [];
results.verification_hours.summary = { n: hours.length, median_upper: hours.length ? hours[Math.floor(hours.length/2)] : null };
query('episodes', 'SELECT COUNT(*) rows,COUNT(DISTINCT loop_run_id) unique_runs FROM cognitive_episodes');
query('open_work', "SELECT status,COUNT(*) n FROM work_items WHERE status IN ('candidate','triaged','planned','leased','blocked') GROUP BY status");
query('open_work_groups', "SELECT COALESCE(recommended_loop,'none') loop,status,COUNT(*) n FROM work_items WHERE status IN ('candidate','triaged','planned','leased','blocked') GROUP BY 1,2 ORDER BY n DESC");
query('goal_statuses', 'SELECT status,COUNT(*) n FROM goals GROUP BY status');
query('run_statuses', 'SELECT status,COUNT(*) n FROM loop_runs GROUP BY status');
query('future_proposals', 'SELECT COUNT(*) n FROM self_improvements WHERE julianday(created_at)>julianday(?)', now.toISOString());
query('future_runs', 'SELECT COUNT(*) n FROM loop_runs WHERE julianday(created_at)>julianday(?)', now.toISOString());
query('event_semantics', "SELECT event_type,COUNT(*) n FROM execution_events WHERE message LIKE '%step finished: tool-calls%' GROUP BY event_type");
query('governance_scales', 'SELECT agent_id,COUNT(*) runs,MIN(overall_score) min_score,MAX(overall_score) max_score,MAX(finished_at) last_finished FROM openmythos_eval_runs WHERE status=? GROUP BY agent_id ORDER BY max_score DESC', 'completed');
query('governance_critic_latest', 'SELECT id,agent_id,overall_score,total_cases,completed_cases,judge_model,finished_at FROM openmythos_eval_runs WHERE agent_id=? ORDER BY finished_at DESC LIMIT 1', 'explainer-critic');
query('audit_resource_types', 'SELECT resource_type,COUNT(*) n FROM audit_events GROUP BY resource_type ORDER BY n DESC');
query('health_window_source', "SELECT status,COUNT(*) n FROM loop_runs WHERE created_at>datetime('now','-24 hours') GROUP BY status");
query('health_window_normalized', "SELECT status,COUNT(*) n FROM loop_runs WHERE julianday(created_at)>julianday(?) GROUP BY status", since(1));
query('stale_leases_source', "SELECT COUNT(*) n FROM worker_leases WHERE status IN ('running','prepared') AND updated_at<datetime('now','-1 hour')");
query('stale_leases_normalized', "SELECT COUNT(*) n FROM worker_leases WHERE status IN ('running','prepared') AND julianday(updated_at)<julianday(?)", new Date(now.getTime()-3600000).toISOString());
query('model_activity', 'SELECT consumer,provider,model,COUNT(*) calls,SUM(ok) ok,ROUND(AVG(latency_ms)) mean_latency_ms,MAX(created_at) last_activity,MAX(CASE WHEN ok=1 THEN created_at END) last_success,MAX(CASE WHEN ok=0 THEN created_at END) last_failure FROM llm_model_calls WHERE created_at>=? GROUP BY consumer,provider,model ORDER BY calls DESC', since(7));
for (const table of ['agents','registry_agents','agent_skills','skill_cards','sub_agent_spawns','workflows','workflow_nodes','federation_peers','external_events','event_outbox','runtime_contract_probes','fleet_hosts','mcp_servers','mcp_tools','audit_events','authority_events','genome_trial_results','tg_experiments','knowledge_claims','vector_memories']) {
  query(`count_${table}`, `SELECT COUNT(*) n FROM ${table}`);
}
assert.equal(db.pragma('query_only', {simple:true}), 1);
assert(results.proposal_statuses.rows?.length > 0);
assert(results.panel_decisions.rows?.every(r => r.n >= 0));
db.close();
console.log(JSON.stringify({ captured_at: now.toISOString(), db_mode: 'readonly + query_only', results }, null, 2));
