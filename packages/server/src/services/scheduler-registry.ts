/**
 * UX-8 (Phase UX): which background schedulers are armed in this process, without SSH. Each start point reports
 * itself once at boot (name, flag that arms it, interval) and passes its armed state through unchanged, so wiring it
 * never changes behaviour. markRun lets a scheduler report its last tick; it never throws into the scheduler.
 * ponytail: in-memory only (one process, rebuilt at boot); persist when a second process needs it.
 */
/**
 * Cockpit 3.0: armed is intent, not execution. status from the last markRun tick:
 * - off: not armed
 * - executing: ticked within 2× its interval (or ticked at all when no interval is known)
 * - failing: its last tick reported an error
 * - armed_pending: armed, no tick yet, still inside the boot grace (2× interval)
 * - armed_not_ticking: armed with a known interval, past the grace, no tick within 2× interval
 * - unknown: armed, no interval and no tick reported — this scheduler does not report ticks, so execution is unproven
 * - quarantined: armed_not_ticking survived its one bounded restart (or has none): no further restarts, escalated as a stall
 */
export type SchedulerStatus = 'off' | 'executing' | 'failing' | 'armed_pending' | 'armed_not_ticking' | 'unknown' | 'quarantined';
export interface SchedulerInfo { name: string; flag: string; armed: boolean; interval_ms: number | null; last_run: string | null; last_error: string | null }
export interface SchedulerState extends SchedulerInfo { status: SchedulerStatus }

const registry = new Map<string, SchedulerInfo>();
// ticks are kept apart: a scheduler that ticks at start runs before its noteScheduler call
const ticks = new Map<string, { last_run: string; last_error: string | null }>();
let bootAt = Date.now();

/** Records a scheduler's armed state and returns it, so `if (noteScheduler(...))` is a drop-in for the original check. */
export function noteScheduler(name: string, flag: string, armed: boolean, intervalMs: number | null = null): boolean {
  try { registry.set(name, { name, flag, armed: !!armed, interval_ms: intervalMs, last_run: null, last_error: null }); } catch { /* never break boot */ }
  return armed;
}

export function markRun(name: string, error?: unknown): void {
  try {
    ticks.set(name, { last_run: new Date().toISOString(), last_error: error === undefined ? null : (error instanceof Error ? error.message : String(error)).slice(0, 200) });
  } catch { /* never break the scheduler */ }
}

/** Restart-safe tick start: records the tick without clearing an earlier error (a success clears it via markRun). */
export function markTick(name: string): void {
  try { ticks.set(name, { last_run: new Date().toISOString(), last_error: ticks.get(name)?.last_error ?? null }); } catch { /* never break the scheduler */ }
}

/**
 * Restore Evolutionary Health P0.1: every tick reports itself first and can never throw into its timer — a sync throw
 * or a rejected promise becomes the scheduler's last_error (status 'failing'), the interval keeps running.
 */
export function guardTick(name: string, fn: () => unknown): () => void {
  return () => {
    markTick(name);
    const fail = (e: unknown) => { markRun(name, e); console.warn(`scheduler ${name} tick failed:`, e instanceof Error ? e.message : String(e)); };
    try { const r = fn(); if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).catch(fail); } catch (e) { fail(e); }
  };
}

export function schedulerStatus(s: SchedulerInfo, now = Date.now()): SchedulerStatus {
  if (!s.armed) return 'off';
  if (s.last_error) return 'failing';
  const window = s.interval_ms ? 2 * s.interval_ms : null;
  if (s.last_run && (window === null || now - Date.parse(s.last_run) <= window)) return 'executing';
  if (window === null) return 'unknown';
  if (now - bootAt <= window) return 'armed_pending';
  // quarantine only masks 'not ticking': a quarantined scheduler that ticks again shows its real state (and recovers)
  return recovery.get(s.name)?.quarantined ? 'quarantined' : 'armed_not_ticking';
}

export type SchedulerHealth = 'HEALTHY' | 'BREACHED' | 'UNKNOWN';
/** health: 'BREACHED' when an armed scheduler stopped ticking or fails, 'UNKNOWN' when execution of an armed one is unproven. */
export function listSchedulers(now = Date.now()): { armed: number; off: number; by_status: Record<SchedulerStatus, number>; health: SchedulerHealth; schedulers: SchedulerState[] } {
  const schedulers = [...registry.values()]
    .map((s) => { const t = ticks.get(s.name); const info = { ...s, last_run: t?.last_run ?? null, last_error: t?.last_error ?? null }; return { ...info, status: schedulerStatus(info, now) }; })
    .sort((a, b) => Number(b.armed) - Number(a.armed) || a.name.localeCompare(b.name));
  const by_status: Record<SchedulerStatus, number> = { off: 0, executing: 0, failing: 0, armed_pending: 0, armed_not_ticking: 0, unknown: 0, quarantined: 0 };
  for (const s of schedulers) by_status[s.status]++;
  const health: SchedulerHealth = by_status.armed_not_ticking || by_status.failing || by_status.quarantined ? 'BREACHED' : by_status.unknown ? 'UNKNOWN' : 'HEALTHY';
  return { armed: schedulers.filter((s) => s.armed).length, off: schedulers.filter((s) => !s.armed).length, by_status, health, schedulers };
}

/** Summary for the cockpit (armed/off stay; by_status + health say whether armed schedulers actually run). */
export function schedulerHealth(now = Date.now()): { health: SchedulerHealth; by_status: Record<SchedulerStatus, number> } {
  const { health, by_status } = listSchedulers(now);
  return { health, by_status };
}

/**
 * Invariant: armed AND no tick after its SLA (2× interval past the boot grace) ⇒ unhealthy ⇒ diagnose ⇒ one safe restart
 * through the scheduler's own start function ⇒ verify (a tick within one interval + grace) ⇒ else quarantine + escalate.
 * At most one restart per scheduler per 6 h. Every step is a recovery action (failure_id, strategy, attempt, result,
 * next_action); the caller persists them. SCHEDULER_SELF_HEAL_MODE: shadow (default) diagnoses + escalates without
 * restarting, act restarts, off does nothing.
 */
export interface RecoveryAction { scheduler: string; failure_id: string; strategy: 'restart' | 'none'; attempt: number; result: 'diagnosed' | 'restarted' | 'restart_failed' | 'recovered' | 'quarantined'; next_action: string; diagnosis: { last_run: string | null; last_error: string | null; interval_ms: number | null }; at: string }
const restarters = new Map<string, () => unknown>();
const recovery = new Map<string, { failure_id: string; attempt: number; restarted_at: number | null; quarantined: boolean; diagnosed: boolean }>();
const lastRestartAt = new Map<string, number>();
const RESTART_COOLDOWN_MS = 6 * 3_600_000;
const VERIFY_GRACE_MS = 10 * 60_000;

/** The scheduler's own idempotent re-arm (stop the old timer, start again). Without one a not-ticking scheduler is quarantined at once. */
export function registerRestart(name: string, restart: () => unknown): void { restarters.set(name, restart); }

export type SelfHealMode = 'off' | 'shadow' | 'act';
export const selfHealMode = (env: NodeJS.ProcessEnv = process.env): SelfHealMode => (env.SCHEDULER_SELF_HEAL_MODE === 'act' || env.SCHEDULER_SELF_HEAL_MODE === 'off' ? env.SCHEDULER_SELF_HEAL_MODE : 'shadow');

export function healSchedulers(now = Date.now(), mode: SelfHealMode = selfHealMode()): RecoveryAction[] {
  if (mode === 'off') return [];
  const out: RecoveryAction[] = [];
  const at = new Date(now).toISOString();
  for (const s of listSchedulers(now).schedulers) {
    const r = recovery.get(s.name);
    const diagnosis = { last_run: s.last_run, last_error: s.last_error, interval_ms: s.interval_ms };
    const act = (result: RecoveryAction['result'], strategy: RecoveryAction['strategy'], next_action: string, rec = r!) =>
      out.push({ scheduler: s.name, failure_id: rec.failure_id, strategy, attempt: rec.attempt, result, next_action, diagnosis, at });
    const stuck = s.status === 'armed_not_ticking' || s.status === 'quarantined';
    if (r && !stuck) {
      // a tick arrived (status no longer not-ticking): the failure is over
      act('recovered', r.restarted_at ? 'restart' : 'none', 'none'); recovery.delete(s.name); continue;
    }
    if (!stuck || r?.quarantined) continue;
    const rec = r ?? { failure_id: `sched-${s.name}-${at}`, attempt: 0, restarted_at: null, quarantined: false, diagnosed: false };
    recovery.set(s.name, rec);
    const restart = restarters.get(s.name);
    const quarantine = (strategy: RecoveryAction['strategy'], why: string) => { rec.quarantined = true; act('quarantined', strategy, `escalated to the operator: ${why}`, rec); };
    if (rec.restarted_at !== null) {
      if (now - rec.restarted_at > (s.interval_ms ?? 0) + VERIFY_GRACE_MS) quarantine('restart', 'no tick after the bounded restart');
      continue; // still inside the verify window
    }
    if (!rec.diagnosed) { rec.diagnosed = true; act('diagnosed', restart ? 'restart' : 'none', mode === 'act' && restart ? 'restart' : 'escalate', rec); }
    if (mode !== 'act') { if (!restart) quarantine('none', 'no restart function registered'); continue; }
    if (!restart) { quarantine('none', 'no restart function registered'); continue; }
    if (now - (lastRestartAt.get(s.name) ?? -Infinity) < RESTART_COOLDOWN_MS) { quarantine('restart', 'already restarted within 6 h'); continue; }
    rec.attempt += 1; rec.restarted_at = now; lastRestartAt.set(s.name, now);
    try { restart(); act('restarted', 'restart', 'verify a tick within one interval', rec); }
    catch (e) { markRun(s.name, e); quarantine('restart', `restart threw: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return out;
}

/** Quarantined schedulers, for the stall watch (escalation = a stall, so it reaches needs-you). */
export const quarantinedSchedulers = (): string[] => [...recovery.entries()].filter(([, r]) => r.quarantined).map(([n]) => n);

export const resetSchedulers = (bootTime = Date.now()): void => { registry.clear(); ticks.clear(); restarters.clear(); recovery.clear(); lastRestartAt.clear(); bootAt = bootTime; };
