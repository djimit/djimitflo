import type { Database } from 'better-sqlite3';
import { z } from 'zod';

const nonBlank = z.string().trim().min(1);
const outcomeObservedSchema = z.object({
  outcome_id: nonBlank,
  subject_type: nonBlank,
  subject_id: nonBlank,
  task_id: nonBlank,
  candidate_id: nonBlank,
  capability_id: nonBlank,
  model_id: nonBlank,
  skill_hash: nonBlank,
  runtime_identity: nonBlank,
  metric: nonBlank,
  value: z.union([nonBlank, z.number(), z.boolean()]),
  baseline: z.union([nonBlank, z.number(), z.boolean()]),
  observation_window: nonBlank,
  evidence_refs: z.array(nonBlank).min(1),
  confidence: z.number().min(0).max(1),
  causal_status: nonBlank,
  observed_at: z.string().datetime({ offset: true }),
  dedupe_key: nonBlank,
});

export class ExternalEventIngestService {
  readonly serviceName = 'ExternalEventIngest';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly busUrl = process.env.DJIMIT_EVENT_BUS_URL || '',
    private readonly stream = process.env.DJIMIT_EVENT_STREAM || 'djimit.events',
    private readonly pollMs = Number(process.env.DJIMIT_EVENT_POLL_MS) || 60_000,
  ) {}

  start(): void {
    if (!this.busUrl || this.running) return;
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<number> {
    const cursorKey = `external_event_ingest_cursor:${this.stream}`;
    const cursor = (this.db.prepare('SELECT value FROM system_state WHERE key = ?').get(cursorKey) as { value?: string } | undefined)?.value;
    let count = 5000;
    let events: Array<Record<string, unknown> | null> = [];
    let newestCursor: string | undefined;
    while (true) {
      const url = `${this.busUrl.replace(/\/$/, '')}/events/${encodeURIComponent(this.stream)}?count=${count}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`event bus returned ${response.status}`);
      const body = await response.json() as { events?: unknown };
      if (!Array.isArray(body.events)) throw new Error('event bus returned an invalid events contract');
      events = body.events as Array<Record<string, unknown> | null>;
      newestCursor ??= events.map(event => event && typeof event === 'object' && !Array.isArray(event) ? event._id : null)
        .find(value => typeof value === 'string' && value.trim()) as string | undefined;
      const cursorIndex = cursor
        ? events.findIndex(event => event && typeof event === 'object' && !Array.isArray(event) && event._id === cursor)
        : -1;
      if (cursorIndex >= 0) {
        events = events.slice(0, cursorIndex);
        break;
      }
      if (events.length < count) break;
      count += 5000;
    }
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO external_events
        (id, event_type, source, correlation_id, causation_id, aggregate_id,
         aggregate_version, dedupe_key, occurred_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    const transaction = this.db.transaction(() => {
      for (const event of events) {
        if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
        const id = [event.event_id, event._id]
          .map(value => typeof value === 'string' ? value.trim() : '')
          .find(Boolean) || '';
        const eventType = String(event.event_type || '');
        if (!id || (!eventType.startsWith('paperclip.') && eventType !== 'outcome.observed')) continue;
        let normalizedEvent = event;
        if (eventType === 'outcome.observed') {
          const parsed = outcomeObservedSchema.safeParse(event);
          if (!parsed.success) continue;
          normalizedEvent = { ...event, ...parsed.data };
        }
        const aggregateVersion = Number(normalizedEvent.aggregate_version);
        inserted += insert.run(
          id,
          eventType,
          String(normalizedEvent.source || (eventType.startsWith('paperclip.') ? 'paperclip' : 'external')),
          normalizedEvent.correlation_id ? String(normalizedEvent.correlation_id) : null,
          normalizedEvent.causation_id ? String(normalizedEvent.causation_id) : null,
          normalizedEvent.aggregate_id ? String(normalizedEvent.aggregate_id) : null,
          Number.isSafeInteger(aggregateVersion) && aggregateVersion > 0 ? aggregateVersion : null,
          normalizedEvent.dedupe_key ? String(normalizedEvent.dedupe_key) : null,
          eventType === 'outcome.observed'
            ? new Date(String(normalizedEvent.observed_at)).toISOString()
            : String(normalizedEvent.occurred_at || normalizedEvent.timestamp || new Date().toISOString()),
          JSON.stringify(normalizedEvent),
        ).changes;
      }
      if (newestCursor) {
        this.db.prepare(`
          INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(cursorKey, newestCursor);
      }
    });
    transaction();
    return inserted;
  }

  private async poll(): Promise<void> {
    try {
      const inserted = await this.pollOnce();
      if (inserted) console.log(`[ExternalEventIngest] imported ${inserted} causal event(s)`);
    } catch (error) {
      console.warn('[ExternalEventIngest] poll failed:', error instanceof Error ? error.message : String(error));
    } finally {
      if (this.running) this.timer = setTimeout(() => void this.poll(), this.pollMs);
    }
  }
}
