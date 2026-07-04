/**
 * Health check routes — production monitoring endpoints.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { MetricsService } from '../services/metrics-service';

export function createHealthRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  // GET /api/health — basic health check (public)
  router.get('/', (_req, res) => {
    res.json({ status: 'healthy', name: 'djimflo', version: '2.0.0', timestamp: new Date().toISOString() });
  });

  // GET /api/health/deep — deep health check with dependency verification
  router.get('/deep', requirePermission('read:evidence'), (_req, res) => {
    const checks: Record<string, { status: 'ok' | 'error'; message?: string }> = {};

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

    const allOk = Object.values(checks).every((c) => c.status === 'ok');
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
