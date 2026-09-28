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

export class UsageTelemetry {
  private buffer = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly db: Database, flushMs = 60_000) {
    ensure(db);
    if (flushMs > 0) { this.timer = setInterval(() => this.flush(), flushMs); this.timer.unref?.(); }
  }

  count(kind: 'api' | 'page', name: string, method = '', statusClass = ''): void {
    const key = JSON.stringify([new Date().toISOString().slice(0, 10), kind, name.slice(0, 200), method, statusClass]);
    this.buffer.set(key, (this.buffer.get(key) ?? 0) + 1);
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
    } catch { /* telemetry must never break a request */ }
  }

  summary(days = 14): Array<{ kind: string; name: string; method: string; hits: number; errors: number; last_day: string }> {
    this.flush();
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return this.db.prepare(`SELECT kind, name, method, SUM(count) hits, SUM(CASE WHEN status_class IN ('4xx', '5xx') THEN count ELSE 0 END) errors, MAX(day) last_day
      FROM usage_counts WHERE day >= ? GROUP BY kind, name, method ORDER BY hits DESC`).all(since) as never;
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.flush(); }
}
