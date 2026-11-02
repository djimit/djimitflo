import type { Database } from 'better-sqlite3';
import { HUMAN } from './evolution-lineage';

/**
 * E3: many-to-many provenance DAG with edge evidence — a derived, read-only model over existing rows; nothing is written.
 *
 * Chain: source [discovery | knowledge_gap | operator] → proposal → experiment (loop run) → change (PR) → survival (14 d
 * merge-survival settlement) → capability (not measured). Every edge names the concrete row/field it was read from
 * (`evidence_ref`) and the writer or derivation that produced it (`origin`).
 *
 * UNKNOWN is never inferred: no edge from temporal proximity, title similarity or same-day co-occurrence. A missing link
 * is counted (not_linked) and an answer without evidence is UNKNOWN with a reason — never 0. Requeue copies, refinements
 * and recorded near-duplicates stay distinct proposals joined by explicit edges.
 */
export type NodeKind = 'discovery' | 'expert_unit' | 'expert_claim' | 'knowledge_gap' | 'operator' | 'proposal' | 'loop_run' | 'maker_lease' | 'pr' | 'settlement';
export type EdgeType = 'discovered_as' | 'cites_knowledge' | 'from_knowledge_gap' | 'requeued_by' | 'requeue_of' | 'refinement_of' | 'near_duplicate_of'
  | 'experimented_as' | 'made_by_lease' | 'opened_pr' | 'survived_14d' | 'removed_within_14d' | 'settled_not_scored';
export interface DagEdge {
  edge_type: EdgeType;
  source: { kind: NodeKind; id: string };
  target: { kind: NodeKind; id: string };
  created_at: string | null;
  /** the row/field the edge was read from, `<table>.<field>#<row id>` */
  evidence_ref: string;
  /** the writer (or derivation) that recorded the link */
  origin: string;
}
export type SourceKind = 'discovery' | 'knowledge_gap' | 'operator';
export const PROVENANCE_QUESTIONS = ['sources_by_kind', 'reached_experiment', 'reached_change', 'survived_14d', 'survived_from_discovery', 'survived_from_knowledge_gap',
  'survived_from_operator', 'no_known_source', 'conversion_per_stage', 'median_age_per_stage', 'compute_per_stage', 'operator_decisions_per_stage', 'first_broken_edge'] as const;
export type ProvenanceQuestion = typeof PROVENANCE_QUESTIONS[number];
export interface ProvenanceAnswer { question: ProvenanceQuestion; status: 'ok' | 'UNKNOWN'; value: unknown; reason: string | null }

interface ProposalRow { id: string; source: string; status: string; refs: string | null; approved_by: string | null; refined_from_id: string | null; created_at: string }
interface RunRow { id: string; pid: string; status: string; goal_id: string; created_at: string; updated_at: string; pr_url: string | null; pr_state: string | null;
  merged_at: string | null; settled_at: string | null; survived: number | null; not_scored: string | null }

const LIMIT_IDS = 50;
const KNOWLEDGE = /^(expert_unit|expert_claim):(.+)$/;
const SOURCE_EDGE: Partial<Record<EdgeType, SourceKind>> = { cites_knowledge: 'discovery', from_knowledge_gap: 'knowledge_gap', requeued_by: 'operator' };
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return +s[Math.floor(s.length / 2)].toFixed(1); };
const parseRefs = (s: string | null): string[] => { try { const v = JSON.parse(s ?? '[]') as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } };
const ok = (question: ProvenanceQuestion, value: unknown, reason: string | null = null): ProvenanceAnswer => ({ question, status: 'ok', value, reason });
const unknown = (question: ProvenanceQuestion, reason: string, value: unknown = null): ProvenanceAnswer => ({ question, status: 'UNKNOWN', value, reason });

export function provenanceDag(db: Database, now = Date.now(), opts: { windowDays?: number | null; edgeLimit?: number } = {}) {
  const windowDays = opts.windowDays ?? null;
  const since = windowDays ? new Date(now - windowDays * 86_400_000).toISOString() : '';
  const errors: string[] = [];
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch (e) { errors.push(String(e instanceof Error ? e.message : e).slice(0, 160)); return []; } };
  const days = (t: string | null) => (t ? (now - Date.parse(t)) / 86_400_000 : NaN);

  const proposals = all<ProposalRow>(`SELECT id, source, status, evidence_refs_json AS refs, approved_by, refined_from_id, created_at
    FROM self_improvements WHERE created_at >= ? ORDER BY created_at, id`, since);
  const readable = errors.length === 0;
  const pids = new Set(proposals.map((p) => p.id));
  const edges: DagEdge[] = [];
  const seen = new Set<string>();
  const add = (e: DagEdge) => { const k = `${e.edge_type}|${e.source.kind}:${e.source.id}|${e.target.kind}:${e.target.id}`; if (!seen.has(k)) { seen.add(k); edges.push(e); } };
  const P = (id: string) => ({ kind: 'proposal' as const, id });

  // ---- source → proposal and proposal → proposal, read from evidence_refs_json / refined_from_id ----
  const unitIds = new Set<string>();
  for (const p of proposals) {
    const field = `self_improvements.evidence_refs_json#${p.id}`;
    for (const ref of parseRefs(p.refs)) {
      const k = KNOWLEDGE.exec(ref);
      if (k) { if (k[1] === 'expert_unit') unitIds.add(k[2]); add({ edge_type: 'cites_knowledge', source: { kind: k[1] as NodeKind, id: k[2] }, target: P(p.id), created_at: p.created_at, evidence_ref: `${field}:${ref}`, origin: `proposal writer (source=${p.source})` }); continue; }
      if (ref.startsWith('knowledge-gap:')) { add({ edge_type: 'from_knowledge_gap', source: { kind: 'knowledge_gap', id: ref.slice(14) }, target: P(p.id), created_at: p.created_at, evidence_ref: `${field}:${ref}`, origin: 'curiosity-service → generateFromGaps' }); continue; }
      if (ref.startsWith('requeue-of:')) { add({ edge_type: 'requeue_of', source: P(ref.slice(11)), target: P(p.id), created_at: p.created_at, evidence_ref: `${field}:${ref}`, origin: 'improvement-requeue (D2)' }); continue; }
      // only a human actor is an operator source; an autonomy requeue keeps the requeue_of edge and no operator edge
      if (ref.startsWith('requeue-by:') && HUMAN(ref.slice(11))) { add({ edge_type: 'requeued_by', source: { kind: 'operator', id: ref.slice(11) }, target: P(p.id), created_at: p.created_at, evidence_ref: `${field}:${ref}`, origin: 'improvement-requeue (D2), POST /proposals/:id/requeue' }); continue; }
      if (ref.startsWith('refinement-of:')) add({ edge_type: 'refinement_of', source: P(ref.slice(14)), target: P(p.id), created_at: p.created_at, evidence_ref: `${field}:${ref}`, origin: 'self-improvement-service refinement' });
    }
    if (p.refined_from_id) add({ edge_type: 'refinement_of', source: P(p.refined_from_id), target: P(p.id), created_at: p.created_at, evidence_ref: `self_improvements.refined_from_id#${p.id}`, origin: 'self-improvement-service refinement' });
  }
  // discovery → unit: the unit's own provenance names the discovery ref it was made from
  if (unitIds.size) {
    const ids = [...unitIds];
    for (const u of all<{ id: string; ref: string | null; created_at: string }>(`SELECT id, json_extract(provenance_json, '$.ref') AS ref, created_at FROM expert_identities
        WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)) {
      if (u.ref) add({ edge_type: 'discovered_as', source: { kind: 'discovery', id: u.ref }, target: { kind: 'expert_unit', id: u.id }, created_at: u.created_at, evidence_ref: `expert_identities.provenance_json.ref#${u.id}`, origin: 'expert-source-units-service' });
    }
  }
  // recorded near-duplicate verdicts (proposal-dedupe, shadow): kept as an edge, never merged, never used to trace a source
  for (const j of all<{ id: string; subject_id: string; reason: string | null; created_at: string }>(`SELECT id, subject_id, reason, created_at FROM judgments
      WHERE judgment = 'proposal_near_duplicate' AND subject_type = 'self_improvement' AND decision = 'yes'`)) {
    const other = /similar_to=(\S+)/.exec(j.reason ?? '')?.[1];
    if (other && (pids.has(j.subject_id) || pids.has(other))) add({ edge_type: 'near_duplicate_of', source: P(other), target: P(j.subject_id), created_at: j.created_at, evidence_ref: `judgments#${j.id}`, origin: 'proposal-dedupe (shadow judgment)' });
  }

  // ---- proposal → experiment → change → survival ----
  const runs = all<RunRow>(`SELECT r.id, g.improvement_id AS pid, r.status, g.id AS goal_id, r.created_at, r.updated_at,
      json_extract(r.metadata, '$.pr_url') AS pr_url, json_extract(r.metadata, '$.pr_outcome.state') AS pr_state, json_extract(r.metadata, '$.pr_outcome.merged_at') AS merged_at,
      json_extract(r.metadata, '$.pr_outcome.settled_at') AS settled_at, json_extract(r.metadata, '$.pr_outcome.survived') AS survived,
      json_extract(r.metadata, '$.pr_outcome.not_scored') AS not_scored
    FROM loop_runs r JOIN goals g ON g.id = r.goal_id JOIN self_improvements s ON s.id = g.improvement_id WHERE s.created_at >= ? ORDER BY r.created_at, r.id`, since);
  for (const r of runs) {
    add({ edge_type: 'experimented_as', source: P(r.pid), target: { kind: 'loop_run', id: r.id }, created_at: r.created_at, evidence_ref: `goals.improvement_id#${r.goal_id}+loop_runs.goal_id#${r.id}`, origin: 'autonomous-goal-generator → loop-service' });
    if (r.pr_url) add({ edge_type: 'opened_pr', source: { kind: 'loop_run', id: r.id }, target: { kind: 'pr', id: r.pr_url }, created_at: r.updated_at, evidence_ref: `loop_runs.metadata.pr_url#${r.id}`, origin: 'loop-draft-pr-service' });
    if (r.pr_url && r.settled_at) {
      const type: EdgeType = r.survived === 1 ? 'survived_14d' : r.survived === 0 ? 'removed_within_14d' : 'settled_not_scored';
      add({ edge_type: type, source: { kind: 'pr', id: r.pr_url }, target: { kind: 'settlement', id: r.id }, created_at: r.settled_at, evidence_ref: `loop_runs.metadata.pr_outcome#${r.id}`, origin: 'merge-survival' });
    }
  }
  const runIds = runs.map((r) => r.id);
  const inRuns = runIds.map(() => '?').join(',');
  const leases = runIds.length ? all<{ id: string; loop_run_id: string; role: string; created_at: string; tokens: number | null }>(`SELECT id, loop_run_id, role, created_at,
      json_extract(metadata, '$.runtime_usage.total_tokens') AS tokens FROM worker_leases WHERE loop_run_id IN (${inRuns})`, ...runIds) : [];
  for (const l of leases.filter((x) => x.role === 'maker')) add({ edge_type: 'made_by_lease', source: { kind: 'loop_run', id: l.loop_run_id }, target: { kind: 'maker_lease', id: l.id }, created_at: l.created_at, evidence_ref: `worker_leases.loop_run_id#${l.id}`, origin: 'loop-service maker lease' });

  // ---- tracing (explicit edges only; near-duplicates are never traversed) ----
  const parents = new Map<string, string[]>();
  for (const e of edges) if (e.edge_type === 'requeue_of' || e.edge_type === 'refinement_of') parents.set(e.target.id, [...(parents.get(e.target.id) ?? []), e.source.id]);
  const direct = new Map<string, Map<SourceKind, Set<string>>>();
  for (const e of edges) {
    const kind = SOURCE_EDGE[e.edge_type]; if (!kind) continue;
    const m = direct.get(e.target.id) ?? new Map<SourceKind, Set<string>>(); direct.set(e.target.id, m);
    m.set(kind, (m.get(kind) ?? new Set()).add(`${e.source.kind}:${e.source.id}`));
  }
  const sourcesOf = (pid: string): Set<SourceKind> => {
    const out = new Set<SourceKind>(); const stack = [pid]; const visited = new Set<string>();
    while (stack.length) { const id = stack.pop()!; if (visited.has(id)) continue; visited.add(id);
      for (const k of direct.get(id)?.keys() ?? []) out.add(k); stack.push(...(parents.get(id) ?? [])); }
    return out;
  };
  const traced = new Map(proposals.map((p) => [p.id, sourcesOf(p.id)]));

  // ---- stages per proposal ----
  const runsOf = new Map<string, RunRow[]>();
  for (const r of runs) runsOf.set(r.pid, [...(runsOf.get(r.pid) ?? []), r]);
  const exp = proposals.filter((p) => runsOf.has(p.id));
  const chg = exp.filter((p) => runsOf.get(p.id)!.some((r) => r.pr_url));
  const survivedRuns = runs.filter((r) => r.pr_url && r.settled_at && r.survived === 1);
  const surv = chg.filter((p) => survivedRuns.some((r) => r.pid === p.id));
  const noSource = proposals.filter((p) => traced.get(p.id)!.size === 0);
  const capIds = (xs: Array<{ id: string }>) => xs.slice(0, LIMIT_IDS).map((x) => x.id);

  const answers: ProvenanceAnswer[] = [];
  // 1 sources by kind
  const byKind = Object.fromEntries((['discovery', 'knowledge_gap', 'operator'] as SourceKind[]).map((k) => {
    const srcs = new Set<string>(); const props = new Set<string>();
    for (const [pid, m] of direct) if (pids.has(pid) && m.has(k)) { props.add(pid); for (const s of m.get(k)!) srcs.add(s); }
    return [k, { sources: srcs.size, proposals: props.size }];
  }));
  answers.push(ok('sources_by_kind', byKind, 'distinct source nodes with an explicit edge to a proposal of the window; writer field self_improvements.source is not an upstream source'));
  // 2–4
  answers.push(ok('reached_experiment', { count: exp.length, of: proposals.length, proposal_ids: capIds(exp) }, 'experiment = a loop run of the proposal\'s goal; gym trials carry no proposal link (see not_linked)'));
  answers.push(ok('reached_change', { count: chg.length, of: proposals.length, proposal_ids: capIds(chg) }, 'change = a PR recorded on a run (loop_runs.metadata.pr_url)'));
  answers.push(survivedRuns.length || runs.some((r) => r.settled_at)
    ? ok('survived_14d', { count: survivedRuns.length, prs: [...new Set(survivedRuns.map((r) => r.pr_url!))].slice(0, LIMIT_IDS) })
    : unknown('survived_14d', 'no merge-survival settlement recorded yet', { count: null }));
  // 5–7 survived changes traced back to a source kind
  for (const [q, kind] of [['survived_from_discovery', 'discovery'], ['survived_from_knowledge_gap', 'knowledge_gap'], ['survived_from_operator', 'operator']] as Array<[ProvenanceQuestion, SourceKind]>) {
    if (!survivedRuns.length) { answers.push(unknown(q, 'no change has survived 14 d yet — nothing to trace')); continue; }
    const hits = survivedRuns.filter((r) => traced.get(r.pid)?.has(kind));
    const untraced = survivedRuns.filter((r) => !traced.get(r.pid)?.size).length;
    answers.push(ok(q, { count: hits.length, of_survived: survivedRuns.length, untraced_survived: untraced, prs: hits.map((r) => r.pr_url!).slice(0, LIMIT_IDS) },
      untraced ? `${untraced} survived change(s) have no recorded upstream source — UNKNOWN, not counted for any kind` : null));
  }
  // 8 no known source
  const byWriter: Record<string, number> = {};
  for (const p of noSource) byWriter[p.source] = (byWriter[p.source] ?? 0) + 1;
  answers.push(ok('no_known_source', { count: noSource.length, of: proposals.length, by_writer: byWriter },
    'no discovery / knowledge-gap / operator edge on the proposal or its requeue/refinement ancestors; historical rows included, never back-filled'));
  // 9 conversion per stage
  const conv = (a: number, b: number) => (b ? +(a / b).toFixed(3) : null);
  answers.push(ok('conversion_per_stage', [
    { stage: 'proposal', count: proposals.length, conversion: null, note: `source → proposal is not a ratio: ${noSource.length} of ${proposals.length} proposals have no recorded source` },
    { stage: 'experiment', count: exp.length, conversion: conv(exp.length, proposals.length) },
    { stage: 'change', count: chg.length, conversion: conv(chg.length, exp.length) },
    { stage: 'survived_14d', count: surv.length, conversion: conv(surv.length, chg.length) },
    { stage: 'capability', count: null, conversion: null, note: 'not_measured' },
  ]));
  // 10 median age (days) of the proposals waiting at each stage since they reached it
  const lastRun = (pid: string) => runsOf.get(pid)!.at(-1)!;
  const prRun = (pid: string) => runsOf.get(pid)!.filter((r) => r.pr_url).at(-1)!;
  const ages = {
    proposal: median(proposals.filter((p) => !runsOf.has(p.id)).map((p) => days(p.created_at)).filter(Number.isFinite)),
    experiment: median(exp.filter((p) => !chg.includes(p)).map((p) => days(lastRun(p.id).created_at)).filter(Number.isFinite)),
    change: median(chg.filter((p) => !surv.includes(p)).map((p) => { const r = prRun(p.id); return days(r.merged_at ?? r.updated_at); }).filter(Number.isFinite)),
    survived_14d: null,
  };
  answers.push(Object.values(ages).some((v) => v !== null) ? ok('median_age_per_stage', ages, 'change age counts from merged_at, or the run\'s last update while unmerged; survived is terminal')
    : unknown('median_age_per_stage', 'no proposal is waiting at any stage', ages));
  // 11 compute (tokens) per stage — lease runtime_usage of the runs that reached the stage, judgment tokens on the proposals
  const tok = (ids: Set<string>) => { const xs = leases.filter((l) => ids.has(l.loop_run_id) && l.tokens !== null).map((l) => Number(l.tokens)); return xs.length ? xs.reduce((a, b) => a + b, 0) : null; };
  const judgTok = pids.size ? all<{ n: number | null; c: number }>(`SELECT SUM(input_tokens + output_tokens) AS n, COUNT(*) AS c FROM judgments WHERE subject_type = 'self_improvement'
      AND (input_tokens + output_tokens) > 0 AND subject_id IN (SELECT id FROM self_improvements WHERE created_at >= ?)`, since)[0] : undefined;
  const compute = {
    proposal: judgTok?.c ? Number(judgTok.n) : null,
    experiment: tok(new Set(runs.map((r) => r.id))),
    change: tok(new Set(runs.filter((r) => r.pr_url).map((r) => r.id))),
    survived_14d: tok(new Set(survivedRuns.map((r) => r.id))),
  };
  answers.push(Object.values(compute).some((v) => v !== null) ? ok('compute_per_stage', compute, 'null = no token record at that stage, never 0')
    : unknown('compute_per_stage', 'no token usage recorded on any lease or proposal judgment'));
  // 12 operator decisions per stage where recorded
  const humanApproved = proposals.filter((p) => HUMAN(p.approved_by)).length;
  const labels = pids.size ? all<{ n: number }>(`SELECT COUNT(*) AS n FROM judgments WHERE judgment = 'operator_label' AND subject_type = 'self_improvement'
      AND subject_id IN (SELECT id FROM self_improvements WHERE created_at >= ?)`, since)[0]?.n ?? 0 : 0;
  const runApprovals = runIds.length ? all<{ decided_by: string | null }>(`SELECT a.decided_by FROM approvals a LEFT JOIN tasks t ON t.id = a.task_id
      WHERE a.status IN ('approved', 'denied') AND COALESCE(json_extract(a.metadata, '$.loop_run_id'), json_extract(t.metadata, '$.loop_run_id')) IN (${inRuns})`, ...runIds) : [];
  const ops = { proposal: humanApproved + labels, experiment: runApprovals.filter((a) => HUMAN(a.decided_by)).length, change: null as number | null, survived_14d: null as number | null };
  answers.push(proposals.length ? ok('operator_decisions_per_stage', ops, 'proposal = human approved_by + operator labels; experiment = human approvals on the runs; change: who merged is not recorded; survival settles automatically')
    : unknown('operator_decisions_per_stage', 'no proposals', ops));
  // 13 first broken edge: the largest drop between measured stages whose cause is recorded (the status where lineages stopped)
  const top = (xs: string[]) => { if (!xs.length) return null; const c = new Map<string, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); const [k, n] = [...c.entries()].sort((a, b) => b[1] - a[1])[0]; return `${k} (${n})`; };
  const transitions = [
    { from: 'proposal', to: 'experiment', lost: proposals.length - exp.length, cause: top(proposals.filter((p) => !runsOf.has(p.id)).map((p) => p.status)) },
    { from: 'experiment', to: 'change', lost: exp.length - chg.length, cause: top(exp.filter((p) => !chg.includes(p)).map((p) => `run:${lastRun(p.id).status}`)) },
    { from: 'change', to: 'survived_14d', lost: chg.length - surv.length, cause: top(chg.filter((p) => !surv.includes(p)).map((p) => { const r = prRun(p.id); return r.settled_at ? (r.survived === 0 ? 'removed_or_reverted' : 'not_scored') : r.pr_state === 'merged' ? 'within_14d_survival_window' : `pr:${r.pr_state ?? 'unchecked'}`; })) },
  ];
  const worst = transitions.filter((t) => t.lost > 0 && t.cause).sort((a, b) => b.lost - a.lost)[0];
  answers.push(worst ? ok('first_broken_edge', worst, 'largest drop with a recorded cause; source → proposal is not_linked (see no_known_source), capability is not_measured')
    : unknown('first_broken_edge', 'no drop with a recorded cause between measured stages'));

  // an unreadable proposal table answers nothing: every count would be a made-up 0
  if (!readable) answers.splice(0, answers.length, ...PROVENANCE_QUESTIONS.map((q) => unknown(q, 'self_improvements is unreadable')));
  const edgeCounts: Record<string, number> = {};
  for (const e of edges) edgeCounts[e.edge_type] = (edgeCounts[e.edge_type] ?? 0) + 1;
  const count = (sql: string): number | null => { const r = all<{ n: number }>(sql)[0]; return r ? r.n : null; };
  const limit = opts.edgeLimit ?? 2000;
  return {
    at: new Date(now).toISOString(), window_days: windowDays, proposals: proposals.length, edge_counts: edgeCounts, edges_total: edges.length,
    edges_truncated: edges.length > limit, edges: edges.slice(0, limit), answers,
    not_linked: {
      proposals_without_source: noSource.length,
      /** gym trials test genomes, not proposals: no column links a trial to a proposal */
      gym_trials: count('SELECT COUNT(*) AS n FROM genome_trial_results'),
      /** discovery units no proposal cites (expert_identities with a discovery ref in provenance) */
      discovery_units_uncited: (() => { const r = all<{ id: string }>("SELECT id FROM expert_identities WHERE json_extract(provenance_json, '$.ref') IS NOT NULL");
        return errors.length && !r.length ? null : r.filter((u) => !unitIds.has(u.id)).length; })(),
      note: 'memory_access_log rows name a memory candidate and an agent, never a proposal or run — not an edge source; knowledge_gaps has no table, gaps arrive as knowledge-gap:<domain> refs',
    },
    capability: { status: 'not_measured' as const, reason: 'no record links a surviving change to a capability effect' },
    errors,
  };
}

/** evolution-evidence section: the DAG without its edge list */
export function provenanceSummary(db: Database, now = Date.now()) {
  const { edges, edges_truncated, ...rest } = provenanceDag(db, now, { edgeLimit: 0 });
  void edges; void edges_truncated;
  return rest;
}
