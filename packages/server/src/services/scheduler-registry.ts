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
 */
export type SchedulerStatus = 'off' | 'executing' | 'failing' | 'armed_pending' | 'armed_not_ticking' | 'unknown';
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

export function schedulerStatus(s: SchedulerInfo, now = Date.now()): SchedulerStatus {
  if (!s.armed) return 'off';
  if (s.last_error) return 'failing';
  const window = s.interval_ms ? 2 * s.interval_ms : null;
  if (s.last_run && (window === null || now - Date.parse(s.last_run) <= window)) return 'executing';
  if (window === null) return 'unknown';
  return now - bootAt <= window ? 'armed_pending' : 'armed_not_ticking';
}

export type SchedulerHealth = 'HEALTHY' | 'BREACHED' | 'UNKNOWN';
/** health: 'BREACHED' when an armed scheduler stopped ticking or fails, 'UNKNOWN' when execution of an armed one is unproven. */
export function listSchedulers(now = Date.now()): { armed: number; off: number; by_status: Record<SchedulerStatus, number>; health: SchedulerHealth; schedulers: SchedulerState[] } {
  const schedulers = [...registry.values()]
    .map((s) => { const t = ticks.get(s.name); const info = { ...s, last_run: t?.last_run ?? null, last_error: t?.last_error ?? null }; return { ...info, status: schedulerStatus(info, now) }; })
    .sort((a, b) => Number(b.armed) - Number(a.armed) || a.name.localeCompare(b.name));
  const by_status: Record<SchedulerStatus, number> = { off: 0, executing: 0, failing: 0, armed_pending: 0, armed_not_ticking: 0, unknown: 0 };
  for (const s of schedulers) by_status[s.status]++;
  const health: SchedulerHealth = by_status.armed_not_ticking || by_status.failing ? 'BREACHED' : by_status.unknown ? 'UNKNOWN' : 'HEALTHY';
  return { armed: schedulers.filter((s) => s.armed).length, off: schedulers.filter((s) => !s.armed).length, by_status, health, schedulers };
}

/** Summary for the cockpit (armed/off stay; by_status + health say whether armed schedulers actually run). */
export function schedulerHealth(now = Date.now()): { health: SchedulerHealth; by_status: Record<SchedulerStatus, number> } {
  const { health, by_status } = listSchedulers(now);
  return { health, by_status };
}

export const resetSchedulers = (bootTime = Date.now()): void => { registry.clear(); ticks.clear(); bootAt = bootTime; };
