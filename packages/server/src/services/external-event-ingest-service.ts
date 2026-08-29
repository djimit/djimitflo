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
    const url = `${this.busUrl.replace(/\/$/, '')}/events/${encodeURIComponent(this.stream)}?count=5000`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`event bus returned ${response.status}`);
    const body = await response.json() as { events?: Array<Record<string, unknown>> };
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO external_events
        (id, event_type, source, correlation_id, causation_id, aggregate_id,
         aggregate_version, dedupe_key, occurred_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    const transaction = this.db.transaction(() => {
      for (const event of body.events || []) {
        const id = String(event.event_id || event._id || '');
        const eventType = String(event.event_type || '');
        if (!id || (!eventType.startsWith('paperclip.') && eventType !== 'outcome.observed')) continue;
        if (eventType === 'outcome.observed' && !outcomeObservedSchema.safeParse(event).success) continue;
        const aggregateVersion = Number(event.aggregate_version);
        inserted += insert.run(
          id,
          eventType,
          String(event.source || (eventType.startsWith('paperclip.') ? 'paperclip' : 'external')),
          event.correlation_id ? String(event.correlation_id) : null,
          event.causation_id ? String(event.causation_id) : null,
          event.aggregate_id ? String(event.aggregate_id) : null,
          Number.isSafeInteger(aggregateVersion) && aggregateVersion > 0 ? aggregateVersion : null,
          event.dedupe_key ? String(event.dedupe_key) : null,
          String(event.occurred_at || event.timestamp || (eventType === 'outcome.observed' ? event.observed_at : '') || new Date().toISOString()),
          JSON.stringify(event),
        ).changes;
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
