import type { Database } from 'better-sqlite3';
import type { NextFunction, Request, Response } from 'express';

/**
 * S4 (operator 2026-09-28): which API routes and dashboard pages are actually used. Local only (SQLite, no third party),
 * counts only — no user ids, no query strings, no bodies. Route = the matched Express pattern (e.g. /api/goals/:id), so ids
 * never land in the table. Counts are buffered in memory and flushed once a minute: no write per request.
 */
const ensure = (db: Database) => db.exec(`CREATE TABLE IF NOT EXISTS usage_counts (
  day TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, method TEXT NOT NULL DEFAULT '', status_class TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL,
  PRIMARY KEY (day, kind, name, method, status_class));
  CREATE TABLE IF NOT EXISTS usage_loss (day TEXT PRIMARY KEY, dropped INTEGER NOT NULL)`);

/**
 * OPS-003: distinct buffered (day, kind, name, method, status) keys held while the database refuses writes. A rolled-back
 * flush is re-queued; a count that would need a new key past this cap is dropped and counted, so memory stays bounded.
 */
export const MAX_BUFFERED_KEYS = 10_000;

const sinceDay = (days: number, now = new Date()) => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

export class UsageTelemetry {
  private buffer = new Map<string, number>();
  private dropped = new Map<string, number>(); // day -> counts dropped at the cap, not yet written to usage_loss
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly db: Database, flushMs = 60_000) {
    ensure(db);
    if (flushMs > 0) { this.timer = setInterval(() => this.flush(), flushMs); this.timer.unref?.(); }
  }

  count(kind: 'api' | 'page', name: string, method = '', statusClass = ''): void {
    this.add(JSON.stringify([new Date().toISOString().slice(0, 10), kind, name.slice(0, 200), method, statusClass]), 1);
  }

  private add(key: string, n: number): void {
    if (!this.buffer.has(key) && this.buffer.size >= MAX_BUFFERED_KEYS) {
      const day = (JSON.parse(key) as string[])[0];
      this.dropped.set(day, (this.dropped.get(day) ?? 0) + n);
      return;
    }
    this.buffer.set(key, (this.buffer.get(key) ?? 0) + n);
  }

  /** Express middleware: counts the matched route pattern once the response is finished. */
  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      res.on('finish', () => {
        const pattern = req.route?.path ? `${req.baseUrl}${req.route.path === '/' ? '' : req.route.path}` : '(unmatched)';
        this.count('api', pattern, req.method, `${Math.floor(res.statusCode / 100)}xx`);
      });
      next();
    };
  }

  flush(): void {
    if (!this.buffer.size && !this.dropped.size) return;
    const rows = [...this.buffer.entries()]; this.buffer.clear();
    const losses = [...this.dropped.entries()];
    try {
      const up = this.db.prepare(`INSERT INTO usage_counts (day, kind, name, method, status_class, count) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, kind, name, method, status_class) DO UPDATE SET count = count + excluded.count`);
      const loss = this.db.prepare('INSERT INTO usage_loss (day, dropped) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET dropped = dropped + excluded.dropped');
      this.db.transaction(() => {
        for (const [k, n] of rows) up.run(...(JSON.parse(k) as [string, string, string, string, string]), n);
        for (const [day, n] of losses) loss.run(day, n);
      })();
      this.dropped.clear(); // persisted with the counts, so the loss label survives a restart
    } catch {
      // Telemetry must never break a request. The transaction rolled back as a whole, so re-queue the batch: it lands
      // exactly once on the next successful flush (or is counted in `dropped` past the cap). Unwritten losses stay queued.
      for (const [k, n] of rows) this.add(k, n);
    }
  }

  /**
   * Whether the persisted summary for the same window is the whole story: `dropped_count` = counts lost to the buffer cap
   * (persisted in usage_loss per day, plus losses not yet written), `incomplete` is true while any count in the window is
   * dropped or still buffered (not yet written). Read it after `summary(days)`. `now` = the window's end (default: now).
   */
  coverage(days = 14, now = new Date()): { dropped_count: number; incomplete: boolean } {
    const since = sinceDay(days, now);
    let dropped = (this.db.prepare('SELECT COALESCE(SUM(dropped), 0) n FROM usage_loss WHERE day >= ?').get(since) as { n: number }).n;
    for (const [day, n] of this.dropped) if (day >= since) dropped += n;
    return { dropped_count: dropped, incomplete: dropped > 0 || this.buffer.size > 0 };
  }

  summary(days = 14): Array<{ kind: string; name: string; method: string; hits: number; errors: number; last_day: string }> {
    this.flush();
    const since = sinceDay(days);
    return this.db.prepare(`SELECT kind, name, method, SUM(count) hits, SUM(CASE WHEN status_class IN ('4xx', '5xx') THEN count ELSE 0 END) errors, MAX(day) last_day
      FROM usage_counts WHERE day >= ? GROUP BY kind, name, method ORDER BY hits DESC`).all(since) as never;
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.flush(); }
}
