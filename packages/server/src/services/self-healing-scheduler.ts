/**
 * SelfHealingScheduler — periodic self-healing, in-process.
 *
 * SelfHealingService.heal() has existed as a complete, working detect-and-fix
 * cycle (stale worker leases, orphaned worktrees, DB/memory pressure) but was
 * only reachable via `POST /api/intelligence/heal` (requires `write:governance`,
 * ADMIN-only — same access-scoping problem as the compliance report endpoint).
 * Nothing ever scheduled it, so incidents like abandoned worker_leases
 * (`status IN ('running','prepared')` untouched for over an hour) accumulated
 * silently — the same "detector exists, nobody ever runs it" shape as the
 * self-modification pipeline and compliance reporting fixed earlier in this
 * project.
 *
 * Same in-process pattern as OpenMythosNightlyService/ComplianceReportScheduler:
 * no HTTP round-trip, no credential needed.
 *
 * Known limitation, accepted rather than fixed here: SelfHealingService keeps
 * its incident/action history in memory on the instance, not in the database.
 * A scheduler-owned instance's `heal()` therefore won't show up in the
 * dashboard's `/api/intelligence/incidents` (a separate instance, created by
 * the route). The underlying repairs (e.g. cancelling stale leases) are real
 * DB writes regardless of which instance calls heal() — only the ephemeral
 * incident log isn't shared. Making that log persistent/shared is a separate,
 * larger change.
 *
 * Default-off. Arm with:
 *   SELF_HEALING_SCHEDULER_ENABLED=true
 *   SELF_HEALING_INTERVAL_MINUTES=30   (default 30 — the stale-lease check
 *                                       itself uses a 1h threshold, so this
 *                                       runs a few times within that window)
 */

import type { Database } from 'better-sqlite3';
import { SelfHealingService } from './self-healing-service';

type Healer = Pick<SelfHealingService, 'heal'>;

const MINUTE_MS = 60 * 1000;

export class SelfHealingScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly healer: Healer;

  constructor(db: Database, healer?: Healer) {
    this.healer = healer ?? new SelfHealingService(db);
  }

  /** Arm the scheduler. Returns false (no-op) unless explicitly enabled. */
  start(): boolean {
    if (process.env.SELF_HEALING_SCHEDULER_ENABLED !== 'true') return false;
    const intervalMs = this.intervalMinutes() * MINUTE_MS;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
    this.tick(); // catch-up on boot
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  intervalMinutes(): number {
    const minutes = Number(process.env.SELF_HEALING_INTERVAL_MINUTES ?? '30');
    return Number.isFinite(minutes) && minutes > 0 ? minutes : 30;
  }

  tick(): ReturnType<SelfHealingService['heal']> | null {
    try {
      return this.healer.heal();
    } catch (err) {
      console.warn('SelfHealingScheduler: heal() failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }
}
