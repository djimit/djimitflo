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
import { listSchedulers } from '../services/scheduler-registry';
import { knowledgeOverview } from '../services/knowledge-overview';
import { forecastScores, forecastScoresV2 } from '../services/forecast-scoring';
import { runtimeHealth } from '../services/runtime-health';
import { agentScorecards, runtimeScorecards } from '../services/scorecards';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { attributionSummary } from '../services/outcome-attribution';
import { runtimeConfigView } from '../services/runtime-config-view';
import { buildDigest } from '../services/operator-push';
import { getDatabaseProvenance } from '../database/provenance';
import { efficiencyView } from '../services/resource-ledger';
import { shippedCodeView } from '../services/shipped-code-scan';

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

  // funnel phase 3 / E2: outcome classes (maker / reviewer / environment failure, verified) and the top credited contributors (read-only)
  router.get('/attribution', requireAuth, requirePermission('read:evidence'), (req, res) => {
    res.json(attributionSummary(db, Date.now(), Number(req.query.days) || 30));
  });

  // UX-8: which background schedulers this process armed at boot (name, arming flag, interval, last tick) — admins only
  // UX-13: the daily operator digest as it would be sent (read-only; delivery is OPERATOR_DIGEST_ENABLED)
  router.get('/digest', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    res.json(buildDigest(db));
  });

  router.get('/schedulers', requireAuth, requirePermission('manage:config'), (_req, res) => {
    res.json(listSchedulers());
  });

  // plan W5: knowledge pipeline per source — discoveries, jev relevance, units, KB retrieval, interest profile (read-only)
  router.get('/knowledge', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    res.json(knowledgeOverview(db));
  });

  // UX-16: one row per runtime — admission + expiry, versions, probe, 30-d leases, gym breaker, readiness (read-only)
  router.get('/runtimes', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    res.json({ runtimes: runtimeHealth(db) });
  });

  // UX-17: scorecards — per runtime (real-maker outcomes, CI, durations, tokens, cost when priced, failure classes) and per fleet agent
  router.get('/scorecards', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    res.json({ runtimes: runtimeScorecards(db), agents: agentScorecards(db) });
  });

  // plan AR1: forecasters of "this proposal ends verified", scored before the gate decided, against the per-source base rate
  router.get('/forecasts', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    res.json({ forecasters: forecastScores(db) });
  });

  // Phase E1/E3: tokens, local GPU time and measured GPU energy per consumer (7 d), value per M tokens / per kWh, north-star trend
  router.get('/efficiency', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    res.json(efficiencyView(db));
  });

  // supply chain (shadow): latest deterministic shipped-code scan per runtime package and its release-to-release diff (read-only)
  router.get('/shipped-code', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    res.json(shippedCodeView(db));
  });

  // RX-1 (Phase F): evolution evidence — flags, outcomes per source, loop PRs, genomes/holdouts, gym per tier, Realm Gates (read-only)
  router.get('/evolution-evidence', requireAuth, requirePermission('manage:config'), (req, res) => {
    res.json(buildEvolutionEvidence(db, process.env, Date.now(), Number(req.query.days) || 30));
  });

  // RX-7 (Phase F, shadow): forecast scoring V2 — trailing out-of-sample base rate, bootstrap CIs, decision_grade, and what V1 vs V2 would stop
  router.get('/forecasts-v2', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    res.json(forecastScoresV2(db));
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
