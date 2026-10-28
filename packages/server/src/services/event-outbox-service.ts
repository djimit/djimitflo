import { swarmEventBus } from './swarm-event-bus';
import { randomUUID } from 'crypto';
import { fleetBusAuthHeaders } from './fleet-bus-auth';
import type { Database } from 'better-sqlite3';

/**
 * Djimitflo publishes its own domain events on the Djimit event bus (`djimitflo.work_item.*`, `.approval.*`, `.goal.*`),
 * so the rest of the ecosystem (EVE-V, roborev, agents) can follow Djimitflo instead of a second work ledger.
 * Events are written to `event_outbox` first and delivered by a small drain (same shape as board_handoff_outbox):
 * a bus outage delays delivery but never loses or blocks the action. Default off: EVENT_PUBLISH_ENABLED=true.
 *
 * Two producer classes (CODE-003, forensic audit 2026-10-26):
 * - REQUIRED (`enqueueRequiredEvent`): work_item.created, approval.requested/approved/denied/expired, goal.created. The
 *   outbox row is written inside the same SQLite transaction as the state change it describes, so they commit or roll
 *   back together; an outbox insert failure rolls back the domain change and surfaces as an error.
 * - BEST-EFFORT (`enqueueEvent`): telemetry, digests, alerts and the goal-lifecycle mirror (`bridgeGoalEvents`). These
 *   either restate a state change that is durable elsewhere or are recomputed and re-offered on the next tick; a failed
 *   insert is swallowed and that event can be lost.
 * Delivery after the commit is the same for both: `publishPending` retries (attempts < 10) and the bus dedupes on
 * `dedupe_key = djimitflo:<event_id>`, which is stable across retries.
 */

export function eventPublishEnabled(): boolean { return process.env.EVENT_PUBLISH_ENABLED === 'true'; }

export interface DomainEvent { type: string; aggregateId: string; payload?: Record<string, unknown>; correlationId?: string }

function insertOutboxRow(db: Database, event: DomainEvent): void {
  db.prepare(`INSERT OR IGNORE INTO event_outbox (event_id, event_type, aggregate_id, correlation_id, payload_json, status, attempts, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`)
    .run(randomUUID(), event.type, event.aggregateId, event.correlationId ?? event.aggregateId, JSON.stringify(event.payload ?? {}), new Date().toISOString());
}

/**
 * Required domain event: call it inside the `db.transaction()` that performs the state change. It throws on failure so that
 * transaction rolls back: a committed domain row always has its outbox row. No-op while publishing is off (no event promised).
 */
export function enqueueRequiredEvent(db: Database, event: DomainEvent): void {
  if (db.inTransaction === false) throw new Error(`REQUIRED_EVENT_OUTSIDE_TRANSACTION: ${event.type} must be enqueued in the transaction of its state change`);
  if (!eventPublishEnabled()) return;
  insertOutboxRow(db, event);
}

/** Best-effort event: a failed insert is swallowed and the event is lost. Only for events no contract requires (see header). */
export function enqueueEvent(db: Database, event: DomainEvent): void {
  if (!eventPublishEnabled()) return;
  try { insertOutboxRow(db, event); } catch { /* best-effort by design: never break the action being described */ }
}

export interface PublishResult { attempted: number; published: number; failed: number; status: 'DISABLED' | 'OK' }

export class EventOutboxService {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly db: Database, private readonly fetchFn: typeof fetch = fetch) {}

  start(intervalMs = 60_000): void {
    if (this.timer || !eventPublishEnabled()) return;
    this.timer = setInterval(() => void this.publishPending().catch(() => undefined), intervalMs);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  async publishPending(limit = 100): Promise<PublishResult> {
    const bus = process.env.DJIMIT_EVENT_BUS_URL?.replace(/\/$/, '');
    if (!bus) return { attempted: 0, published: 0, failed: 0, status: 'DISABLED' };
    const stream = process.env.DJIMIT_EVENT_STREAM || 'djimit.events';
    const rows = this.db.prepare(`SELECT event_id, event_type, aggregate_id, correlation_id, payload_json, created_at FROM event_outbox
      WHERE status IN ('pending', 'failed') AND attempts < 10 ORDER BY created_at ASC LIMIT ?`).all(Math.max(1, Math.min(limit, 500))) as Array<{
      event_id: string; event_type: string; aggregate_id: string; correlation_id: string; payload_json: string; created_at: string }>;
    let published = 0; let failed = 0;
    for (const row of rows) {
      this.db.prepare('UPDATE event_outbox SET attempts = attempts + 1 WHERE event_id = ?').run(row.event_id);
      try {
        const response = await this.fetchFn(`${bus}/events/${encodeURIComponent(stream)}`, {
          method: 'POST', signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/json', ...fleetBusAuthHeaders() },
          body: JSON.stringify({
            event_id: `djimitflo:${row.event_id}`, event_type: row.event_type, source: 'djimitflo', occurred_at: row.created_at,
            aggregate_id: row.aggregate_id, correlation_id: row.correlation_id, dedupe_key: `djimitflo:${row.event_id}`, ...JSON.parse(row.payload_json || '{}'),
          }),
        });
        if (!response.ok) throw new Error(`event bus returned ${response.status}`);
        this.db.prepare("UPDATE event_outbox SET status = 'published', published_at = ?, last_error = NULL WHERE event_id = ?").run(new Date().toISOString(), row.event_id);
        published++;
      } catch (err) {
        this.db.prepare("UPDATE event_outbox SET status = 'failed', last_error = ? WHERE event_id = ?").run((err instanceof Error ? err.message : String(err)).slice(0, 300), row.event_id);
        failed++;
      }
    }
    return { attempted: rows.length, published, failed, status: 'OK' };
  }
}

const GOAL_EVENTS: Record<string, string> = {
  goal_completed: 'djimitflo.goal.completed', goal_failed: 'djimitflo.goal.failed',
  goal_awaiting_approval: 'djimitflo.goal.awaiting_approval', goal_started: 'djimitflo.goal.started',
};

/**
 * Mirrors the daemon's goal lifecycle (convergence events on the in-process bus) into the outbox. Returns the unsubscribe.
 * BEST-EFFORT: the goal state change is committed by the loop daemon before the bus event fires, so this mirror is not atomic
 * with it; the goal row (and its runs) stay the source of truth. ponytail: making these required means enqueueing inside the
 * loop-daemon status transactions; do that when a consumer depends on goal.started/completed/failed being complete.
 */
export function bridgeGoalEvents(db: Database): () => void {
  return swarmEventBus.subscribe((event) => {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const type = event.type === 'convergence' && typeof data.daemon === 'string' ? GOAL_EVENTS[data.daemon] : undefined;
    if (!type || typeof data.goal_id !== 'string') return;
    enqueueEvent(db, { type, aggregateId: data.goal_id, payload: { goal_id: data.goal_id, run_id: data.run_id ?? null, reason: data.reason ?? null, execution_mode: data.execution_mode ?? null } });
  });
}
