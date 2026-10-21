import type { Database } from 'better-sqlite3';
import { AgentCommunicationService } from './agent-communication-service';
import { redactSecrets } from './secret-patterns';
import { leaseRanOn } from './outcome-attribution';
import { leaseGraded } from './graded-fitness';
import { parseOutcome, settlementState } from './merge-survival';

/**
 * Agent Commons evidence room (operator-approved 21-10). For every loop run that reached a verified outcome and for every
 * regression, one Commons thread (`evidence-room:<run id>`, existing agent_messages thread machinery) carries a structured,
 * read-only summary built only from durable records: goal/lane, target file, maker species + effective runtime,
 * deterministic check results, mutation/graded score, reviewer verdicts, draft PR url. When the run's PR settles its 14-day
 * merge survival (SETTLED_SURVIVED / SETTLED_REGRESSED) one follow-up post is appended. No LLM generation; every string
 * field passes redactSecrets. Missing evidence is null with a reason in `unknown`, never 0.
 * Posts go to `commons` (no resident inbox), so nothing triggers inference. Agents (social-runtime token) and operators
 * reply through replyToEvidenceRoom: a reply counts as evidence only with an attached executable artefact (test file +
 * command, or a repro command), stored as a typed `artefact` param with evidence_status 'artefact'; plain text replies are
 * accepted and flagged evidence_status 'unverified'. The artefact is stored, never executed here.
 *   COMMONS_EVIDENCE_ROOM_MODE=off (default) | on
 */
export type EvidenceRoomMode = 'off' | 'on';
export const evidenceRoomMode = (env: NodeJS.ProcessEnv = process.env): EvidenceRoomMode => (env.COMMONS_EVIDENCE_ROOM_MODE === 'on' ? 'on' : 'off');
export const EVIDENCE_ROOM_AUTHOR = 'djimitflo:evidence-room';
export const EVIDENCE_ROOM_PREFIX = 'evidence-room:';
const RECIPIENT = 'commons';
const WINDOW_DAYS = 30;
const SWEEP_LIMIT = 50;
const threadIdOf = (runId: string) => `${EVIDENCE_ROOM_PREFIX}${runId}`;

/** redactSecrets on every string, recursively (objects, arrays). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value).redacted as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  return value;
}

const json = (s: unknown): Record<string, unknown> => { try { const v = JSON.parse(String(s ?? '{}')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const clip = (v: string | null, n = 200): string | null => (v && v.length > n ? `${v.slice(0, n)}…` : v);

export interface EvidenceRoomSummary {
  run_id: string; outcome: 'verified' | 'regressed'; lane: string | null; goal: string | null; improvement_id: string | null;
  target_file: string | null;
  maker: { species: string; requested_runtime: string | null; effective_runtime: string | null; model: string | null } ;
  gates: Array<{ name: string; status: string }> | null;
  deterministic_checks: Array<{ name: string | null; exit_status: number | null; passed: boolean | null; reason: string | null }> | null;
  graded: { score: number; kind: string } | null;
  reviewers: Array<{ role: string; runtime: string | null; verdict: string | null }> | null;
  pr_url: string | null;
  /** field → why it is null */
  unknown: Record<string, string>;
}

interface OutcomeRow { run_id: string; skill_id: string; success: number; agent_id: string | null; loop_name: string | null; run_meta: string | null; gates_json: string | null;
  objective: string | null; improvement_id: string | null; target: string | null }

/** The summary of one run, from its loop run, maker/reviewer leases, goal, proposal and skill outcome rows only. Redacted. */
export function buildRunSummary(db: Database, row: OutcomeRow): EvidenceRoomSummary {
  const unknown: Record<string, string> = {};
  const rm = json(row.run_meta);
  const maker = row.agent_id ? db.prepare("SELECT id, runtime, metadata FROM worker_leases WHERE id = ? AND role = 'maker'").get(row.agent_id) as { id: string; runtime: string; metadata: string } | undefined : undefined;
  const lm = maker ? json(maker.metadata) : {};
  if (!maker) unknown.maker = 'maker lease not found';
  const ran = maker ? leaseRanOn(maker.runtime, lm as { model?: unknown; effective_runtime?: unknown; effective_model?: unknown }) : null;

  let gates: EvidenceRoomSummary['gates'] = null;
  try { const g = JSON.parse(row.gates_json || 'null') as unknown; if (Array.isArray(g) && g.length) gates = g.map((x) => ({ name: String((x as { name?: unknown }).name ?? ''), status: String((x as { status?: unknown }).status ?? '') })); } catch { /* malformed */ }
  if (!gates) unknown.gates = 'no recorded gates on the loop run';

  const checksRaw = lm.deterministic_checks;
  const deterministic_checks = Array.isArray(checksRaw) && checksRaw.length ? checksRaw.map((c) => {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    const exit = typeof o.exit_status === 'number' ? o.exit_status : null;
    return { name: str(o.name), exit_status: exit, passed: exit === null ? null : exit === 0, reason: str(o.reason) };
  }) : null;
  if (!deterministic_checks) unknown.deterministic_checks = 'maker lease recorded no deterministic checks';

  const g = leaseGraded(lm as { graded?: unknown });
  if (!g) unknown.graded = 'no graded or mutation score on the maker lease';

  let reviewers: EvidenceRoomSummary['reviewers'] = null;
  try {
    const rows = db.prepare("SELECT runtime, role, metadata FROM worker_leases WHERE loop_run_id = ? AND role IN ('checker', 'security_checker') ORDER BY created_at, id").all(row.run_id) as Array<{ runtime: string; role: string; metadata: string }>;
    const list = rows.map((r) => ({ r, m: json(r.metadata) })).filter(({ m }) => !maker || m.maker_lease_id === undefined || m.maker_lease_id === maker.id)
      .map(({ r, m }) => ({ role: r.role, runtime: leaseRanOn(r.runtime, m as { model?: unknown }).runtime, verdict: str(m.verdict) }));
    reviewers = list.length ? list : null;
  } catch { /* leases absent */ }
  if (!reviewers) unknown.reviewers = 'no reviewer lease for this maker';

  const target = str(row.target);
  if (!target) unknown.target_file = 'proposal has no grounded target';
  const prUrl = str(rm.pr_url);
  if (!prUrl) unknown.pr_url = 'no draft PR recorded for the run';
  const lane = str(row.loop_name);
  if (!lane) unknown.lane = 'loop run has no loop name';

  return redactDeep({
    run_id: row.run_id, outcome: row.success ? 'verified' : 'regressed', lane, goal: clip(str(row.objective)), improvement_id: row.improvement_id,
    target_file: target,
    maker: { species: row.skill_id, requested_runtime: maker?.runtime ?? null, effective_runtime: ran?.runtime ?? null, model: ran?.model ?? null },
    gates, deterministic_checks, graded: g ? { score: g.score, kind: g.kind } : null, reviewers, pr_url: prUrl, unknown,
  } satisfies EvidenceRoomSummary);
}

/** Plain, deterministic text of a summary (Commons context, ≤ 2,000 chars). */
export function summaryText(s: EvidenceRoomSummary): string {
  const u = (k: string) => `unknown (${s.unknown[k] ?? 'not recorded'})`;
  return [
    `Evidence room: loop run ${s.run_id} ${s.outcome === 'verified' ? 'reached a verified outcome' : 'regressed'}. Built by Djimitflo from its own records; read-only.`,
    `Lane: ${s.lane ?? u('lane')}. Goal: ${s.goal ?? 'unknown'}.`,
    `Target file: ${s.target_file ?? u('target_file')}.`,
    `Maker: ${s.maker.species} (requested ${s.maker.requested_runtime ?? '?'}, ran on ${s.maker.effective_runtime ?? '?'}${s.maker.model ? `@${s.maker.model}` : ''}).`,
    `Gates: ${s.gates ? s.gates.map((g) => `${g.name}:${g.status}`).join(', ') : u('gates')}.`,
    `Deterministic checks: ${s.deterministic_checks ? s.deterministic_checks.map((c) => `${c.name ?? '?'} exit ${c.exit_status ?? '?'}`).join(', ') : u('deterministic_checks')}.`,
    `Graded/mutation score: ${s.graded ? `${s.graded.score} (${s.graded.kind})` : u('graded')}.`,
    `Reviewers: ${s.reviewers ? s.reviewers.map((r) => `${r.role}@${r.runtime ?? '?'} ${r.verdict ?? 'no verdict'}`).join(', ') : u('reviewers')}.`,
    `Draft PR: ${s.pr_url ?? u('pr_url')}. Merge survival (14 d): pending.`,
    'Replies count as evidence only with an executable artefact (test file + command, or a repro command); plain text is marked unverified.',
  ].join('\n').slice(0, 2_000);
}

const rootOf = (db: Database, threadId: string) => db.prepare("SELECT id, payload_json FROM agent_messages WHERE from_agent = ? AND json_extract(payload_json, '$.thread_id') = ? AND json_extract(payload_json, '$.params.evidence_room_kind') = 'summary' LIMIT 1")
  .get(EVIDENCE_ROOM_AUTHOR, threadId) as { id: string; payload_json: string } | undefined;

export interface EvidenceRoomSweep { mode: EvidenceRoomMode; threads: number; survival_posts: number }

/** One pass: open missing threads (one per run, idempotent) and append settled survival results (once per thread). */
export function sweepEvidenceRoom(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): EvidenceRoomSweep {
  const mode = evidenceRoomMode(env);
  const result: EvidenceRoomSweep = { mode, threads: 0, survival_posts: 0 };
  if (mode === 'off') return result;
  const comms = new AgentCommunicationService(db); // ensures agent_messages
  const since = new Date(now - WINDOW_DAYS * 86_400_000).toISOString();
  let rows: OutcomeRow[] = [];
  try {
    // verified = the maker outcome succeeded; regression = it failed with outcome_class regressed (infra / no change are not
    // regressions). Terminal runs only (completed / blocked): the draft PR step has run by then.
    rows = db.prepare(`SELECT o.task_id AS run_id, o.skill_id, o.success, o.agent_id, r.loop_name, r.metadata AS run_meta, r.gates_json,
        g.objective, g.improvement_id, json_extract(s.grounding_json, '$.target') AS target
      FROM skill_outcomes o JOIN loop_runs r ON r.id = o.task_id LEFT JOIN goals g ON g.id = r.goal_id LEFT JOIN self_improvements s ON s.id = g.improvement_id
      WHERE (o.skill_id LIKE 'loop-maker:%' OR o.skill_id LIKE 'repo:%:loop-maker:%') AND o.created_at >= ? AND r.status IN ('completed', 'blocked')
        AND (o.success = 1 OR o.evidence_refs_json LIKE '%"outcome_class:regressed"%')
        AND NOT EXISTS (SELECT 1 FROM agent_messages m WHERE m.from_agent = ? AND json_extract(m.payload_json, '$.thread_id') = '${EVIDENCE_ROOM_PREFIX}' || o.task_id)
      ORDER BY o.created_at ASC LIMIT ?`).all(since, EVIDENCE_ROOM_AUTHOR, SWEEP_LIMIT) as OutcomeRow[];
  } catch { rows = []; } // a source table is absent: nothing to post
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.run_id)) continue; // one thread per run, even with two outcome rows
    seen.add(row.run_id);
    const summary = buildRunSummary(db, row);
    const threadId = threadIdOf(row.run_id);
    const text = summaryText(summary);
    comms.send({ from: EVIDENCE_ROOM_AUTHOR, to: RECIPIENT, type: 'question', action: 'social.question', context: text, evidence: [`loop_run:${row.run_id}`],
      threadId, epistemicRole: 'question', ttl: 86_400, idempotencyKey: `${threadId}:summary`,
      params: { topic: `Evidence room: ${summary.outcome} run ${row.run_id}`, topic_ref: threadId, effect_scope: 'isolated', facilitated_by: 'evidence-room',
        evidence_room_kind: 'summary', summary, board_summary: text.split('\n')[0] } });
    result.threads += 1;
  }

  // survival follow-ups: threads whose run PR settled the 14-day window and that have no survival post yet
  let open: Array<{ run_id: string; created_at: string; pr_url: string; o: string | null }> = [];
  try {
    open = db.prepare(`SELECT r.id AS run_id, r.created_at, json_extract(r.metadata, '$.pr_url') AS pr_url, json_extract(r.metadata, '$.pr_outcome') AS o
      FROM agent_messages m JOIN loop_runs r ON '${EVIDENCE_ROOM_PREFIX}' || r.id = json_extract(m.payload_json, '$.thread_id')
      WHERE m.from_agent = ? AND json_extract(m.payload_json, '$.params.evidence_room_kind') = 'summary'
        AND json_extract(r.metadata, '$.pr_url') IS NOT NULL AND json_extract(r.metadata, '$.pr_outcome.settled_at') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM agent_messages f WHERE f.from_agent = m.from_agent AND json_extract(f.payload_json, '$.thread_id') = json_extract(m.payload_json, '$.thread_id')
          AND json_extract(f.payload_json, '$.params.evidence_room_kind') = 'survival')
      LIMIT ?`).all(EVIDENCE_ROOM_AUTHOR, SWEEP_LIMIT) as typeof open;
  } catch { open = []; }
  for (const r of open) {
    const s = settlementState(r.created_at, parseOutcome(r.o), now);
    if (s.state !== 'SETTLED_SURVIVED' && s.state !== 'SETTLED_REGRESSED') continue; // not settled with a verdict (pending, anomaly, closed unmerged)
    const threadId = threadIdOf(r.run_id);
    const survival = redactDeep({ run_id: r.run_id, pr_url: r.pr_url, state: s.state, survived: s.state === 'SETTLED_SURVIVED', settled_at: s.since });
    const text = redactSecrets(`Merge survival settled for run ${r.run_id}: ${survival.survived ? 'survived' : 'did not survive'} 14 days on main (${s.state}, settled ${s.since ?? '?'}). PR: ${r.pr_url}.`).redacted;
    comms.send({ from: EVIDENCE_ROOM_AUTHOR, to: RECIPIENT, type: 'result', action: 'social.response', context: text, evidence: [`loop_run:${r.run_id}`, `pr_settlement:${s.state}`],
      threadId, epistemicRole: 'outcome', ttl: 86_400, idempotencyKey: `${threadId}:survival`,
      params: { topic: `Evidence room: run ${r.run_id}`, topic_ref: threadId, effect_scope: 'isolated', facilitated_by: 'evidence-room', evidence_room_kind: 'survival',
        survival, board_summary: text } });
    result.survival_posts += 1;
  }
  return result;
}

export type EvidenceArtefact = { kind: 'test'; test_file: string; command: string } | { kind: 'repro'; command: string };
export interface EvidenceReplyInput { text?: unknown; artefact?: unknown }

const COMMAND = /^[^\n\r\0]{1,500}$/;
const TEST_FILE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_.@/-]{1,300}\.(test|spec)\.[cm]?[jt]sx?$/;

/** The typed artefact of a reply, or null when it carries none (an invalid artefact throws). */
export function parseArtefact(raw: unknown): EvidenceArtefact | null {
  if (raw === undefined || raw === null) return null;
  const a = (typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const command = typeof a.command === 'string' ? a.command.trim() : '';
  if (!COMMAND.test(command)) throw new Error('EVIDENCE_ARTEFACT_COMMAND_REQUIRED');
  if (a.kind === 'repro') return { kind: 'repro', command };
  if (a.kind === 'test') {
    const testFile = typeof a.test_file === 'string' ? a.test_file.trim() : '';
    if (!TEST_FILE.test(testFile)) throw new Error('EVIDENCE_ARTEFACT_TEST_FILE_INVALID');
    return { kind: 'test', test_file: testFile, command };
  }
  throw new Error('EVIDENCE_ARTEFACT_KIND_INVALID');
}

export interface EvidenceReplyResult { message_id: string; thread_id: string; evidence_status: 'artefact' | 'unverified'; artefact: EvidenceArtefact | null }

/** A reply by an agent (`agent:<id>`) or operator (`operator:<id>`) on an evidence-room thread. Redacted; never executed. */
export function replyToEvidenceRoom(db: Database, threadId: string, author: string, input: EvidenceReplyInput, env: NodeJS.ProcessEnv = process.env): EvidenceReplyResult {
  if (evidenceRoomMode(env) === 'off') throw new Error('EVIDENCE_ROOM_OFF');
  if (!threadId.startsWith(EVIDENCE_ROOM_PREFIX)) throw new Error('EVIDENCE_ROOM_THREAD_NOT_FOUND');
  const comms = new AgentCommunicationService(db);
  const root = rootOf(db, threadId);
  if (!root) throw new Error('EVIDENCE_ROOM_THREAD_NOT_FOUND');
  const text = typeof input.text === 'string' ? input.text.trim().slice(0, 2_000) : '';
  const parsed = parseArtefact(input.artefact);
  if (!text && !parsed) throw new Error('EVIDENCE_REPLY_TEXT_REQUIRED');
  const artefact = parsed ? redactDeep(parsed) : null;
  const evidenceStatus = artefact ? 'artefact' : 'unverified';
  const context = redactSecrets(text || (artefact?.kind === 'test' ? `test ${artefact.test_file}: ${artefact.command}` : `repro: ${artefact?.command}`)).redacted;
  const rootParams = json(root.payload_json).params as Record<string, unknown> | undefined;
  const message = comms.send({ from: author, to: EVIDENCE_ROOM_AUTHOR, type: 'result', action: 'social.response', context: context.slice(0, 2_000),
    evidence: [`message:${root.id}`, ...(artefact ? [artefact.kind === 'test' ? `test:${artefact.test_file}` : 'repro:command'] : [])],
    threadId, epistemicRole: artefact ? 'claim' : 'objection', ttl: 86_400,
    params: { topic: rootParams?.topic ?? threadId, topic_ref: threadId, effect_scope: 'isolated', facilitated_by: 'evidence-room', evidence_room_kind: 'reply',
      evidence_status: evidenceStatus, artefact, answer: context.slice(0, 2_000), board_summary: context.slice(0, 500) } });
  // nobody consumes the author's inbox: the reply is a record, not a delivery
  db.prepare("UPDATE agent_messages SET status = 'read' WHERE id = ?").run(message.id);
  return { message_id: message.id, thread_id: threadId, evidence_status: evidenceStatus, artefact };
}

export function startEvidenceRoom(db: Database, intervalMs = 15 * 60_000): (() => void) | null {
  if (evidenceRoomMode() === 'off') return null;
  const tick = () => { try { sweepEvidenceRoom(db); } catch (e) { console.warn('evidence room sweep failed:', e instanceof Error ? e.message : String(e)); } };
  tick(); const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => clearInterval(timer);
}
