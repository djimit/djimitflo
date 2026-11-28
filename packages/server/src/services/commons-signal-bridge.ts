import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { failureSignature } from './commons-failure-recurrence';
import { SENSITIVE } from './commons-grounding';
import { runReceipt, staleRunningMs, type ExecutionReceipt } from './execution-receipt';
import { MemoryCandidateService } from './memory-candidate-service';
import { guardTick, markRun, noteScheduler } from './scheduler-registry';

/**
 * Commons signal-to-goal bridge. COMMONS_SIGNAL_BRIDGE_MODE = off (default) | shadow | on.
 *
 *   recurring records (leases, loop runs, skill outcomes, memory candidates, project-room calls, Commons messages)
 *   → one deduplicated signal card with evidence refs            (a `commons_signal` judgment; no new store)
 *   → the EXISTING Commons round discusses it                    (agent_messages, topic_ref `signal:<signature>`)
 *   → the EXISTING learning → proposal → grounding → panel → approval path
 *   → the goal carries where it came from                        (metadata.commons_signal, source `commons_signal`)
 *   → optionally the EXISTING project room                       (COMMONS_SIGNAL_PROJECT_ROOM=on, only after the gate)
 *   → the EXISTING maker / checks / checker
 *   → an execution receipt decides what may be learned           (execution-receipt.ts: verified | failed | unknown)
 *   → a review-gated memory / skill candidate                    (MemoryCandidateService; promotion stays where it is)
 *
 * What is new is only the connection. Goals, task status, routing, budgets, leases, retries, cancellation, memory and skill
 * promotion, approval and merge stay with their existing owners; this file starts no model call and executes nothing.
 *
 *   off     nothing here runs; every caller checks the mode first.
 *   shadow  cards, the goal metadata a goal would have carried, gate verdicts, stale traces and outcomes are recorded as
 *           judgments. No question is posted, no goal, proposal, task or memory candidate is touched.
 *   on      a card becomes a Commons topic; a goal from a signal carries its source; a signal goal without a grounded,
 *           non-protected target and test is not created (the proposal is parked); outcomes become review-gated candidates.
 *
 * A card is a hypothesis: its text is built from identifiers and enum values of the records, never from free text an agent
 * or a failing process wrote, so nothing in a card can instruct a resident. Evidence that does not resolve to a record is
 * dropped; a card without evidence is `insufficient_evidence` and is never discussed. Signals about auth, secrets or deploy
 * are `operator_only`. A goal whose target is a gate, a verifier or anything a reviewer reads is refused: agents do not
 * change their own acceptance criteria.
 */
export type BridgeMode = 'off' | 'shadow' | 'on';
export const signalBridgeMode = (env: NodeJS.ProcessEnv = process.env): BridgeMode => (env.COMMONS_SIGNAL_BRIDGE_MODE === 'on' ? 'on' : env.COMMONS_SIGNAL_BRIDGE_MODE === 'shadow' ? 'shadow' : 'off');
/** off (default) | on: a signal goal that passed the gate is routed through the project room (which keeps its own mode). */
export const signalProjectRoom = (env: NodeJS.ProcessEnv = process.env): boolean => env.COMMONS_SIGNAL_PROJECT_ROOM === 'on';

export const SIGNAL_WINDOW_DAYS = 7;
/** a kind seen once is an incident, not a signal */
export const SIGNAL_MIN_COUNT = 2;
const MAX_REFS = 5;
const DAY = 86_400_000;
/** Protected paths of AGENTS.md that decide outcomes: a signal goal never targets them (on top of commons-grounding SENSITIVE). */
const OWN_CRITERIA = /(loop-verification-service|authority-gate|governance-gate-service|objective-loop-gate|skill-training-promotion-gate|genome-promotion|loop-auto-merge|runtime-admission|authorization-service|auth-service|commons-signal-bridge|execution-receipt|specialist-panel|judgments\/|checker|merge-train|NEGATIVE_EVIDENCE|core-invariants|SOUL\.md|USER\.md|AGENTS\.md|Dockerfile|docker-entrypoint|scripts\/systemd)/i;

type Json = Record<string, unknown>;
const json = (text: unknown): Json => { try { const v = JSON.parse(String(text ?? '')) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}; } catch { return {}; } };
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** identifiers and enum values only: anything else in a key is replaced, so a card cannot carry prose or a secret */
const token = (v: unknown, max = 60): string => String(v ?? 'unknown').replace(/[^A-Za-z0-9_.:+-]/g, '_').slice(0, max) || 'unknown';
const rows = <T>(db: Database, sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } }; // a table missing on this schema is no signal, not an error

export type SignalSource = 'trace' | 'loop' | 'skill' | 'memory' | 'project_room' | 'commons';
export type SignalDisposition = 'card' | 'insufficient_evidence' | 'operator_only';
export interface SignalCard {
  version: 1; signature: string; source: SignalSource; kind: string; title: string;
  count: number; first_seen: string; last_seen: string; evidence_refs: string[];
  /** a card never claims more than that something recurred */
  status: 'hypothesis'; disposition: SignalDisposition;
  /** the failure agenda's signature for loop signals, so both agendas see the same kind as discussed */
  failure_signature?: string;
}

/** `<prefix>:<id>` → the table whose row must exist. A prefix not listed here is not evidence. */
const REF_TABLES: Record<string, string> = { lease: 'worker_leases', run: 'loop_runs', skill_outcome: 'skill_outcomes', memory_candidate: 'memory_candidates', project_room_call: 'project_room_calls', message: 'agent_messages', task: 'tasks' };
export function resolveRef(db: Database, ref: string): boolean {
  const at = ref.indexOf(':');
  const table = REF_TABLES[ref.slice(0, at)];
  if (at < 1 || !table) return false;
  try { return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE id = ? LIMIT 1`).get(ref.slice(at + 1))); } catch { return false; }
}

export const signalSignature = (source: SignalSource, kind: string): string => createHash('sha256').update(`${source}\0${kind}`).digest('hex').slice(0, 24);

interface Hit { source: SignalSource; kind: string; title: string; ref: string; at: string; failure_signature?: string }

/** Everything that recurred in the window, one card per (source, kind). Read-only. */
export function collectSignals(db: Database, now = Date.now()): SignalCard[] {
  const since = new Date(now - SIGNAL_WINDOW_DAYS * DAY).toISOString();
  const hits: Hit[] = [];
  // traces: how leases ended (lease-failure.ts writes one structured `failure` on every failed or cancelled lease)
  for (const r of rows<{ id: string; role: string; runtime: string; metadata: string; updated_at: string }>(db, "SELECT id, role, runtime, metadata, updated_at FROM worker_leases WHERE status = 'failed' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 500", since)) {
    const f = json(JSON.stringify(json(r.metadata).failure ?? {}));
    const kind = [r.role, r.runtime, f.stage, f.timed_out === true ? 'timeout' : f.stderr_class].map((v) => token(v)).join('|');
    hits.push({ source: 'trace', kind, title: `${token(r.role)} leases on ${token(r.runtime)} fail at ${token(f.stage)} (${token(f.timed_out === true ? 'timeout' : f.stderr_class)})`, ref: `lease:${r.id}`, at: r.updated_at });
  }
  // loop runs: the dream state's failure causes, by the failure agenda's own signature
  for (const r of rows<{ run_id: string; reason: string | null; created_at: string; loop_name: string; gates_json: string | null }>(db, `SELECT j.subject_id AS run_id, j.reason, j.created_at, r.loop_name, r.gates_json
      FROM judgments j JOIN loop_runs r ON r.id = j.subject_id WHERE j.judgment = 'failure_cause' AND j.subject_type = 'loop_run' AND j.created_at >= ? ORDER BY j.created_at DESC LIMIT 500`, since)) {
    const sig = failureSignature(r.loop_name, r.gates_json, r.reason);
    hits.push({ source: 'loop', kind: token(sig, 160), title: `${token(r.loop_name)} runs fail with ${token(sig.split('|').slice(1).join(' / '), 120)}`, ref: `run:${r.run_id}`, at: r.created_at, failure_signature: sig });
  }
  for (const r of rows<{ id: string; skill_id: string; created_at: string }>(db, 'SELECT id, skill_id, created_at FROM skill_outcomes WHERE success = 0 AND created_at >= ? ORDER BY created_at DESC LIMIT 500', since)) {
    hits.push({ source: 'skill', kind: token(r.skill_id), title: `skill ${token(r.skill_id)} does not succeed`, ref: `skill_outcome:${r.id}`, at: r.created_at });
  }
  for (const r of rows<{ id: string; memory_type: string; store: string; updated_at: string }>(db, "SELECT id, memory_type, store, updated_at FROM memory_candidates WHERE status = 'rejected' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 500", since)) {
    hits.push({ source: 'memory', kind: `${token(r.memory_type)}|${token(r.store)}`, title: `${token(r.memory_type)} memory candidates (${token(r.store)}) are rejected in review`, ref: `memory_candidate:${r.id}`, at: r.updated_at });
  }
  for (const r of rows<{ id: string; profile: string; status: string; error: string | null; started_at: string }>(db, "SELECT id, profile, status, error, started_at FROM project_room_calls WHERE status IN ('failed', 'unknown', 'refused') AND started_at >= ? ORDER BY started_at DESC LIMIT 500", since)) {
    const code = /^[A-Z][A-Z0-9_]{3,}/.exec(r.error ?? '')?.[0] ?? 'no_code';
    hits.push({ source: 'project_room', kind: `${token(r.profile)}|${token(r.status)}|${token(code)}`, title: `project room ${token(r.profile)} calls end ${token(r.status)} (${token(code)})`, ref: `project_room_call:${r.id}`, at: r.started_at });
  }
  // Commons / interaction board: questions nobody answered before they expired
  for (const r of rows<{ id: string; to_agent: string; timestamp: string }>(db, "SELECT id, to_agent, timestamp FROM agent_messages WHERE status = 'expired' AND json_extract(payload_json, '$.action') = 'social.question' AND timestamp >= ? ORDER BY timestamp DESC LIMIT 500", since)) {
    hits.push({ source: 'commons', kind: `unanswered|${token(r.to_agent)}`, title: `Commons questions to ${token(r.to_agent)} expire unanswered`, ref: `message:${r.id}`, at: r.timestamp });
  }

  const groups = new Map<string, Hit[]>();
  for (const h of hits) { const k = `${h.source}\0${h.kind}`; groups.set(k, [...(groups.get(k) ?? []), h]); }
  const cards: SignalCard[] = [];
  for (const group of groups.values()) {
    if (group.length < SIGNAL_MIN_COUNT) continue;
    const [first] = group;
    const times = group.map((h) => h.at).sort();
    const evidence = [...new Set(group.map((h) => h.ref))].filter((ref) => resolveRef(db, ref)).slice(0, MAX_REFS);
    cards.push({
      version: 1, signature: signalSignature(first.source, first.kind), source: first.source, kind: first.kind, title: first.title,
      count: group.length, first_seen: times[0], last_seen: times.at(-1)!, evidence_refs: evidence, status: 'hypothesis',
      disposition: SENSITIVE.test(first.kind.replace(/[|_]/g, '/')) || /(^|[|_/.-])(auth|secret|deploy|token|credential)/i.test(first.kind) ? 'operator_only' : evidence.length ? 'card' : 'insufficient_evidence',
      ...(first.failure_signature ? { failure_signature: first.failure_signature } : {}),
    });
  }
  return cards.sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}

const judge = (db: Database, judgment: string, subjectType: string, subjectId: string, stateHash: string, mode: BridgeMode, decision: string, reason: string, answers: unknown, now: number) => db
  .prepare('INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(randomUUID(), judgment, subjectType, subjectId, stateHash, mode, decision, reason.slice(0, 300), JSON.stringify(answers), new Date(now).toISOString());
const judged = (db: Database, judgment: string, subjectId: string, since?: string, mode?: BridgeMode): boolean => {
  try { return Boolean(db.prepare(`SELECT 1 FROM judgments WHERE judgment = ? AND subject_id = ?${since ? ' AND created_at >= ?' : ''}${mode ? ' AND mode = ?' : ''} LIMIT 1`).get(...[judgment, subjectId, ...(since ? [since] : []), ...(mode ? [mode] : [])])); } catch { return false; }
};

/**
 * One `commons_signal` judgment per signature per window and mode: recording the same kind again is a no-op. Returns the new
 * cards. Per mode, because a card recorded in shadow is never acted on: after a switch to `on` the kind is recorded again as an
 * `on` row, and only those become topics or feed the goal gate.
 */
export function recordSignalCards(db: Database, cards: SignalCard[], mode: BridgeMode, now = Date.now()): SignalCard[] {
  if (mode === 'off') return [];
  const since = new Date(now - SIGNAL_WINDOW_DAYS * DAY).toISOString();
  return db.transaction(() => cards.filter((card) => {
    if (judged(db, 'commons_signal', card.signature, since, mode)) return false;
    judge(db, 'commons_signal', 'signal', card.signature, card.signature, mode, card.disposition, card.title, card, now);
    return true;
  })).immediate();
}

export function latestCard(db: Database, signature: string, mode: BridgeMode): SignalCard | null {
  try {
    const row = db.prepare("SELECT answers_json FROM judgments WHERE judgment = 'commons_signal' AND subject_id = ? AND mode = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(signature, mode) as { answers_json: string } | undefined;
    const card = json(row?.answers_json);
    return card.signature === signature ? card as unknown as SignalCard : null;
  } catch { return null; }
}

export interface SignalTopic { topic: string; topicRef: string; evidence: string[]; contexts: [string, string]; signalSignature: string; signature?: string }

/**
 * The next card for the existing Commons round (mode `on` only): recorded as `card`, its evidence still resolves, and neither
 * this signature nor (for loop signals) the failure agenda's signature has been asked before. The round's own reply whitelist
 * (refs on the question only) then keeps the discussion on this evidence.
 * ponytail: a signature is discussed once, ever. A kind that keeps recurring after its goal settled gets a new card each
 * window but no second thread; bound `asked` to the last outcome when a second round is wanted.
 */
export function pickSignalTopic(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()): SignalTopic | null {
  if (signalBridgeMode(env) !== 'on') return null;
  const asked = (key: string, value: string) => rows<{ x: number }>(db, `SELECT 1 AS x FROM agent_messages WHERE json_extract(payload_json, '$.action') = 'social.question' AND json_extract(payload_json, '$.params.${key}') = ? LIMIT 1`, value).length > 0;
  for (const row of rows<{ answers_json: string }>(db, "SELECT answers_json FROM judgments WHERE judgment = 'commons_signal' AND decision = 'card' AND mode = 'on' AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 20", new Date(now - SIGNAL_WINDOW_DAYS * DAY).toISOString())) {
    const card = json(row.answers_json) as unknown as SignalCard;
    if (!card.signature || asked('signal_signature', card.signature) || (card.failure_signature && asked('failure_signature', card.failure_signature))) continue;
    const evidence = (card.evidence_refs ?? []).filter((ref) => resolveRef(db, ref));
    if (!evidence.length) continue; // the records are gone: nothing to ground a discussion on
    const topicRef = `signal:${card.signature}`;
    const ask = `Signal (a hypothesis from records, not a finding): ${card.title}. Seen ${card.count} times in ${SIGNAL_WINDOW_DAYS} days. Evidence: ${evidence.join(', ')}. `
      + 'What is the smallest change to Djimitflo that would prevent this, and which test would show it worked? Cite only the evidence above. '
      + 'If the evidence does not support a change, say so: "no change" is a valid answer and what you cannot verify stays unknown.';
    return { topic: `Signal: ${card.title}`.slice(0, 300), topicRef, evidence: [topicRef, ...evidence], signalSignature: card.signature,
      contexts: [ask, `${ask} Challenge the peer's reading of the evidence before you build on it.`], ...(card.failure_signature ? { signature: card.failure_signature } : {}) };
  }
  return null;
}

export interface SignalOrigin { source: 'commons_signal'; signature: string; thread_id: string; evidence_refs: string[]; improvement_id: string }

/**
 * The signal a proposal came from: a learning in a `signal:` thread created it (the Commons service writes the proposal id on
 * that message), or it is the grounded refinement of one that was. Null = not from a signal.
 */
export function signalOrigin(db: Database, improvementId: string, mode: BridgeMode = 'on'): SignalOrigin | null {
  let id: string | null = improvementId;
  for (let depth = 0; id && depth < 4; depth += 1) {
    const [hit] = rows<{ thread_id: string; signature: string }>(db, `SELECT json_extract(m.payload_json, '$.thread_id') AS thread_id, json_extract(q.payload_json, '$.params.signal_signature') AS signature
      FROM agent_messages m JOIN agent_messages q ON json_extract(q.payload_json, '$.thread_id') = json_extract(m.payload_json, '$.thread_id')
      WHERE json_extract(m.payload_json, '$.params.improvement_id') = ? AND json_extract(q.payload_json, '$.action') = 'social.question'
        AND json_type(q.payload_json, '$.params.signal_signature') = 'text' LIMIT 1`, id);
    if (hit) return { source: 'commons_signal', signature: hit.signature, thread_id: hit.thread_id, evidence_refs: latestCard(db, hit.signature, mode)?.evidence_refs ?? [], improvement_id: improvementId };
    id = rows<{ p: string | null }>(db, 'SELECT refined_from_id AS p FROM self_improvements WHERE id = ?', id)[0]?.p ?? null;
  }
  return null;
}

export interface SignalGoalDecision { origin: SignalOrigin; mode: Exclude<BridgeMode, 'off'>; allowed: boolean; reasons: string[]; project_room: boolean;
  /** merged into the goal's metadata in mode `on`; `source` stays 'self-improvement' because the objective-loop gate reads it */
  metadata: Json }

/**
 * Called by the goal generator for a proposal the panel and the approver already authorised. Null = off, or not from a
 * signal (the direct route, unchanged). The gate adds conditions; it never replaces the panel, the approval or a later check.
 */
export function signalGoalDecision(db: Database, improvementId: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): SignalGoalDecision | null {
  const mode = signalBridgeMode(env);
  if (mode === 'off') return null;
  const origin = signalOrigin(db, improvementId, mode);
  if (!origin) return null;
  const [imp] = rows<{ type: string; grounding_json: string | null }>(db, 'SELECT type, grounding_json FROM self_improvements WHERE id = ?', improvementId);
  const grounding = json(imp?.grounding_json);
  const target = str(grounding.target); const test = str(grounding.acceptanceTest);
  const reasons: string[] = [];
  if (!target) reasons.push('no grounded target');
  if (!test) reasons.push('no acceptance test');
  for (const p of [target, test]) if (p && (SENSITIVE.test(p) || OWN_CRITERIA.test(p))) reasons.push(`protected path: ${p}`);
  if (imp?.type === 'security') reasons.push('security proposals are not promoted from a signal');
  if (!origin.evidence_refs.some((ref) => resolveRef(db, ref))) reasons.push('the signal has no evidence that still resolves');
  const allowed = reasons.length === 0;
  const room = allowed && signalProjectRoom(env) && ['shadow', 'on'].includes(env.COMMONS_PROJECT_ROOM_MODE ?? '');
  const decision: SignalGoalDecision = { origin, mode, allowed, reasons, project_room: room,
    metadata: allowed ? { commons_signal: origin, ...(room ? { task_profile: 'project_room' } : {}) } : {} };
  // one record per proposal per verdict: a retry of the same goal does not repeat it
  if (!judged(db, 'commons_signal_goal', improvementId)) judge(db, 'commons_signal_goal', 'self_improvement', improvementId, origin.signature, mode, allowed ? 'yes' : 'no', allowed ? `target=${target} test=${test}${room ? ' route=project_room' : ''}` : reasons.join('; '), decision, now);
  return decision;
}

/** Back to the direct route: the goal keeps its signal source, loses the project-room route. Returns whether it changed. */
export function rollbackToDirectRoute(db: Database, goalId: string): boolean {
  return db.prepare("UPDATE goals SET metadata = json_remove(metadata, '$.task_profile', '$.project_room'), updated_at = ? WHERE id = ? AND json_valid(metadata) AND json_extract(metadata, '$.task_profile') = 'project_room'")
    .run(new Date().toISOString(), goalId).changes === 1;
}

export interface SignalOutcome { goal_id: string; signature: string; decision: 'verified' | 'failed' | 'unknown'; receipt: ExecutionReceipt | null; candidate_id: string | null }

/**
 * A signal goal ended. The claim (`completed` / `failed`) is the caller's; what is learned follows the receipt:
 *   verified → one how-to candidate (engineering_rule, procedural: the skill candidate; always review_required)
 *   failed   → one operational memory candidate with the observed reasons
 *   unknown  → nothing is learned, and a `completed` claim without an independent verification is recorded as refused.
 * Once per goal. shadow records the decision and creates no candidate.
 */
export function recordSignalOutcome(db: Database, goalId: string, runId: string | null, claimed: 'completed' | 'failed', env: NodeJS.ProcessEnv = process.env, now = Date.now(), memory: Pick<MemoryCandidateService, 'create'> = new MemoryCandidateService(db)): SignalOutcome | null {
  const mode = signalBridgeMode(env);
  if (mode === 'off') return null;
  const [goal] = rows<{ objective: string; metadata: string }>(db, 'SELECT objective, metadata FROM goals WHERE id = ?', goalId);
  const origin = json(JSON.stringify(json(goal?.metadata).commons_signal ?? {})) as unknown as Partial<SignalOrigin>;
  if (!goal || !origin.signature || judged(db, 'commons_signal_outcome', goalId)) return null;
  const receipt = runId ? runReceipt(db, runId, now) : null;
  const decision: SignalOutcome['decision'] = receipt?.verdict === 'verified' && claimed === 'completed' ? 'verified' : receipt?.verdict === 'failed' || claimed === 'failed' ? 'failed' : 'unknown';
  const why = decision === 'verified' ? 'independent checker and deterministic checks passed' : (receipt?.reasons.join('; ') || 'no execution receipt for this goal');
  const facts = receipt ? `capability=${receipt.capability_id ?? 'unknown'} revision=${receipt.source_revision ?? 'unknown'} skill_hash=${receipt.skill_hash ?? 'unknown'} lease=${receipt.lease_id} runtime=${receipt.runtime_observed ?? 'unknown'} model=${receipt.model ?? 'unknown'} trace=${receipt.trace.state}` : 'no receipt';
  let candidateId: string | null = null;
  if (mode === 'on' && decision !== 'unknown') {
    const common = { source_ref: `signal:${origin.signature}`, metadata: { origin: 'commons-signal-bridge', signal_signature: origin.signature, goal_id: goalId, improvement_id: origin.improvement_id ?? null, receipt } };
    try {
      candidateId = (decision === 'verified'
        ? memory.create({ ...common, title: `How-to (signal, verified): ${goal.objective}`.slice(0, 200), memory_type: 'engineering_rule', store: 'procedural', metadata: { ...common.metadata, skill_candidate: true },
          content: `Goal "${goal.objective}" answered a recurring signal and was verified independently.\n${facts}` })
        : memory.create({ ...common, title: `Failed signal goal: ${goal.objective}`.slice(0, 200), memory_type: 'operational_memory',
          content: `Goal "${goal.objective}" for a recurring signal did not verify: ${why}\n${facts}` })).id;
    } catch { candidateId = null; } // a refused candidate (e.g. a secret in the text) is not a reason to lose the outcome record
  }
  judge(db, 'commons_signal_outcome', 'goal', goalId, origin.signature, mode, decision, claimed === 'completed' && decision !== 'verified' ? `refused: claimed completed, ${why}` : why, { claimed, receipt, candidate_id: candidateId }, now);
  return { goal_id: goalId, signature: origin.signature, decision, receipt, candidate_id: candidateId };
}

/**
 * Execution tasks still 'running' with no execution event inside the stale threshold and no live lease behind them. The lease
 * cleanup (background-worker-service) already failed their lease; the task row kept saying 'running'. shadow records them. on
 * holds them exactly like the engine's restart recovery does (paused, outcome unknown, no replay) — never completed.
 * ponytail: the engine's in-memory session is not consulted; a task with a prepared or running lease is never touched, which
 * is the same liveness rule the lease cleanup uses. Add an engine-side check if direct (lease-less) tasks ever run for hours.
 */
export function sweepStaleTraces(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()): { mode: BridgeMode; stale: number; held: number } {
  const mode = signalBridgeMode(env);
  const out = { mode, stale: 0, held: 0 };
  if (mode === 'off') return out;
  const cutoff = new Date(now - staleRunningMs(env)).toISOString();
  for (const task of rows<{ id: string; last_at: string | null }>(db, `SELECT t.id, COALESCE((SELECT MAX(e.timestamp) FROM execution_events e WHERE e.task_id = t.id), t.updated_at) AS last_at FROM tasks t
      WHERE t.status = 'running' AND NOT EXISTS (SELECT 1 FROM worker_leases l WHERE l.status IN ('prepared', 'running') AND json_valid(l.metadata) AND json_extract(l.metadata, '$.execution_task_id') = t.id) LIMIT 200`)) {
    if (!task.last_at || Date.parse(/[zZ]$/.test(task.last_at) ? task.last_at : `${task.last_at.replace(' ', 'T')}Z`) > Date.parse(cutoff)) continue;
    out.stale += 1;
    if (mode === 'on') {
      const iso = new Date(now).toISOString();
      out.held += db.transaction(() => {
        const changed = db.prepare(`UPDATE tasks SET status = 'paused', updated_at = ?, metadata = json_set(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
          '$.execution_recovery_hold', json('true'), '$.execution_recovery_reason', 'stale_running', '$.execution_recovery_outcome', 'unknown', '$.execution_recovery_reconciled_at', ?) WHERE id = ? AND status = 'running'`).run(iso, iso, task.id).changes;
        if (changed) db.prepare("INSERT INTO execution_events (id, task_id, event_type, timestamp, message, level, metadata) VALUES (?, ?, 'task.paused', ?, ?, 'warning', ?)")
          .run(randomUUID(), task.id, iso, 'No execution event within the stale threshold and no live lease; outcome unknown, not replayed.', JSON.stringify({ source: 'commons-signal-bridge', outcome: 'unknown' }));
        return changed;
      })();
    }
    if (!judged(db, 'commons_signal_stale_trace', task.id)) judge(db, 'commons_signal_stale_trace', 'task', task.id, task.last_at, mode, 'unknown', `running with no execution event since ${task.last_at}`, { last_event_at: task.last_at }, now);
  }
  return out;
}

export interface BridgeTick { mode: BridgeMode; cards: number; recorded: number; stale: number; held: number }
export function runSignalBridge(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()): BridgeTick {
  const mode = signalBridgeMode(env);
  if (mode === 'off') return { mode, cards: 0, recorded: 0, stale: 0, held: 0 };
  const cards = collectSignals(db, now);
  const stale = sweepStaleTraces(db, env, now);
  return { mode, cards: cards.length, recorded: recordSignalCards(db, cards, mode, now).length, stale: stale.stale, held: stale.held };
}

/** Read-only view for the board: the recorded cards and what became of them. Missing counts are null, never 0. */
export function signalBridgeView(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const since = new Date(now - 30 * DAY).toISOString();
  const count = (judgment: string): Record<string, number> | null => {
    try { return Object.fromEntries((db.prepare('SELECT decision, COUNT(*) AS n FROM judgments WHERE judgment = ? AND created_at >= ? GROUP BY decision').all(judgment, since) as Array<{ decision: string; n: number }>).map((r) => [r.decision, r.n])); } catch { return null; }
  };
  return { mode: signalBridgeMode(env), project_room: signalProjectRoom(env), window_days: 30,
    cards: rows<{ answers_json: string; mode: string; created_at: string }>(db, "SELECT answers_json, mode, created_at FROM judgments WHERE judgment = 'commons_signal' AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 100", since)
      .map((r) => ({ ...json(r.answers_json), recorded_mode: r.mode, recorded_at: r.created_at })),
    goal_gate: count('commons_signal_goal'), outcomes: count('commons_signal_outcome'), stale_traces: count('commons_signal_stale_trace') };
}

export function startSignalBridge(db: Database): (() => void) | null {
  const intervalMs = 900_000;
  if (!noteScheduler('commons_signal_bridge', 'COMMONS_SIGNAL_BRIDGE_MODE', signalBridgeMode() !== 'off', intervalMs)) return null;
  const tick = guardTick('commons_signal_bridge', () => {
    const r = runSignalBridge(db);
    markRun('commons_signal_bridge');
    if (r.recorded || r.stale) console.log(`📡 commons signal bridge (${r.mode}): ${r.recorded} new cards of ${r.cards}, ${r.stale} stale traces (${r.held} held)`);
  });
  const first = setTimeout(tick, 90_000); first.unref?.();
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
