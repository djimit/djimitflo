import type { Database } from 'better-sqlite3';

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
        (id, event_type, source, correlation_id, occurred_at, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    const transaction = this.db.transaction(() => {
      for (const event of body.events || []) {
        const id = String(event._id || '');
        const eventType = String(event.event_type || '');
        if (!id || !eventType.startsWith('paperclip.')) continue;
        inserted += insert.run(
          id,
          eventType,
          String(event.source || 'paperclip'),
          event.correlation_id ? String(event.correlation_id) : null,
          String(event.occurred_at || event.timestamp || new Date().toISOString()),
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
      if (inserted) console.log(`[ExternalEventIngest] imported ${inserted} Paperclip event(s)`);
    } catch (error) {
      console.warn('[ExternalEventIngest] poll failed:', error instanceof Error ? error.message : String(error));
    } finally {
      if (this.running) this.timer = setTimeout(() => void this.poll(), this.pollMs);
    }
  }
}
