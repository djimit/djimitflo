/**
 * Health check routes — production monitoring endpoints.
 */

import { rateLimit } from 'express-rate-limit';
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { MetricsService } from '../services/metrics-service';
import { KnowledgeRuntimeService } from '../services/knowledge-runtime-service';
import { getAppVersion } from '../utils/version';
import { detectStalls } from '../services/stall-watch';
import { serviceMap } from '../services/service-map';
import { operatorCockpit } from '../services/operator-cockpit';
import { knowledgeOverview } from '../services/knowledge-overview';
import { forecastScores } from '../services/forecast-scoring';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { runtimeConfigView } from '../services/runtime-config-view';
import { getDatabaseProvenance } from '../database/provenance';

export function createHealthRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  router.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false })); // per-router limiter CodeQL can see; /api also caps 300/min
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const requireAuth = auth?.requireAuth ?? ((_req: any, _res: any, next: any) => next());

  /**
   * Build provenance from the image itself (build args), independent of the
   * runtime environment. Runtime env can drift or be duplicated across files;
   * this reflects what was actually baked into the artifact.
   */
  function buildProvenance() {
    const runtimeCommit = process.env.DJIMITFLO_COMMIT_SHA || null;
    const builtCommit = process.env.DJIMITFLO_BUILD_COMMIT && process.env.DJIMITFLO_BUILD_COMMIT !== 'unknown'
      ? process.env.DJIMITFLO_BUILD_COMMIT
      : null;
    return {
      commit: runtimeCommit,
      built_commit: builtCommit,
      build_source: process.env.DJIMITFLO_BUILD_SOURCE || null,
      build_time: process.env.DJIMITFLO_BUILD_TIME || null,
      instance_id: process.env.DJIMITFLO_INSTANCE_ID || null,
      // A deployed artifact is only attributable when the running revision and the
      // baked build revision agree.
      commit_matches_build: !!(runtimeCommit && builtCommit && runtimeCommit === builtCommit),
    };
  }

  // GET /api/health — basic health check (public)
  router.get('/', (_req, res) => {
    res.json({
      status: 'healthy',
      name: 'djimitflo',
      version: getAppVersion(),
      // Non-secret build identity makes public liveness checks attributable.
      commit: process.env.DJIMITFLO_COMMIT_SHA || null,
      build: buildProvenance(),
      timestamp: new Date().toISOString(),
    });
  });

  // GET /api/health/deep — deep health check with dependency verification
  router.get('/deep', requireAuth, requirePermission('read:evidence'), async (_req, res) => {
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
      litellm: process.env.LITELLM_URL || process.env.LITELLM_BASE_URL,
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
      database: getDatabaseProvenance(db),
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  // GET /api/metrics — Prometheus-format metrics
  // plan M10: silent stalls per subsystem (read-only)
  router.get('/stalls', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    res.json({ stalls: detectStalls(db) });
  });

  // plan S1: operator cockpit — scorecard, guardrails, stalls, gym species, remote workers, model/judgment usage (read-only)
  router.get('/cockpit', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    res.json(operatorCockpit(db));
  });

  // plan W5: knowledge pipeline per source — discoveries, jev relevance, units, KB retrieval, interest profile (read-only)
  router.get('/knowledge', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    res.json(knowledgeOverview(db));
  });

  // plan AR1: forecasters of "this proposal ends verified", scored before the gate decided, against the per-source base rate
  router.get('/forecasts', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    res.json({ forecasters: forecastScores(db) });
  });

  // RX-1 (Phase F): evolution evidence — flags, outcomes per source, loop PRs, genomes/holdouts, gym per tier, Realm Gates (read-only)
  router.get('/evolution-evidence', requireAuth, requirePermission('manage:config'), (req, res) => {
    res.json(buildEvolutionEvidence(db, process.env, Date.now(), Number(req.query.days) || 30));
  });

  // plan S3: the running configuration, read-only; secrets masked by name and value; admins only
  router.get('/config', requireAuth, requirePermission('manage:config'), (_req, res) => {
    res.json(runtimeConfigView());
  });

  // service map: reachability of the endpoints this server is configured to use (env only, no credentials sent)
  router.get('/services', requireAuth, requirePermission('read:evidence'), async (_req, res, next) => {
    try { res.json({ services: await serviceMap() }); } catch (error) { next(error); }
  });

  router.get('/metrics', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    const service = new MetricsService(db);
    res.setHeader('Content-Type', 'text/plain');
    res.send(service.getPrometheusMetrics());
  });

  // GET /api/metrics/json — JSON-format metrics
  router.get('/metrics/json', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    const service = new MetricsService(db);
    res.json(service.getSnapshot());
  });

  return router;
}
