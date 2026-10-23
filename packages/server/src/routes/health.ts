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
import { detectStallsWithHealth } from '../services/stall-watch';
import { serviceMap } from '../services/service-map';
import { operatorCockpit } from '../services/operator-cockpit';
import { listSchedulers } from '../services/scheduler-registry';
import { knowledgeOverview } from '../services/knowledge-overview';
import { forecastScores, forecastScoresV2 } from '../services/forecast-scoring';
import { runtimeHealth } from '../services/runtime-health';
import { agentScorecards, runtimeScorecards } from '../services/scorecards';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { provenanceDag } from '../services/provenance-dag';
import { attributionSummary } from '../services/outcome-attribution';
import { runtimeConfigView } from '../services/runtime-config-view';
import { buildDigest } from '../services/operator-push';
import { getDatabaseProvenance } from '../database/provenance';
import { efficiencyWithCost } from '../services/cost-ledger';
import { shippedCodeView } from '../services/shipped-code-scan';
import { memoryTemplateAnalysis } from '../services/memory-template-dedup';
import { skillCardsView } from '../services/skill-distillation';
import { evolutionFeedbackMode, latestEvolutionDigest } from '../services/evolution-feedback';
import { expertUnitDedupe } from '../services/expert-unit-dedupe';
import { buildTrainingDataset, trainingDatasetMode, trainingDatasetSummary } from '../services/training-dataset';
import { buildValueAllocation, latestValueAllocation, valueAllocatorMode } from '../services/value-allocator';

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
  // plan M10: silent stalls per subsystem (read-only); Cockpit 3.0: + per-detector status and overall health (UNKNOWN ≠ HEALTHY)
  router.get('/stalls', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    res.json(detectStallsWithHealth(db));
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

  // Cockpit 3.0: each scheduler's status from its last tick (executing / armed_not_ticking / unknown …), not only armed vs off
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
  // + verified cost ledger (cost_per_verified): population, usage events with one owner each, coverage, versioned metrics; ?days= 1–90 (default 7)
  router.get('/efficiency', requireAuth, requirePermission('read:evidence'), (req, res) => {
    const days = Number(req.query.days);
    res.json(efficiencyWithCost(db, Date.now(), process.env, Number.isInteger(days) && days >= 1 && days <= 90 ? days : 7));
  });

  // supply chain (shadow): latest deterministic shipped-code scan per runtime package and its release-to-release diff (read-only)
  router.get('/shipped-code', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    res.json(shippedCodeView(db));
  });

  // FE-DEDUPE (audit 11-10): duplicate clusters among Frontier Experts units and the FE metrics a collapse would change — read-only, never merged
  router.get('/expert-dedupe', requireAuth, requirePermission('read:evidence'), (req, res) => {
    res.json(expertUnitDedupe(db, { limit: Number(req.query.limit) || 20 }));
  });

  // intervention 3 (shadow): template-duplicate groups among memory candidates and promoted memories + consolidation proposals (read-only, never applied)
  router.get('/memory-templates', requireAuth, requirePermission('read:evidence'), (req, res) => {
    res.json(memoryTemplateAnalysis(db, { minSize: Number(req.query.min_size) || 2, limit: Number(req.query.limit) || 50 }));
  });

  // K4 (shadow, SKILL_DISTILLATION_MODE): distilled skill / anti-pattern cards by lane and status + the latest cards (read-only, never injected)
  router.get('/skills', requireAuth, requirePermission('read:evidence'), (req, res) => {
    res.json(skillCardsView(db, process.env, Number(req.query.limit) || 20));
  });

  // K5: the newest stored evolution digest (EVOLUTION_FEEDBACK_MODE=shadow|on writes one per day; null before the first)
  router.get('/evolution-digest', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    res.json({ mode: evolutionFeedbackMode(), digest: latestEvolutionDigest(db) });
  });

  // RX-1 (Phase F): evolution evidence — flags, outcomes per source, loop PRs, genomes/holdouts, gym per tier, Realm Gates (read-only)
  router.get('/evolution-evidence', requireAuth, requirePermission('manage:config'), (req, res) => {
    res.json(buildEvolutionEvidence(db, process.env, Date.now(), Number(req.query.days) || 30));
  });

  // TRAINING_DATASET_EXPORT=shadow: counts of the read-only maker fine-tune dataset (source × split × outcome, readiness); never a diff
  router.get('/training-dataset', requireAuth, requirePermission('manage:config'), (_req, res) => {
    if (trainingDatasetMode() !== 'shadow') { res.status(404).json({ error: 'disabled', flag: 'TRAINING_DATASET_EXPORT' }); return; }
    res.json({ mode: 'shadow', ...trainingDatasetSummary(buildTrainingDataset(db)) });
  });

  // E4 (VALUE_ALLOCATOR_MODE=shadow): per consumer 7 d / 30 d resources, credited value, class and the allocation it WOULD propose (never applied)
  router.get('/value-allocation', requireAuth, requirePermission('manage:config'), (_req, res) => {
    if (valueAllocatorMode() !== 'shadow') { res.status(404).json({ error: 'disabled', flag: 'VALUE_ALLOCATOR_MODE' }); return; }
    res.json({ ...buildValueAllocation(db), latest_judgment: latestValueAllocation(db) });
  });

  // E3: provenance DAG with edge evidence (read-only); ?days= limits to proposals of the window (default: all history)
  router.get('/provenance-dag', requireAuth, requirePermission('read:evidence'), (req, res) => {
    const days = Number(req.query.days);
    res.json(provenanceDag(db, Date.now(), { windowDays: Number.isFinite(days) && days > 0 ? Math.min(days, 3650) : null, edgeLimit: 2000 }));
  });

  // RX-7 (Phase F, shadow): forecast scoring V2 — trailing out-of-sample base rate, bootstrap CIs, decision_grade, and what V1 vs V2 would stop
  router.get('/forecasts-v2', requireAuth, requirePermission('read:evidence'), (_req, res) => {
    res.json(forecastScoresV2(db));
  });

  // plan S3: the running configuration, read-only; secrets masked by name and value; admins only
  router.get('/config', requireAuth, requirePermission('manage:config'), (_req, res) => {
    res.json(runtimeConfigView());
  });

  // service map: reachability of the endpoints this server is configured to use (env only, no credentials sent),
  // plus the DF-07 state ladder from durable business evidence in this db
  router.get('/services', requireAuth, requirePermission('read:evidence'), async (_req, res, next) => {
    try { res.json({ services: await serviceMap(process.env, fetch, Date.now(), db) }); } catch (error) { next(error); }
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
