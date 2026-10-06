import type { Database } from 'better-sqlite3';
import { buildEvolutionEvidence } from './evolution-evidence';
import { detectStalls } from './stall-watch';
import { listSchedulers } from './scheduler-registry';
import { redactSecrets } from './secret-patterns';

/**
 * UX-12 / UX-13 (Phase UX, operator 2026-10-04: channel = Telegram). Nothing reached the operator unless they opened
 * the dashboard: TelegramBotService.requestApproval/broadcastAlert had zero callers. Two pushes, both off by default:
 * - TELEGRAM_PUSH_ENABLED: one message per new approval (dedupe per id, TELEGRAM_PUSH_MAX_PER_HOUR, TELEGRAM_QUIET_HOURS)
 *   with Approve / Deny / Open buttons; the decision itself goes through the normal API as the mapped user (D3 identity,
 *   approve:task, SELF_APPROVAL_FORBIDDEN all enforced server-side).
 * - OPERATOR_DIGEST_ENABLED: one daily digest at OPERATOR_DIGEST_HOUR (UTC).
 * Privacy: message content leaves to Telegram — ids, titles and aggregates only, secret patterns redacted, no hosts.
 */
export interface PushSender {
  requestApproval(approvalId: string, text: string, openUrl?: string | null): Promise<void>;
  broadcastAlert(text: string): Promise<void>;
}
let sender: PushSender | null = null;
export const setPushSender = (s: PushSender | null): void => { sender = s; };

export const pushEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.TELEGRAM_PUSH_ENABLED === 'true';

/** 'HH-HH' in UTC, wrapping midnight ('22-7' = 22:00..06:59). Malformed or empty = no quiet hours. */
export function inQuietHours(spec: string | undefined, now: Date): boolean {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(spec ?? '');
  if (!m) return false;
  const [from, to, h] = [Number(m[1]) % 24, Number(m[2]) % 24, now.getUTCHours()];
  return from === to ? false : from < to ? h >= from && h < to : h >= from || h < to;
}

const clean = (s: unknown, max = 160): string => redactSecrets(String(s ?? '')).redacted.replace(/\s+/g, ' ').trim().slice(0, max);
const ensureLog = (db: Database): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_push_log (approval_id TEXT PRIMARY KEY, sent_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operator_digest_log (day TEXT PRIMARY KEY, sent_at TEXT NOT NULL);`);
};

interface ApprovalLike { id: string; title?: string | null; risk_level?: string | null; action_type?: string | null; target_path?: string | null; expires_at?: string | null; metadata?: unknown; task_id?: string | null; request_data?: unknown }

const parse = (v: unknown): Record<string, unknown> => (typeof v === 'string' ? (() => { try { return JSON.parse(v) as Record<string, unknown>; } catch { return {}; } })() : (v ?? {}) as Record<string, unknown>);

/** TG-2: what the operator needs to decide, from approval → task → maker lease → loop run → goal → proposal. Null when unlinked. */
export interface ApprovalContext { lane: string | null; proposal: string | null; files: string[]; run_id: string | null; role: string | null; why: string | null }
export function approvalContext(db: Database, a: ApprovalLike): ApprovalContext | null {
  try {
    const leaseId = /^loop-worker-(.+)-[0-9a-f]{8}$/.exec(String(a.task_id ?? ''))?.[1];
    if (!leaseId) return null;
    const lease = db.prepare('SELECT loop_run_id, role, finding_id FROM worker_leases WHERE id = ?').get(leaseId) as { loop_run_id: string; role: string; finding_id: string | null } | undefined;
    if (!lease) return null;
    const run = db.prepare('SELECT id, loop_name, goal_id, findings_json FROM loop_runs WHERE id = ?').get(lease.loop_run_id) as { id: string; loop_name: string; goal_id: string | null; findings_json: string | null } | undefined;
    const finding = ((parse(run?.findings_json) as unknown as Array<{ id?: string; file?: string }>) ?? []);
    const findingFile = Array.isArray(finding) ? finding.find((f) => f.id === lease.finding_id)?.file ?? null : null;
    const proposal = run?.goal_id ? db.prepare(`SELECT s.title, s.grounding_json FROM goals g JOIN self_improvements s ON s.id = g.improvement_id WHERE g.id = ?`)
      .get(run.goal_id) as { title: string; grounding_json: string | null } | undefined : undefined;
    const grounding = parse(proposal?.grounding_json);
    const files = [...new Set([grounding.artifactPath, findingFile, grounding.target].filter((f): f is string => typeof f === 'string' && f.length > 0))];
    const assessment = parse(parse(a.request_data).assessment);
    const rules = Array.isArray(assessment.matched_rules) ? (assessment.matched_rules as unknown[]).map(String) : [];
    const why = rules.length || assessment.explanation ? [rules.join(', '), assessment.explanation].filter(Boolean).join(' — ') : null;
    return { lane: run?.loop_name ?? null, proposal: proposal?.title ?? null, files, run_id: run?.id ?? null, role: lease.role, why: why ? String(why) : null };
  } catch { return null; }
}

export function approvalMessage(a: ApprovalLike, ctx: ApprovalContext | null = null): string {
  const meta = parse(a.metadata);
  const lane = ctx?.lane ?? meta.loop_name ?? meta.lane ?? meta.loopName ?? null;
  const files = ctx?.files.length ? ctx.files : Array.isArray(meta.changed_files) ? meta.changed_files : Array.isArray(meta.scope) ? meta.scope : a.target_path ? [a.target_path] : [];
  const text = [
    'Approval needed',
    ctx?.proposal ? `Proposal: ${clean(ctx.proposal)}` : `Title: ${clean(a.title)}`,
    lane ? `Lane: ${clean(lane, 60)}${ctx?.role ? ` (${clean(ctx.role, 20)})` : ''}` : null,
    files.length ? `${ctx?.files.length ? 'File' : 'Scope'}: ${files.slice(0, 5).map((f) => clean(f, 100)).join(', ')}${files.length > 5 ? ` +${files.length - 5}` : ''}` : null,
    `Risk: ${clean(a.risk_level, 20) || 'unknown'}${a.action_type ? ` (${clean(a.action_type, 40)})` : ''}`,
    ctx?.why ? `Why ${a.risk_level ? `${clean(a.risk_level, 20)} ` : ''}risk: ${clean(ctx.why, 200)}` : null,
    ctx?.run_id ? `Run: ${clean(ctx.run_id, 40).slice(0, 8)}` : null,
    a.expires_at ? `Expires: ${clean(a.expires_at, 25)}` : null,
    `Id: ${clean(a.id, 40)}`,
  ].filter(Boolean).join('\n');
  return text.slice(0, 1000);
}

export type PushResult = 'disabled' | 'no_sender' | 'decided' | 'duplicate' | 'quiet' | 'capped' | 'sent' | 'failed';

/** Called after an approval is created. Never throws; the approval itself never depends on Telegram. */
export async function pushApproval(db: Database, a: ApprovalLike, env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<PushResult> {
  try {
    if (!pushEnabled(env)) return 'disabled';
    if (!sender) return 'no_sender';
    ensureLog(db);
    // TG-2 (prod 06-10): approvals auto-approved by a lane rule were pushed anyway; skip anything no longer pending
    const status = (() => { try { return (db.prepare('SELECT status FROM approvals WHERE id = ?').get(a.id) as { status: string } | undefined)?.status; } catch { return undefined; } })();
    if (status && status !== 'pending') return 'decided';
    if (db.prepare('SELECT 1 FROM telegram_push_log WHERE approval_id = ?').get(a.id)) return 'duplicate';
    if (inQuietHours(env.TELEGRAM_QUIET_HOURS, now)) return 'quiet';
    const cap = Math.max(1, Number(env.TELEGRAM_PUSH_MAX_PER_HOUR) || 6);
    const sentHour = (db.prepare('SELECT COUNT(*) AS n FROM telegram_push_log WHERE sent_at >= ?').get(new Date(now.getTime() - 3_600_000).toISOString()) as { n: number }).n;
    if (sentHour >= cap) return 'capped';
    db.prepare('INSERT INTO telegram_push_log (approval_id, sent_at) VALUES (?, ?)').run(a.id, now.toISOString());
    const base = (env.DJIMITFLO_PUBLIC_URL || '').replace(/\/+$/, '');
    await sender.requestApproval(a.id, approvalMessage(a, approvalContext(db, a)), /^https:\/\//.test(base) ? `${base}/decisions#approvals` : null);
    return 'sent';
  } catch { return 'failed'; }
}

// ─── UX-13 daily digest ──────────────────────────────────────────────────────

export interface Digest { at: string; text: string; data: Record<string, unknown> }

export function buildDigest(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Digest {
  const d1 = new Date(now - 86_400_000).toISOString();
  const one = (sql: string, ...args: unknown[]): number => { try { return Number(Object.values(db.prepare(sql).get(...args) as Record<string, unknown>)[0] ?? 0); } catch { return 0; } };
  const evidence = (() => { try { return buildEvolutionEvidence(db, env, now, 30); } catch { return null; } })();
  const stalls = (() => { try { return detectStalls(db, now, env); } catch { return []; } })();
  const sched = listSchedulers();
  const data = {
    verified_24h: one("SELECT COUNT(*) FROM self_improvements WHERE status = 'verified' AND updated_at >= ?", d1),
    regressed_24h: one("SELECT COUNT(*) FROM self_improvements WHERE status = 'regressed' AND updated_at >= ?", d1),
    new_proposals_24h: one('SELECT COUNT(*) FROM self_improvements WHERE created_at >= ?', d1),
    approvals_expired_24h: one("SELECT COUNT(*) FROM approvals WHERE status = 'expired' AND updated_at >= ?", d1),
    approvals_pending: one("SELECT COUNT(*) FROM approvals WHERE status = 'pending'"),
    loop_prs_settled: evidence ? (evidence.merge.settled as Array<{ state: string; survived: number | null; n: number }>).reduce((s, r) => s + r.n, 0) : 0,
    loop_prs_survived: evidence ? (evidence.merge.settled as Array<{ survived: number | null; n: number }>).filter((r) => r.survived === 1).reduce((s, r) => s + r.n, 0) : 0,
    drafts_unsettled: evidence?.drafts.unsettled ?? 0,
    drafts_age_max_days: evidence?.drafts.age_days_max ?? null,
    gates: evidence ? Object.fromEntries(Object.entries(evidence.gates).map(([k, g]) => [k, (g as { state: string }).state])) : {},
    stalls: stalls.map((s) => s.subsystem),
    schedulers_off: sched.schedulers.filter((s) => !s.armed).map((s) => s.name),
  };
  const gates = Object.entries(data.gates).map(([k, s]) => `${k} ${s}`).join(', ') || 'unknown';
  const text = [
    `Djimitflo daily digest (${new Date(now).toISOString().slice(0, 10)})`,
    `Last 24 h: ${data.verified_24h} verified, ${data.regressed_24h} regressed, ${data.new_proposals_24h} new proposals, ${data.approvals_expired_24h} approvals expired`,
    `Waiting for you: ${data.approvals_pending} approvals, ${data.drafts_unsettled} loop PRs unsettled${data.drafts_age_max_days != null ? ` (oldest ${data.drafts_age_max_days} d)` : ''}`,
    `Loop PRs settled: ${data.loop_prs_settled} (${data.loop_prs_survived} survived)`,
    `Realm gates: ${gates}`,
    data.stalls.length ? `Stalls: ${data.stalls.join(', ')}` : 'Stalls: none',
    data.schedulers_off.length ? `Schedulers off: ${data.schedulers_off.length}` : null,
  ].filter(Boolean).join('\n');
  return { at: new Date(now).toISOString(), text: redactSecrets(text).redacted, data };
}

export const digestEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.OPERATOR_DIGEST_ENABLED === 'true';

/** One digest per UTC day at OPERATOR_DIGEST_HOUR (default 7). Returns whether it sent. Never throws. */
export async function maybeSendDigest(db: Database, env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<boolean> {
  try {
    if (!digestEnabled(env) || !sender) return false;
    const hour = Number.isInteger(Number(env.OPERATOR_DIGEST_HOUR)) && env.OPERATOR_DIGEST_HOUR !== '' && env.OPERATOR_DIGEST_HOUR !== undefined ? Number(env.OPERATOR_DIGEST_HOUR) % 24 : 7;
    if (now.getUTCHours() !== hour) return false;
    ensureLog(db);
    const day = now.toISOString().slice(0, 10);
    if (db.prepare('SELECT 1 FROM operator_digest_log WHERE day = ?').get(day)) return false;
    db.prepare('INSERT INTO operator_digest_log (day, sent_at) VALUES (?, ?)').run(day, now.toISOString());
    await sender.broadcastAlert(buildDigest(db, now.getTime(), env).text);
    return true;
  } catch { return false; }
}

let digestTimer: ReturnType<typeof setInterval> | null = null;
export function startOperatorDigest(db: Database): void {
  if (digestTimer || !digestEnabled()) return;
  digestTimer = setInterval(() => { void maybeSendDigest(db); }, 15 * 60_000); digestTimer.unref?.();
}
