/**
 * Health check routes — production monitoring endpoints.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { MetricsService } from '../services/metrics-service';
import { KnowledgeRuntimeService } from '../services/knowledge-runtime-service';
import { getAppVersion } from '../utils/version';

export function createHealthRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  // GET /api/health — basic health check (public)
  router.get('/', (_req, res) => {
    res.json({ status: 'healthy', name: 'djimitflo', version: getAppVersion(), timestamp: new Date().toISOString() });
  });

  // GET /api/health/deep — deep health check with dependency verification
  router.get('/deep', requirePermission('read:evidence'), async (_req, res) => {
    const checks: Record<string, { status: 'ok' | 'error' | 'disabled'; message?: string }> = {};

    // DB check
    try {
      db.prepare('SELECT 1').get();
      checks.database = { status: 'ok' };
    } catch (error) {
      checks.database = { status: 'error', message: error instanceof Error ? error.message : 'Unknown error' };
    }

    // Memory check
    const memUsage = process.memoryUsage();
    const memMb = Math.round(memUsage.heapUsed / 1024 / 1024);
    checks.memory = memMb > 500
      ? { status: 'error', message: `High memory usage: ${memMb}MB` }
      : { status: 'ok' };

    // Active leases check
    try {
      db.prepare("SELECT COUNT(*) as c FROM worker_leases WHERE status = 'running'").get();
      checks.activeLeases = { status: 'ok' };
    } catch {
      checks.activeLeases = { status: 'error', message: 'Cannot query leases' };
    }

    const knowledge = new KnowledgeRuntimeService(db).health();
    const knowledgeUnavailable = !knowledge.exists || knowledge.validate_okf.status !== 'pass';
    checks.knowledgeRuntime = knowledgeUnavailable
      ? { status: 'error', message: knowledge.validate_okf.stderr || 'OKF validation failed' }
      : {
          status: 'ok',
          message: knowledge.blocked_reasons.length > 0 ? knowledge.blocked_reasons.join(', ') : undefined,
        };

    const dependencies = {
      litellm: process.env.LITELLM_URL,
      ollama: process.env.OLLAMA_URL,
      qdrant: process.env.QDRANT_URL,
    };
    await Promise.all(Object.entries(dependencies).map(async ([name, url]) => {
      if (!url) {
        checks[name] = { status: 'disabled' };
        return;
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        checks[name] = response.status < 500
          ? { status: 'ok' }
          : { status: 'error', message: `HTTP ${response.status}` };
      } catch (error) {
        checks[name] = { status: 'error', message: error instanceof Error ? error.message : 'Health probe failed' };
      }
    }));

    const allOk = Object.values(checks).every((c) => c.status !== 'error');
    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'healthy' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  // GET /api/metrics — Prometheus-format metrics
  router.get('/metrics', requirePermission('read:evidence'), (_req, res) => {
    const service = new MetricsService(db);
    res.setHeader('Content-Type', 'text/plain');
    res.send(service.getPrometheusMetrics());
  });

  // GET /api/metrics/json — JSON-format metrics
  router.get('/metrics/json', requirePermission('read:evidence'), (_req, res) => {
    const service = new MetricsService(db);
    res.json(service.getSnapshot());
  });

  return router;
}
