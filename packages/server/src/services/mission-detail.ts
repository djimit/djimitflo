import type { Database } from 'better-sqlite3';
import { SwarmIntelligenceService } from './swarm-intelligence-service';
import { usageEvents } from './cost-ledger';
import { summarizeUsage } from './swarm-learning-curve';
import { provenanceDag, type DagEdge } from './provenance-dag';

/**
 * Mission detail (read-only): one swarm mission joined to what the existing records say about it — the SW-02 execution
 * join, the goal's loop runs with their recorded gates, next actions, learning closure and outcome attribution, the leases
 * that took part, the mission's tasks and decisions, cost-ledger tokens of its runs and the provenance edges touching them.
 * Nothing is written and nothing is inferred: a blocker or next action is only returned with the row it was read from;
 * absent records are null (unknown), never 0.
 */
const parse = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; } };
const safe = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };

interface RunRow { id: string; loop_name: string; status: string; created_at: string; updated_at: string; completed_at: string | null; gates_json: string | null; next_actions_json: string | null }

export function missionDetail(db: Database, id: string, now = Date.now()) {
  const svc = new SwarmIntelligenceService(db);
  const mission = svc.getMission(id); // throws SWARM_MISSION_NOT_FOUND
  const execution = svc.missionExecution(id);
  const goal = execution.lineage === 'linked' && mission.goal_id
    ? db.prepare('SELECT id, objective, status, updated_at FROM goals WHERE id = ?').get(mission.goal_id) as { id: string; objective: string; status: string; updated_at: string }
    : null;
  const runRows = goal ? db.prepare(`SELECT id, loop_name, status, created_at, updated_at, completed_at, gates_json, next_actions_json FROM loop_runs
    WHERE goal_id = ? ORDER BY created_at DESC, id DESC`).all(goal.id) as RunRow[] : [];
  const ids = JSON.stringify(runRows.map((r) => r.id));
  const runIds = new Set(runRows.map((r) => r.id));

  const closures = new Map(safe(() => db.prepare(`SELECT loop_run_id, eval_run_id, score_delta, created_at FROM loop_learning_closures
    WHERE loop_run_id IN (SELECT value FROM json_each(?))`).all(ids) as Array<{ loop_run_id: string; eval_run_id: string; score_delta: number | null; created_at: string }>, []).map((c) => [c.loop_run_id, c]));
  // newest run-level outcome_attribution judgment per run (operator annotations live on the proposal and are not shown here)
  const attribution = new Map<string, { outcome: string; reason: string | null; created_at: string; judgment_id: string }>();
  for (const j of safe(() => db.prepare(`SELECT id, subject_id, decision, reason, created_at FROM judgments WHERE judgment = 'outcome_attribution' AND subject_type = 'loop_run'
    AND subject_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC, id DESC`).all(ids) as Array<{ id: string; subject_id: string; decision: string; reason: string | null; created_at: string }>, [])) {
    if (!attribution.has(j.subject_id)) attribution.set(j.subject_id, { outcome: j.decision, reason: j.reason, created_at: j.created_at, judgment_id: j.id });
  }
  const leases = safe(() => db.prepare(`SELECT id, loop_run_id, role, runtime, status, created_at, json_extract(metadata, '$.verdict') AS verdict,
      json_extract(metadata, '$.maker_lease_id') AS maker_lease_id FROM worker_leases WHERE loop_run_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, id`).all(ids) as Array<{
      id: string; loop_run_id: string; role: string; runtime: string; status: string; created_at: string; verdict: string | null; maker_lease_id: string | null }>, []);

  const runs = runRows.map((r) => ({
    id: r.id, loop_name: r.loop_name, status: r.status, created_at: r.created_at, updated_at: r.updated_at, completed_at: r.completed_at,
    failed_gates: parse<Array<{ name?: unknown; status?: unknown }>>(r.gates_json, []).filter((g) => g?.status === 'fail' && typeof g.name === 'string').map((g) => String(g.name)),
    next_actions: parse<unknown[]>(r.next_actions_json, []).filter((a): a is string => typeof a === 'string' && a.trim().length > 0),
    closure: closures.get(r.id) ?? null,
    attribution: attribution.get(r.id) ?? null,
  }));
  const tasks = svc.listTasks(id).map((t) => ({ id: t.id, title: t.title, status: t.status, assigned_lease_id: t.assigned_lease_id, capability_id: t.capability_id }));
  const decisions = svc.listDecisions(id, 50).map((d) => ({ id: d.id, task_id: d.task_id, decision_type: d.decision_type, decision: d.decision, reason: d.reason, actor: d.actor, blocked_reasons: d.blocked_reasons, created_at: d.created_at }));

  // current blocker: only what a record states — the newest decision's blocked reasons, else failed gates of a blocked/failed latest run
  const latest = runs[0] ?? null;
  const newestDecision = decisions[0];
  const blocker = newestDecision?.blocked_reasons.length
    ? { text: newestDecision.blocked_reasons.join('; '), source: `swarm_decisions.blocked_reasons_json#${newestDecision.id}` }
    : latest && ['blocked', 'failed', 'escalated'].includes(latest.status) && latest.failed_gates.length
      ? { text: `failed gates: ${latest.failed_gates.join(', ')}`, source: `loop_runs.gates_json#${latest.id}` }
      : null;
  const nextAction = latest?.next_actions.length ? { items: latest.next_actions, source: `loop_runs.next_actions_json#${latest.id}` } : null;

  // tokens: cost-ledger usage events (the /swarms/usage-window source) whose run is one of this mission's runs
  const since = runRows.length ? runRows.reduce((min, r) => (r.created_at < min ? r.created_at : min), runRows[0].created_at) : null;
  const tokens = since ? summarizeUsage(usageEvents(db, since, new Date(now + 1).toISOString(), { now }).events.filter((e) => e.run_id !== null && runIds.has(e.run_id))).tokens : null;

  // provenance edges touching the runs, plus the edges into the proposal a run experimented (E3 DAG, all history)
  let provenance: DagEdge[] = [];
  if (runIds.size) {
    const edges = provenanceDag(db, now, { edgeLimit: Number.MAX_SAFE_INTEGER }).edges;
    const touches = (e: DagEdge) => (e.source.kind === 'loop_run' && runIds.has(e.source.id)) || ((e.target.kind === 'loop_run' || e.target.kind === 'settlement') && runIds.has(e.target.id));
    const direct = edges.filter(touches);
    const proposals = new Set(direct.filter((e) => e.edge_type === 'experimented_as').map((e) => e.source.id));
    provenance = [...direct, ...edges.filter((e) => !touches(e) && e.target.kind === 'proposal' && proposals.has(e.target.id))];
  }

  return {
    mission: { id: mission.id, title: mission.title, description: mission.description, risk_class: mission.risk_class, planning_status: mission.status,
      goal_id: mission.goal_id, panel_id: mission.panel_id, evidence_refs: mission.evidence_refs, created_at: mission.created_at, updated_at: mission.updated_at },
    execution, goal, runs, leases, tasks, decisions, blocker, next_action: nextAction, tokens, provenance,
    note: 'read-only; planning_status is advisory and never transitioned here; blocker and next_action are null unless a record states them; tokens are null without linked runs',
  };
}
