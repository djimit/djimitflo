/**
 * UX-8 (Phase UX): which background schedulers are armed in this process, without SSH. Each start point reports
 * itself once at boot (name, flag that arms it, interval) and passes its armed state through unchanged, so wiring it
 * never changes behaviour. markRun lets a scheduler report its last tick; it never throws into the scheduler.
 * ponytail: in-memory only (one process, rebuilt at boot); persist when a second process needs it.
 */
export interface SchedulerInfo { name: string; flag: string; armed: boolean; interval_ms: number | null; last_run: string | null; last_error: string | null }

const registry = new Map<string, SchedulerInfo>();

/** Records a scheduler's armed state and returns it, so `if (noteScheduler(...))` is a drop-in for the original check. */
export function noteScheduler(name: string, flag: string, armed: boolean, intervalMs: number | null = null): boolean {
  try { registry.set(name, { name, flag, armed: !!armed, interval_ms: intervalMs, last_run: registry.get(name)?.last_run ?? null, last_error: registry.get(name)?.last_error ?? null }); } catch { /* never break boot */ }
  return armed;
}

export function markRun(name: string, error?: unknown): void {
  try {
    const s = registry.get(name); if (!s) return;
    s.last_run = new Date().toISOString();
    s.last_error = error === undefined ? null : (error instanceof Error ? error.message : String(error)).slice(0, 200);
  } catch { /* never break the scheduler */ }
}

export function listSchedulers(): { armed: number; off: number; schedulers: SchedulerInfo[] } {
  const schedulers = [...registry.values()].sort((a, b) => Number(b.armed) - Number(a.armed) || a.name.localeCompare(b.name));
  return { armed: schedulers.filter((s) => s.armed).length, off: schedulers.filter((s) => !s.armed).length, schedulers };
}

export const resetSchedulers = (): void => registry.clear();
