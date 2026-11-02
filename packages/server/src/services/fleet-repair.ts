import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { redactSecrets } from './secret-patterns';
import { guardTick, markRun, noteScheduler } from './scheduler-registry';

/**
 * Track B, EVE-V cron repair (operator 30-10): fleet hosts report every job run as a signed `agent.outcome`; a job that keeps
 * failing is a repair candidate, and the only oracle that counts is that the next real runs succeed.
 *   FLEET_REPAIR_MODE=off (default) | shadow. `on` is accepted but runs as shadow: step 1 (30-10) found the EVE-V job code
 *   (~/.hermes/scripts, ~/scripts) in no git repository with a GitHub remote, so djimitflo cannot register it as an extra repo
 *   and there is no repo whose checks a proposal could run. Nothing here creates a proposal, a PR or a work item.
 * shadow: once a day, over agent.outcome rows whose FLEET_EVENT_SIGNATURES verdict is `verified` (any other verdict, or none,
 * never counts), every (agent, task_kind) with >= MIN_FAILURES failures in the last WINDOW_DAYS gets one `fleet_repair_candidate`
 * judgments row per UTC day (subject = the fleet skill key `agent:<agent>:<task_kind>`): n, failures, failure ratio, the ids of
 * action events (work.action.required / content.revenue.candidate) whose title or summary names the job — ids only, that text is
 * untrusted — and the latest failure's `error_tail` (unsigned, untrusted), redacted with redactSecrets and wrapped as an
 * external-content block (the S4b convention), i.e. the text a repair assignment would carry.
 * Settlement: a fix is a merged loop PR (merge-survival pr_outcome) whose proposal carries the evidence ref
 * `fleet-repair:<agent>:<task_kind>`; the success rate of the verified runs SETTLEMENT_DAYS before vs after merged_at. Until
 * such a PR exists the status is `no_linked_fix`; an empty window has rate null, never 0.
 * Evidence `fleet_repair` (evolution-evidence, read-only).
 */
export type FleetRepairMode = 'off' | 'shadow';
export const fleetRepairMode = (env: NodeJS.ProcessEnv = process.env): FleetRepairMode =>
  (env.FLEET_REPAIR_MODE === 'shadow' || env.FLEET_REPAIR_MODE === 'on' ? 'shadow' : 'off');
export const FLEET_REPAIR_JUDGMENT = 'fleet_repair_candidate';
export const WINDOW_DAYS = 7;
export const MIN_FAILURES = 3;
export const SETTLEMENT_DAYS = 7;
export const TAIL_MAX = 400;
export const ON_BLOCKED_REASON = 'step 1 (30-10): the EVE-V job code (~/.hermes/scripts, ~/scripts) is in no git repository with a GitHub remote; '
  + 'on needs that code in a GitHub repo registered as an extra repo (GITHUB_REPOSITORY_PATHS, EXTRA_REPOS_ENABLED=on) with its own checks';
const DAY = 86_400_000;
const ACTION_TYPES = ['work.action.required', 'content.revenue.candidate'];
const ACTION_LOOKBACK_DAYS = 60;

/** The evidence ref a repair proposal carries so its merged PR settles this candidate. */
export const fleetRepairRef = (agent: string, taskKind: string): string => `fleet-repair:${agent}:${taskKind}`;

interface VerifiedOutcome { id: string; agent: string; task_kind: string; success: boolean; at: number; error_tail: string | null }

/** Verified agent.outcome rows with occurred_at in [from, to); malformed payloads are skipped. Throws when a table is absent. */
function verifiedOutcomes(db: Database, from: number, to: number): VerifiedOutcome[] {
  // ISO strings with offsets: pad the SQL bound by a day, filter exactly on the parsed time
  const rows = db.prepare(`SELECT e.id, e.occurred_at AS at, e.payload FROM external_events e
    JOIN fleet_event_signatures f ON f.event_id = e.id AND f.verdict = 'verified'
    WHERE e.event_type = 'agent.outcome' AND e.occurred_at >= ? AND e.occurred_at < ?`)
    .all(new Date(from - DAY).toISOString(), new Date(to + DAY).toISOString()) as Array<{ id: string; at: string; payload: string }>;
  const out: VerifiedOutcome[] = [];
  for (const r of rows) {
    const at = Date.parse(r.at);
    if (!Number.isFinite(at) || at < from || at >= to) continue;
    let p: Record<string, unknown>;
    try { p = JSON.parse(r.payload) as Record<string, unknown>; } catch { continue; }
    const success = p.success === true || p.success === 'true' ? true : p.success === false || p.success === 'false' ? false : null;
    if (typeof p.agent !== 'string' || typeof p.task_kind !== 'string' || success === null) continue;
    out.push({ id: r.id, agent: p.agent, task_kind: p.task_kind, success, at, error_tail: typeof p.error_tail === 'string' ? p.error_tail : null });
  }
  return out;
}

/** An untrusted failure tail as a repair assignment would carry it: clipped, redacted, JSON-encoded inside a marked block. */
export function wrapFailureTail(agent: string, tail: string | null | undefined): string | null {
  if (typeof tail !== 'string' || !tail.trim()) return null;
  const { redacted } = redactSecrets(tail.slice(-TAIL_MAX));
  return [`BEGIN_EXTERNAL_CONTENT source=fleet_outcome:${agent.replace(/[^\w.:-]/g, '_')} trust=untrusted`,
    JSON.stringify({ failure_tail: redacted }), 'END_EXTERNAL_CONTENT'].join('\n');
}

const rate = (xs: VerifiedOutcome[]) => {
  const successes = xs.filter((x) => x.success).length;
  return { n: xs.length, successes, rate: xs.length ? +(successes / xs.length).toFixed(3) : null };
};

export interface FleetRepairSettlement {
  status: 'no_linked_fix' | 'pending' | 'settled'; pr_url: string | null; merged_at: string | null;
  before: ReturnType<typeof rate> | null; after: ReturnType<typeof rate> | null; delta: number | null;
}

/** Before/after success rate around the latest merged PR linked to (agent, task_kind). */
export function candidateSettlement(db: Database, agent: string, taskKind: string, now = Date.now()): FleetRepairSettlement {
  const none: FleetRepairSettlement = { status: 'no_linked_fix', pr_url: null, merged_at: null, before: null, after: null, delta: null };
  let fixes: Array<{ url: string; merged_at: string }> = [];
  try {
    fixes = db.prepare(`SELECT json_extract(r.metadata, '$.pr_url') AS url, json_extract(r.metadata, '$.pr_outcome.merged_at') AS merged_at
      FROM loop_runs r JOIN goals g ON g.id = r.goal_id JOIN self_improvements s ON s.id = g.improvement_id
      WHERE json_extract(r.metadata, '$.pr_outcome.state') = 'merged' AND instr(s.evidence_refs_json, ?) > 0`)
      .all(JSON.stringify(fleetRepairRef(agent, taskKind))) as typeof fixes;
  } catch { return none; }
  const fix = fixes.filter((f) => typeof f.url === 'string' && Number.isFinite(Date.parse(f.merged_at)) && Date.parse(f.merged_at) <= now)
    .sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at))[0];
  if (!fix) return none;
  const merged = Date.parse(fix.merged_at);
  const mine = (xs: VerifiedOutcome[]) => xs.filter((x) => x.agent === agent && x.task_kind === taskKind);
  let before: ReturnType<typeof rate>; let after: ReturnType<typeof rate>;
  try {
    before = rate(mine(verifiedOutcomes(db, merged - SETTLEMENT_DAYS * DAY, merged)));
    // after = (merged, merged + 7 d]: a run at the merge instant still ran the old code
    after = rate(mine(verifiedOutcomes(db, merged + 1, Math.min(now, merged + SETTLEMENT_DAYS * DAY) + 1)));
  } catch { return { ...none, status: 'pending', pr_url: fix.url, merged_at: fix.merged_at }; }
  const settled = now >= merged + SETTLEMENT_DAYS * DAY;
  return { status: settled ? 'settled' : 'pending', pr_url: fix.url, merged_at: fix.merged_at, before, after,
    delta: settled && before.rate !== null && after.rate !== null ? +(after.rate - before.rate).toFixed(3) : null };
}

export interface FleetRepairCandidate {
  key: string; agent: string; task_kind: string; n: number; failures: number; failure_ratio: number; first_failure_at: string; last_failure_at: string;
  linked_action_events: string[]; failure_tail: string | null; settlement: FleetRepairSettlement;
}

/** Ids of recent action events whose title or summary names the job (the task kind without its `cron:` prefix). */
function linkedActions(db: Database, taskKind: string, now: number): string[] {
  const job = taskKind.replace(/^cron:/, '').toLowerCase();
  if (job.length < 4) return [];
  try {
    const rows = db.prepare(`SELECT id, payload FROM external_events WHERE event_type IN (${ACTION_TYPES.map(() => '?').join(', ')}) AND occurred_at >= ?
      ORDER BY occurred_at DESC LIMIT 5000`).all(...ACTION_TYPES, new Date(now - ACTION_LOOKBACK_DAYS * DAY).toISOString()) as Array<{ id: string; payload: string }>;
    return rows.filter((r) => {
      try { const p = JSON.parse(r.payload) as { title?: unknown; summary?: unknown }; return `${String(p.title ?? '')}\n${String(p.summary ?? '')}`.toLowerCase().includes(job); } catch { return false; }
    }).slice(0, 10).map((r) => r.id);
  } catch { return []; }
}

/** Every (agent, task_kind) with >= MIN_FAILURES verified failures in the last WINDOW_DAYS, sorted by key. Throws when a table is absent. */
export function detectFleetRepairCandidates(db: Database, now = Date.now()): FleetRepairCandidate[] {
  const groups = new Map<string, VerifiedOutcome[]>();
  for (const o of verifiedOutcomes(db, now - WINDOW_DAYS * DAY, now + 1)) {
    const key = `agent:${o.agent}:${o.task_kind}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const out: FleetRepairCandidate[] = [];
  for (const [key, xs] of groups) {
    const failed = xs.filter((x) => !x.success).sort((a, b) => a.at - b.at);
    if (failed.length < MIN_FAILURES) continue;
    const { agent, task_kind } = xs[0];
    const tail = [...failed].reverse().find((x) => x.error_tail)?.error_tail ?? null;
    out.push({ key, agent, task_kind, n: xs.length, failures: failed.length, failure_ratio: +(failed.length / xs.length).toFixed(3),
      first_failure_at: new Date(failed[0].at).toISOString(), last_failure_at: new Date(failed[failed.length - 1].at).toISOString(),
      linked_action_events: linkedActions(db, task_kind, now), failure_tail: wrapFailureTail(agent, tail), settlement: candidateSettlement(db, agent, task_kind, now) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** One daily pass; null when off (nothing read, nothing written). A candidate already recorded for this UTC day is not recorded again. */
export function fleetRepairTick(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()): { recorded: number; candidates: number } | null {
  if (fleetRepairMode(env) === 'off') return null;
  const candidates = detectFleetRepairCandidates(db, now);
  const day = `day:${new Date(now).toISOString().slice(0, 10)}`;
  const seen = db.prepare('SELECT 1 FROM judgments WHERE judgment = ? AND subject_id = ? AND state_hash = ?');
  const insert = db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
    VALUES (?, ?, 'fleet_job', ?, ?, 'shadow', 'candidate', ?, ?, ?)`);
  let recorded = 0;
  for (const c of candidates) {
    if (seen.get(FLEET_REPAIR_JUDGMENT, c.key, day)) continue;
    insert.run(randomUUID(), FLEET_REPAIR_JUDGMENT, c.key, day, `${c.failures}/${c.n} verified runs failed in ${WINDOW_DAYS} d`, JSON.stringify(c), new Date(now).toISOString());
    recorded++;
  }
  return { recorded, candidates: candidates.length };
}

/** Evidence `fleet_repair`: the latest row per candidate of the last WINDOW_DAYS, settlement recomputed now. candidates null = no table. */
export function fleetRepairEvidence(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const base = { mode: fleetRepairMode(env), requested: env.FLEET_REPAIR_MODE ?? null, on_available: false, on_blocked_reason: ON_BLOCKED_REASON,
    window_days: WINDOW_DAYS, min_failures: MIN_FAILURES, settlement_days: SETTLEMENT_DAYS };
  let rows: Array<{ sid: string; answers: string | null; at: string }>;
  try {
    rows = db.prepare('SELECT subject_id AS sid, answers_json AS answers, created_at AS at FROM judgments WHERE judgment = ? AND created_at >= ? ORDER BY created_at, rowid')
      .all(FLEET_REPAIR_JUDGMENT, new Date(now - WINDOW_DAYS * DAY).toISOString()) as typeof rows;
  } catch { return { ...base, last_run_at: null, n_candidates: null, candidates: null }; }
  const latest = new Map<string, { answers: string | null; at: string }>();
  for (const r of rows) latest.set(r.sid, r);
  const candidates = [...latest.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, r]) => {
    let a: Partial<FleetRepairCandidate> = {};
    try { a = JSON.parse(r.answers || '{}') as Partial<FleetRepairCandidate>; } catch { /* unreadable */ }
    return { key, recorded_at: r.at, n: a.n ?? null, failures: a.failures ?? null, failure_ratio: a.failure_ratio ?? null, last_failure_at: a.last_failure_at ?? null,
      linked_action_events: Array.isArray(a.linked_action_events) ? a.linked_action_events.length : 0, has_failure_tail: !!a.failure_tail,
      settlement: typeof a.agent === 'string' && typeof a.task_kind === 'string' ? candidateSettlement(db, a.agent, a.task_kind, now) : null };
  });
  return { ...base, last_run_at: rows.length ? rows[rows.length - 1].at : null, n_candidates: candidates.length, candidates };
}

/** Daily (first run 25 min after boot); FLEET_REPAIR_MODE=shadow (or on, which runs as shadow). */
export function startFleetRepair(db: Database): (() => void) | null {
  if (!noteScheduler('fleet_repair', 'FLEET_REPAIR_MODE', fleetRepairMode() !== 'off', DAY)) return null;
  const tick = guardTick('fleet_repair', () => {
    const r = fleetRepairTick(db); markRun('fleet_repair');
    if (r?.recorded) console.log(`🔧 fleet repair: ${r.recorded} candidate(s) recorded (shadow)`);
  });
  const first = setTimeout(tick, 1_500_000); first.unref?.();
  const timer = setInterval(tick, DAY); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
