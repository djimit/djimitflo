import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { dismissRequeue, requeueCandidateSql } from './decisions-inbox';
import { requeueBudgetAllows, requeueImprovement } from './improvement-requeue';
import { markRun } from './scheduler-registry';
import {
  AUTO_DISMISS_MAX_PER_TICK, AUTO_REQUEUE_ACTOR, autoRequeueMaxPerTick, autoRequeueMode, gitTargetChecker, makerGateMet, policyColumns,
  requeueOutcomesByClass, requeueVerdict, type AutoRequeueMode, type PolicyCandidate, type PolicyContext, type RequeueOutcomes,
} from './requeue-policy';

/**
 * The auto-requeue tick (policy: requeue-policy.ts). One tick:
 * - off: returns at once and touches nothing (the /decisions behaviour of today).
 * - shadow: records what it would do as ONE `auto_requeue` judgment per proposal (mode shadow, decision would_requeue /
 *   would_dismiss), at most REQUEUE_AUTO_MAX_PER_TICK would-requeues and AUTO_DISMISS_MAX_PER_TICK would-dismisses per tick.
 * - on: requeues through requeueImprovement (actor system:auto-requeue; budgeted, idempotent, audited by its `requeue`
 *   judgment) at most REQUEUE_AUTO_MAX_PER_TICK per tick, and dismisses through dismissRequeue (audited `requeue_dismiss`,
 *   reason auto:not_requeue_eligible:<class>; nothing is deleted) at most AUTO_DISMISS_MAX_PER_TICK per tick.
 * Oldest candidates first, so a row nearing the end of the 30-day inbox window is handled before it ages out.
 */
export interface AutoRequeueTickResult { mode: AutoRequeueMode; requeued: string[]; dismissed: string[]; shadow_recorded: number;
  held: number; waiting: number; errors: string[]; maker_gate_met: boolean | null }

export interface AutoRequeueDeps { targetOnMain?: PolicyContext['targetOnMain']; outcomes?: RequeueOutcomes | null }

export function autoRequeueTick(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now(), deps: AutoRequeueDeps = {}): AutoRequeueTickResult {
  const mode = autoRequeueMode(env);
  const result: AutoRequeueTickResult = { mode, requeued: [], dismissed: [], shadow_recorded: 0, held: 0, waiting: 0, errors: [], maker_gate_met: null };
  if (mode === 'off') return result;
  const outcomes = deps.outcomes !== undefined ? deps.outcomes : requeueOutcomesByClass(db);
  result.maker_gate_met = makerGateMet(outcomes);
  const ctx: PolicyContext = { now, makerGate: result.maker_gate_met, budgetAllows: (refs) => requeueBudgetAllows(db, refs, env, now),
    targetOnMain: deps.targetOnMain ?? gitTargetChecker(env) };
  const { from, queueClass } = requeueCandidateSql(env);
  const rows = (db.prepare(`SELECT ${policyColumns(queueClass)} ${from} ORDER BY s.updated_at ASC LIMIT 5000`)
    .all(new Date(now - 30 * 86_400_000).toISOString()) as PolicyCandidate[]).filter((r) => r.queue_class !== 'requeued');
  const maxRequeue = autoRequeueMaxPerTick(env);
  const shadowSeen = db.prepare("SELECT 1 FROM judgments WHERE judgment = 'auto_requeue' AND mode = 'shadow' AND subject_id = ? LIMIT 1");
  let wouldRequeue = 0, wouldDismiss = 0;
  for (const row of rows) {
    const requeueRoom = (mode === 'on' ? result.requeued.length : wouldRequeue) < maxRequeue;
    const dismissRoom = (mode === 'on' ? result.dismissed.length : wouldDismiss) < AUTO_DISMISS_MAX_PER_TICK;
    if (!requeueRoom && !dismissRoom) break;
    if (mode === 'shadow' && shadowSeen.get(row.id)) continue;
    // no room left for requeues: skip the git check of the remaining eligible rows this tick
    const v = requeueVerdict(row, requeueRoom ? ctx : { ...ctx, targetOnMain: () => true });
    if (v.action === 'hold') { result.held++; continue; }
    if (v.action === 'wait') { result.waiting++; continue; }
    if (v.action === 'requeue' && !requeueRoom) continue;
    if (v.action === 'dismiss' && !dismissRoom) continue;
    if (mode === 'shadow') {
      db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
        VALUES (?, 'auto_requeue', 'self_improvement', ?, ?, 'shadow', ?, ?, ?)`)
        .run(randomUUID(), row.id, v.cls, v.action === 'requeue' ? 'would_requeue' : 'would_dismiss', v.reason.slice(0, 300), new Date(now).toISOString());
      result.shadow_recorded++;
      if (v.action === 'requeue') wouldRequeue++; else wouldDismiss++;
      continue;
    }
    try {
      if (v.action === 'requeue') {
        const r = requeueImprovement(db, row.id, { actor: AUTO_REQUEUE_ACTOR, reason: v.reason }, env);
        if (r.created) result.requeued.push(r.id);
      } else {
        dismissRequeue(db, row.id, AUTO_REQUEUE_ACTOR, v.reason);
        result.dismissed.push(row.id);
      }
    } catch (e) { result.errors.push(`${row.id.slice(0, 8)}:${e instanceof Error ? e.message : String(e)}`.slice(0, 120)); }
  }
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Hourly tick, first one 15 min after boot; armed only when REQUEUE_AUTO_MODE is shadow or on. Returns a stop function. */
export function startAutoRequeue(db: Database, env: NodeJS.ProcessEnv = process.env): (() => void) | null {
  if (timer || autoRequeueMode(env) === 'off') return null;
  const tick = () => {
    try {
      const r = autoRequeueTick(db, env);
      markRun('auto_requeue');
      if (r.requeued.length || r.dismissed.length || r.shadow_recorded || r.errors.length) {
        console.log(`🔁 auto-requeue (${r.mode}): requeued=${r.requeued.length} dismissed=${r.dismissed.length} shadow=${r.shadow_recorded} held=${r.held}${r.errors.length ? ` errors=${r.errors.join(',')}` : ''}`);
      }
    } catch (e) { markRun('auto_requeue', e); console.warn('auto-requeue failed:', e instanceof Error ? e.message : String(e)); }
  };
  const first = setTimeout(tick, 15 * 60_000); first.unref?.();
  timer = setInterval(tick, 3_600_000); timer.unref?.();
  return () => { clearTimeout(first); if (timer) clearInterval(timer); timer = null; };
}
