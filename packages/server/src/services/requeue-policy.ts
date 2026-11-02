import { execFileSync } from 'child_process';
import path from 'path';
import type { Database } from 'better-sqlite3';
import { requeueBudgetAllows } from './improvement-requeue';

/**
 * Auto-requeue policy (REQUEUE_AUTO_MODE off | shadow | on, default off; operator 2026-10-26: "agents and the system handle
 * the routine; only big changes are tasked to me"). Decides, per requeue candidate on /decisions, whether the system requeues
 * it once, dismisses it after AUTO_DISMISS_AFTER_DAYS, or leaves it to a human. Pure reads; acting lives in auto-requeue.ts.
 *
 * Eligible for ONE automatic requeue (through requeueImprovement, actor system:auto-requeue):
 * - the original ended infra_failed, or its newest outcome attribution is environment_failure / reviewer_failure
 *   (the maker was not wrong, so a second attempt is a real retry);
 * - no copy exists yet (the candidate list already excludes requeued rows; requeueImprovement is idempotent anyway);
 * - the lane budget allows it (requeueBudgetAllows — the same check requeueImprovement enforces);
 * - the target file still exists on main (a proposal without a recorded file target skips this check; an unreadable
 *   repository holds the row for a human instead of guessing).
 * Never automatic:
 * - maker_failure, unless the MEASURED requeue success rate of maker_failure originals is ≥ 40 % with n ≥ 10
 *   (MAKER_FAILURE_GATE): the maker was wrong, a retry mostly repeats the same work;
 * - no_change; a copy that itself failed (never requeue a requeue); a row a human dismissed (it is no candidate anymore);
 * - a not_actionable row (lane switched off, or a later proposal with the same title verified).
 * An escalated row (needs explicit human approval) is held for the human first, whatever its class or age, never dismissed;
 * an unverifiable target is held too. Any other row that is not eligible and older than 14 days gets an audited automatic
 * dismiss (`auto:not_requeue_eligible:<class>`).
 *
 * Measurement behind the maker_failure gate (read-only, requeueOutcomesByClass): settled requeue copies, stratified by the
 * ORIGINAL's class. The production numbers at the time of writing are in the PR that introduced this policy (#auto-requeue);
 * the gate itself is re-measured on every tick, so the rule follows the data instead of a frozen constant.
 */
export type AutoRequeueMode = 'off' | 'shadow' | 'on';
export const autoRequeueMode = (env: NodeJS.ProcessEnv = process.env): AutoRequeueMode => {
  const v = String(env.REQUEUE_AUTO_MODE ?? '').trim().toLowerCase();
  return v === 'shadow' || v === 'on' ? v : 'off';
};
/** REQUEUE_AUTO_MAX_PER_TICK (default 3, clamped 1..20): automatic requeues per tick, on top of the lane budget. */
export const autoRequeueMaxPerTick = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = Math.floor(Number(env.REQUEUE_AUTO_MAX_PER_TICK));
  return Number.isFinite(n) && n > 0 ? Math.min(20, n) : 3;
};
export const AUTO_REQUEUE_ACTOR = 'system:auto-requeue';
export const AUTO_DISMISS_AFTER_DAYS = 14;
/** automatic dismisses per tick (they are reversible judgments, but a burst would hide a policy bug) */
export const AUTO_DISMISS_MAX_PER_TICK = 10;
export const MAKER_FAILURE_GATE = { min_rate: 0.4, min_n: 10 } as const;

export type PolicyClass = 'environment_failure' | 'reviewer_failure' | 'maker_failure' | 'no_change' | 'unknown';
export const POLICY_CLASSES: readonly PolicyClass[] = ['environment_failure', 'reviewer_failure', 'maker_failure', 'no_change', 'unknown'];

/** newest outcome_attribution decision on proposal `<alias>` or any of its runs */
export const attributionOf = (alias: string): string => `(SELECT j.decision FROM judgments j WHERE j.judgment = 'outcome_attribution'
      AND ((j.subject_type = 'self_improvement' AND j.subject_id = ${alias}.id)
        OR (j.subject_type = 'loop_run' AND j.subject_id IN (SELECT r.id FROM goals g JOIN loop_runs r ON r.goal_id = g.id WHERE g.improvement_id = ${alias}.id)))
      ORDER BY j.created_at DESC LIMIT 1)`;

export const policyClass = (status: string, attribution: string | null): PolicyClass =>
  status === 'no_change' ? 'no_change'
    : attribution === 'environment_failure' || attribution === 'reviewer_failure' || attribution === 'maker_failure' ? attribution : 'unknown';

export interface ClassOutcome { copies: number; settled: number; verified: number; rate: number | null }
export type RequeueOutcomes = Record<PolicyClass, ClassOutcome>;
const SETTLED = ['verified', 'regressed', 'infra_failed', 'no_change'];

/**
 * Every requeue copy (evidence ref `requeue-of:<original>`), grouped by the original's class; settled = the copy reached
 * verified / regressed / infra_failed / no_change, rate = verified / settled (null below one settled copy). All time, not
 * 30 d: the gate needs n. Null when the query fails — the gate is then not met.
 */
export function requeueOutcomesByClass(db: Database): RequeueOutcomes | null {
  try {
    const copies = db.prepare(`SELECT status, evidence_refs_json FROM self_improvements WHERE evidence_refs_json LIKE '%"requeue-of:%'`)
      .all() as Array<{ status: string; evidence_refs_json: string }>;
    const original = db.prepare(`SELECT o.status, ${attributionOf('o')} AS attribution FROM self_improvements o WHERE o.id = ?`);
    const out = Object.fromEntries(POLICY_CLASSES.map((c) => [c, { copies: 0, settled: 0, verified: 0, rate: null }])) as RequeueOutcomes;
    for (const c of copies) {
      const of = refsOf(c).find((r) => r.startsWith('requeue-of:'))?.slice('requeue-of:'.length);
      const o = of ? original.get(of) as { status: string; attribution: string | null } | undefined : undefined;
      if (!o) continue; // the original is gone: no class to attribute the outcome to
      const bucket = out[policyClass(o.status, o.attribution)];
      bucket.copies++;
      if (SETTLED.includes(c.status)) bucket.settled++;
      if (c.status === 'verified') bucket.verified++;
    }
    for (const c of POLICY_CLASSES) out[c].rate = out[c].settled ? out[c].verified / out[c].settled : null;
    return out;
  } catch { return null; }
}

export const makerGateMet = (m: RequeueOutcomes | null): boolean =>
  !!m && m.maker_failure.settled >= MAKER_FAILURE_GATE.min_n && (m.maker_failure.rate ?? 0) >= MAKER_FAILURE_GATE.min_rate;

export interface PolicyCandidate { id: string; status: string; updated_at: string; queue_class: string; attribution: string | null;
  evidence_refs_json: string | null; grounding_json: string | null; escalated: number | boolean }
/**
 * requeue: eligible now · dismiss: ineligible and older than 14 d · wait: the system acts later (budget, or the 14-day clock)
 * · hold: needs a human (escalated original, or the target could not be checked)
 */
export interface PolicyVerdict { action: 'requeue' | 'dismiss' | 'wait' | 'hold'; cls: string; reason: string }
export interface PolicyContext { now: number; makerGate: boolean;
  budgetAllows: (refs: string[]) => boolean;
  /** true = on main, false = gone, null = could not check */
  targetOnMain: (file: string) => boolean | null }

const refsOf = (c: { evidence_refs_json: string | null }): string[] => { try { const r = JSON.parse(c.evidence_refs_json || '[]'); return Array.isArray(r) ? r.map(String) : []; } catch { return []; } };

/** The recorded file target of a proposal (grounding.target, else artifactPath), only when it looks like a repo path. */
export function targetFile(groundingJson: string | null): string | null {
  let g: Record<string, unknown> = {};
  try { g = JSON.parse(groundingJson || '{}') as Record<string, unknown>; } catch { return null; }
  for (const v of [g.target, g.artifactPath]) {
    if (typeof v === 'string' && /^[\w@./-]+\.[A-Za-z0-9]+$/.test(v.trim()) && v.includes('/') && !v.split('/').includes('..')) return v.trim();
  }
  return null;
}

export function requeueVerdict(c: PolicyCandidate, ctx: PolicyContext): PolicyVerdict {
  const refs = refsOf(c);
  const ageDays = (ctx.now - Date.parse(c.updated_at)) / 86_400_000;
  const ineligible = (cls: string, why: string): PolicyVerdict => ageDays > AUTO_DISMISS_AFTER_DAYS
    ? { action: 'dismiss', cls, reason: `auto:not_requeue_eligible:${cls}` }
    : { action: 'wait', cls, reason: `${why}; auto-dismiss after ${AUTO_DISMISS_AFTER_DAYS} d` };
  const isCopy = refs.some((r) => r.startsWith('requeue-of:'));
  const cls = policyClass(c.status, c.attribution);
  const eligibleCls = c.status === 'infra_failed' && cls === 'unknown' ? 'infra_failed' : cls;
  // an escalated row is the operator's decision whatever its class or age: hold it before any automatic dismiss (ROOT-001)
  if (c.escalated) return { action: 'hold', cls: isCopy ? 'requeue_copy' : eligibleCls, reason: 'escalated: a requeue needs explicit human approval' };
  if (isCopy) return ineligible('requeue_copy', 'a requeue that failed again is never requeued');
  if (cls === 'no_change') return ineligible('no_change', 'nothing changed; a retry repeats it');
  if (c.queue_class === 'not_actionable') return ineligible('not_actionable', 'lane off or a later proposal verified');
  const eligible = c.status === 'infra_failed' || cls === 'environment_failure' || cls === 'reviewer_failure' || (cls === 'maker_failure' && ctx.makerGate);
  if (!eligible) return ineligible(cls, cls === 'maker_failure' ? `maker_failure below the measured gate (≥ ${MAKER_FAILURE_GATE.min_rate * 100} %, n ≥ ${MAKER_FAILURE_GATE.min_n})` : `${cls}: not a retryable failure`);
  const file = targetFile(c.grounding_json);
  if (file) {
    const onMain = ctx.targetOnMain(file);
    if (onMain === false) return ineligible('target_gone', `${file} is no longer on main`);
    if (onMain === null) return { action: 'hold', cls: eligibleCls, reason: `could not check ${file} on main` };
  }
  if (!ctx.budgetAllows(refs)) return { action: 'wait', cls: eligibleCls, reason: 'lane budget exhausted; next tick' };
  return { action: 'requeue', cls: eligibleCls, reason: `auto: ${eligibleCls} is retryable` };
}

/** The candidate columns requeueVerdict reads; `from` is the requeue-candidate FROM … WHERE of decisions-inbox. */
export const policyColumns = (queueClass: string): string => `s.id, s.status, s.updated_at, s.evidence_refs_json, s.grounding_json,
  ${attributionOf('s')} AS attribution, ${queueClass} AS queue_class,
  EXISTS (SELECT 1 FROM loop_runs r JOIN goals g ON g.id = r.goal_id WHERE g.improvement_id = s.id AND r.status = 'escalated') AS escalated`;

/**
 * `git cat-file -e <ref>:<file>` in the loop's repository; ref = origin/main, else main. null = no repository or no such ref
 * (unknown, never "gone"). Memoised per checker.
 */
export function gitTargetChecker(env: NodeJS.ProcessEnv = process.env): (file: string) => boolean | null {
  const repo = env.LOOP_DAEMON_REPOSITORY_PATH || env.LOOP_REPOSITORY_PATH || env.TEST_GAP_REPO_PATH;
  const git = (args: string[]): boolean => { try { execFileSync('git', ['-C', repo as string, ...args], { stdio: 'ignore', timeout: 5_000 }); return true; } catch { return false; } };
  let ref: string | null | undefined;
  const memo = new Map<string, boolean | null>();
  return (file: string) => {
    if (!repo) return null;
    if (ref === undefined) ref = ['origin/main', 'main'].find((r) => git(['rev-parse', '--verify', '--quiet', `${r}^{commit}`])) ?? null;
    if (!ref) return null;
    const rel = path.isAbsolute(file) ? path.relative(repo, file) : file;
    if (!rel || rel.startsWith('..')) return null;
    if (!memo.has(rel)) memo.set(rel, git(['cat-file', '-e', `${ref}:${rel}`]));
    return memo.get(rel) ?? null;
  };
}

/** Inbox preview: the verdict without the git check (assumed on main) — what the system will do, for display and counts. */
export function previewContext(db: Database, env: NodeJS.ProcessEnv, now: number, outcomes = requeueOutcomesByClass(db)): PolicyContext {
  return { now, makerGate: makerGateMet(outcomes), budgetAllows: (refs) => { try { return requeueBudgetAllows(db, refs, env, now); } catch { return false; } }, targetOnMain: () => true };
}
