/**
 * Prometheus exposition endpoint (text format 0.0.4), mounted at GET /metrics.
 *
 * Default-off: responds 404 unless METRICS_TOKEN is set, and requires
 * `Authorization: Bearer <METRICS_TOKEN>` (JWT auth doesn't fit scrapers).
 * All gauges are computed per scrape from SQLite — no counters kept in
 * process, so restarts and multi-node deploys need no extra state.
 */

import { timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import type { Database } from 'better-sqlite3';
import rateLimit from 'express-rate-limit';

/**
 * 300 scrapes / 15 min per IP — generous for any Prometheus interval, tight
 * enough to blunt token brute-forcing. express-rate-limit (rather than the
 * in-repo RateLimiter) so CodeQL's js/missing-rate-limiting recognizes it.
 */
export const metricsRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: false,
  legacyHeaders: false,
});

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function authorized(req: Request): boolean {
  const token = process.env.METRICS_TOKEN;
  if (!token) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const provided = Buffer.from(req.headers.authorization || '');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function createMetricsHandler(db: Database, getWsClients?: () => number) {
  const statusGauge = (name: string, help: string, table: string): string[] => {
    const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
    try {
      const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM ${table} GROUP BY status`).all() as Array<{ status: string; n: number }>;
      for (const row of rows) lines.push(`${name}{status="${escapeLabel(String(row.status))}"} ${row.n}`);
    } catch { /* table absent on this deploy — emit the header only */ }
    return lines;
  };

  return (req: Request, res: Response): void => {
    if (!process.env.METRICS_TOKEN) {
      res.status(404).end();
      return;
    }
    if (!authorized(req)) {
      res.status(401).end();
      return;
    }

    const lines: string[] = [
      ...statusGauge('djimitflo_tasks', 'Tasks by status', 'tasks'),
      ...statusGauge('djimitflo_agents', 'Agents by status', 'agents'),
      ...statusGauge('djimitflo_loop_runs', 'Loop runs by status', 'loop_runs'),
      ...statusGauge('djimitflo_worker_leases', 'Worker leases by status', 'worker_leases'),
      ...statusGauge('djimitflo_approvals', 'Approvals by status', 'approvals'),
      ...statusGauge('djimitflo_work_items', 'Work items by status', 'work_items'),
    ];

    lines.push(
      '# HELP djimitflo_openmythos_score Latest OpenMythos governance score per agent (0-5)',
      '# TYPE djimitflo_openmythos_score gauge',
    );
    try {
      const rows = db.prepare(`
        SELECT agent_id, overall_score, MAX(finished_at) AS finished_at
        FROM openmythos_eval_runs WHERE status = 'completed' GROUP BY agent_id
      `).all() as Array<{ agent_id: string; overall_score: number }>;
      for (const row of rows) {
        lines.push(`djimitflo_openmythos_score{agent="${escapeLabel(row.agent_id)}"} ${row.overall_score}`);
      }
    } catch { /* eval table absent */ }

    if (getWsClients) {
      lines.push(
        '# HELP djimitflo_ws_clients Connected WebSocket clients',
        '# TYPE djimitflo_ws_clients gauge',
        `djimitflo_ws_clients ${getWsClients()}`,
      );
    }

    lines.push(
      '# HELP djimitflo_process_uptime_seconds Server process uptime',
      '# TYPE djimitflo_process_uptime_seconds gauge',
      `djimitflo_process_uptime_seconds ${Math.round(process.uptime())}`,
      '# HELP djimitflo_process_memory_rss_bytes Resident set size',
      '# TYPE djimitflo_process_memory_rss_bytes gauge',
      `djimitflo_process_memory_rss_bytes ${process.memoryUsage().rss}`,
    );

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(lines.join('\n') + '\n');
  };
}
