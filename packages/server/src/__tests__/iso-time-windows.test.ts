import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AgiGoalReasoningEngine } from '../services/agi-goal-reasoning-engine';
import { createObservabilityRoutes } from '../routes/observability';
import { UsageService } from '../services/usage-service';
import { PredictiveAnalyticsService } from '../services/predictive-analytics-service';
import { AdapterCache } from '../services/knowledge-adapters/adapter-cache';

/**
 * Truth audit 2026-11-12: these columns are written as ISO text (`2026-10-01T18:36:22.000Z`) but were compared as strings with
 * SQLite `datetime('now', …)` text (`2026-10-01 18:36:22`). On the same date 'T' sorts after ' ', so an ISO row from yesterday
 * still counted as "last 24 h" (the window was really 24–48 h) and an ISO row went "stale" only once the date rolled over.
 * Each window must hold to the second: rows just outside it (and the audit's now−30 h row) are out, rows inside are in.
 */
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());

const run = (id: string, status: string, ago: number) => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, metadata, created_at, updated_at)
  VALUES (?, 'test-gap', 'closed', ?, '/repo', '{}', ?, ?)`).run(id, status, iso(ago), iso(ago));
const task = (id: string, ago: number) => db.prepare(`INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, created_at, updated_at)
  VALUES (?, 't', 'd', 'completed', 'low', 'low', 'local', ?, ?)`).run(id, iso(ago), iso(ago));
const auth = { requireAuth: (_r: any, _s: any, n: any) => n(), requirePermission: () => (_r: any, _s: any, n: any) => n() } as any;

describe('ISO-written columns use julianday() windows', () => {
  it('agi-goal-reasoning observe(): last-24 h loop health excludes runs older than 24 h', () => {
    run('in', 'failed', H);
    run('edge', 'failed', D + MIN);
    run('old', 'failed', 30 * H);
    expect(new AgiGoalReasoningEngine(db).observe().observations[0]).toBe('Loop health: 0 running, 1 failed, 0 blocked');
  });

  it('observability /risk-trends?days=1 excludes assessments older than a day', async () => {
    const ra = (id: string, ago: number) => db.prepare(`INSERT INTO risk_assessments (id, action_type, subject, risk_level, recommended_decision, matched_rules, explanation, created_at)
      VALUES (?, 'a', 's', 'low', 'allow', '[]', 'e', ?)`).run(id, iso(ago));
    ra('in', H); ra('edge', D + MIN); ra('old', 30 * H);
    const app = express().use('/observability', createObservabilityRoutes(db, auth));
    const res = await request(app).get('/observability/risk-trends?days=1');
    expect(res.status).toBe(200);
    expect(res.body.trends.reduce((n: number, t: { count: number }) => n + t.count, 0)).toBe(1);
  });

  it('observability /execution-activity?hours=24 excludes tasks older than 24 h', async () => {
    task('in', H); task('edge', D + MIN); task('old', 30 * H);
    const app = express().use('/observability', createObservabilityRoutes(db, auth));
    const res = await request(app).get('/observability/execution-activity?hours=24');
    expect(res.status).toBe(200);
    expect(res.body.activity.reduce((n: number, a: { count: number }) => n + a.count, 0)).toBe(1);
  });

  it('usage getQuotas(): hourly/daily/weekly/monthly sums hold to their window', () => {
    db.prepare("INSERT INTO provider_configs (id, provider, is_active) VALUES ('p', 'fixture', 1)").run();
    const log = (id: string, tokens: number, ago: number) => db.prepare(`INSERT INTO token_usage_log (id, provider, model, prompt_tokens, completion_tokens, cost, timestamp, created_at, updated_at)
      VALUES (?, 'fixture', 'm', ?, 0, 0, ?, ?, ?)`).run(id, tokens, iso(ago), iso(ago), iso(ago));
    log('a', 1, 30 * MIN); log('b', 10, H + MIN); log('c', 100, D + MIN); log('c30', 100_000, 30 * H);
    log('d', 1000, 7 * D + MIN); log('e', 10_000, 30 * D + MIN);
    const q = new UsageService(db).getQuotas().find((p: any) => p.provider === 'fixture') as any;
    expect([q.tokens_used_hourly, q.tokens_used_daily, q.tokens_used_weekly, q.tokens_used_monthly]).toEqual([1, 11, 100_111, 101_111]);
  });

  it('predictive-analytics checkDataQuality(): a prepared lease >24 h old and a running lease idle >2 h are stale', () => {
    run('r', 'running', H);
    const lease = (id: string, status: string, createdAgo: number, updatedAgo: number) => db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
      VALUES (?, 'r', 'maker', 'codex', ?, '{}', ?, ?)`).run(id, status, iso(createdAgo), iso(updatedAgo));
    lease('prepared-stale', 'prepared', D + MIN, D + MIN);
    lease('prepared-fresh', 'prepared', 23 * H, 23 * H);
    lease('running-stale', 'running', 3 * H, 2 * H + MIN);
    lease('running-fresh', 'running', 3 * H, H);
    expect(new PredictiveAnalyticsService(db).checkDataQuality().staleLeaseCount).toBe(2);
  });

  it('adapter-cache cleanup(): deletes an entry as soon as its ISO expires_at has passed', () => {
    const cache = new AdapterCache(db);
    const put = (id: string, expiresAgo: number) => db.prepare(`INSERT INTO knowledge_adapter_cache (id, source, query_hash, result_json, expires_at)
      VALUES (?, 's', ?, '[]', ?)`).run(id, id, iso(expiresAgo));
    put('expired', MIN); put('live', -H);
    expect(cache.cleanup()).toBe(1);
    expect(db.prepare('SELECT id FROM knowledge_adapter_cache').all()).toEqual([{ id: 'live' }]);
  });
});
