import type { Database } from 'better-sqlite3';
import type { NextFunction, Request, Response } from 'express';

/**
 * S4 (operator 2026-09-28): which API routes and dashboard pages are actually used. Local only (SQLite, no third party),
 * counts only — no user ids, no query strings, no bodies. Route = the matched Express pattern (e.g. /api/goals/:id), so ids
 * never land in the table. Counts are buffered in memory and flushed once a minute: no write per request.
 */
const ensure = (db: Database) => db.exec(`CREATE TABLE IF NOT EXISTS usage_counts (
  day TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, method TEXT NOT NULL DEFAULT '', status_class TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL,
  PRIMARY KEY (day, kind, name, method, status_class))`);

/**
 * OPS-003: distinct buffered (day, kind, name, method, status) keys held while the database refuses writes. A rolled-back
 * flush is re-queued; a count that would need a new key past this cap is dropped and counted, so memory stays bounded.
 */
export const MAX_BUFFERED_KEYS = 10_000;

export class UsageTelemetry {
  private buffer = new Map<string, number>();
  private dropped = 0;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly db: Database, flushMs = 60_000) {
    ensure(db);
    if (flushMs > 0) { this.timer = setInterval(() => this.flush(), flushMs); this.timer.unref?.(); }
  }

  count(kind: 'api' | 'page', name: string, method = '', statusClass = ''): void {
    this.add(JSON.stringify([new Date().toISOString().slice(0, 10), kind, name.slice(0, 200), method, statusClass]), 1);
  }

  private add(key: string, n: number): void {
    if (!this.buffer.has(key) && this.buffer.size >= MAX_BUFFERED_KEYS) { this.dropped += n; return; }
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
    if (!this.buffer.size) return;
    const rows = [...this.buffer.entries()]; this.buffer.clear();
    try {
      const up = this.db.prepare(`INSERT INTO usage_counts (day, kind, name, method, status_class, count) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, kind, name, method, status_class) DO UPDATE SET count = count + excluded.count`);
      this.db.transaction(() => { for (const [k, n] of rows) up.run(...(JSON.parse(k) as [string, string, string, string, string]), n); })();
    } catch {
      // Telemetry must never break a request. The transaction rolled back as a whole, so re-queue the batch: it lands
      // exactly once on the next successful flush (or is counted in `dropped` past the cap).
      for (const [k, n] of rows) this.add(k, n);
    }
  }

  /**
   * Whether the persisted summary is the whole story: `dropped_count` counts lost to the buffer cap since process start,
   * `incomplete` is true while any count is dropped or still buffered (not yet written). Read it after `summary()`.
   */
  coverage(): { dropped_count: number; incomplete: boolean } {
    return { dropped_count: this.dropped, incomplete: this.dropped > 0 || this.buffer.size > 0 };
  }

  summary(days = 14): Array<{ kind: string; name: string; method: string; hits: number; errors: number; last_day: string }> {
    this.flush();
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return this.db.prepare(`SELECT kind, name, method, SUM(count) hits, SUM(CASE WHEN status_class IN ('4xx', '5xx') THEN count ELSE 0 END) errors, MAX(day) last_day
      FROM usage_counts WHERE day >= ? GROUP BY kind, name, method ORDER BY hits DESC`).all(since) as never;
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.flush(); }
}
