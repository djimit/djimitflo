import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import type { Request, Response } from 'express';
import { createTestDb } from './helpers/test-db';
import { createMetricsHandler } from '../routes/metrics';

function call(handler: ReturnType<typeof createMetricsHandler>, authorization?: string) {
  const req = { headers: authorization ? { authorization } : {} } as Request;
  const out = { status: 0, contentType: '', body: '' };
  const res = {
    status(code: number) { out.status = code; return this; },
    end() { return this; },
    set(_key: string, value: string) { out.contentType = value; return this; },
    send(body: string) { out.status = out.status || 200; out.body = body; return this; },
  } as unknown as Response;
  handler(req, res);
  return out;
}

describe('GET /metrics', () => {
  let db: Database;
  const previousToken = process.env.METRICS_TOKEN;

  beforeEach(() => {
    db = createTestDb();
    process.env.METRICS_TOKEN = 'scrape-secret';
  });

  afterEach(() => {
    db.close();
    if (previousToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = previousToken;
  });

  it('is 404 (invisible) when METRICS_TOKEN is unset', () => {
    delete process.env.METRICS_TOKEN;
    const out = call(createMetricsHandler(db), 'Bearer anything');
    expect(out.status).toBe(404);
  });

  it('rejects missing or wrong bearer tokens', () => {
    const handler = createMetricsHandler(db);
    expect(call(handler).status).toBe(401);
    expect(call(handler, 'Bearer wrong').status).toBe(401);
  });

  it('emits status gauges, openmythos scores, and process metrics in prometheus text format', () => {
    db.prepare(`
      INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode)
      VALUES ('t1', 'a', 'b', 'pending', 'medium', 'low', 'local'), ('t2', 'c', 'd', 'pending', 'medium', 'low', 'local')
    `).run();
    db.prepare(`
      INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, completed_cases, overall_score, started_at, finished_at, metadata)
      VALUES ('r1', 'nightly:llama3.1:8b', 'completed', 78, 78, 2.692, '2026-07-15T10:00:00Z', '2026-07-15T10:02:00Z', '{}')
    `).run();

    const out = call(createMetricsHandler(db, () => 3), 'Bearer scrape-secret');

    expect(out.status).toBe(200);
    expect(out.contentType).toContain('text/plain');
    expect(out.body).toContain('djimitflo_tasks{status="pending"} 2');
    expect(out.body).toContain('djimitflo_openmythos_score{agent="nightly:llama3.1:8b"} 2.692');
    expect(out.body).toContain('djimitflo_ws_clients 3');
    expect(out.body).toMatch(/djimitflo_process_uptime_seconds \d+/);
    expect(out.body).toMatch(/djimitflo_process_memory_rss_bytes \d+/);
  });

  it('escapes label values', () => {
    db.prepare(`
      INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, completed_cases, overall_score, started_at, finished_at, metadata)
      VALUES ('r1', 'agent"with\\quotes', 'completed', 1, 1, 3.0, '2026-07-15T10:00:00Z', '2026-07-15T10:02:00Z', '{}')
    `).run();

    const out = call(createMetricsHandler(db), 'Bearer scrape-secret');
    expect(out.body).toContain('djimitflo_openmythos_score{agent="agent\\"with\\\\quotes"} 3');
  });
});
