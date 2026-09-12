/**
 * Swarm routes — orchestration control plane API.
 *
 * Refactored from monolithic 1138-line file into focused route factories:
 * - createWorkerRoutes: worker pool, scheduler, handoffs (write:swarm_action)
 * - createIntelligenceRoutes: capabilities (write:capability), specialists, economy, mission control
 * - createGovernanceRoutes: proof runs, evolution, assurance, memory (write:governance)
 * - createKnowledgeRoutes: OKF knowledge, runtime readiness
 *
 * Remaining routes (fix pipeline, expert swarm, RSI, learning loop, hypotheses,
 * missions) stay here as they are tightly coupled to their specific services.
 *
 * Permission scopes used across all swarm routes:
 * read:evidence, write:swarm_action, write:capability, write:governance, write:claim, write:runner_manifest
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { mountRoutes } from '../utils/route-inventory';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { createError } from '../middleware/error-handler';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { LoopService } from '../services/loop-service';
import { OpenCodeHealthService } from '../services/opencode-health-service';
import { SwarmStatusService } from '../services/swarm-status-service';
import { ExpertSwarmOrchestrator } from '../services/expert-swarm-orchestrator';
import { OkfKnowledgeUpdater } from '../services/okf-knowledge-updater';
import { ServiceRefactoringAnalyzer } from '../services/service-refactoring-analyzer';
import { EmergentSpecializationService } from '../services/emergent-specialization-service';
import { RsiSafetyGuard } from '../services/rsi-safety-guard';
import { ContinuousLearningLoop } from '../services/continuous-learning-loop';
import { FixLoopService } from '../services/fix-loop-service';
import type { WebSocketService } from '../services/websocket-service';
import { createWorkerRoutes } from './swarm-workers';
import { createIntelligenceRoutes } from './swarm-intel';
import { createGovernanceRoutes } from './swarm-governance';
import { createKnowledgeRoutes } from './swarm-knowledge';

type RouteHandler = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function route(handler: RouteHandler): RouteHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = handler(req, res, next);
      if (result instanceof Promise) {
        result.catch(next);
      }
    } catch (error) {
      next(error);
    }
  };
}

function boundedLimit(value: unknown, fallback = 100): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw createError(400, 'limit must be an integer between 1 and 500', 'VALIDATION_ERROR');
  }
  return limit;
}

function boundedParallel(value: unknown, fallback = 3): number {
  if (value === undefined) return fallback;
  const parallel = Number(value);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 10) {
    throw createError(400, 'max_parallel must be an integer between 1 and 10', 'VALIDATION_ERROR');
  }
  return parallel;
}

function mapSwarmIntelligenceError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'SWARM_INTELLIGENCE_SECRET_DETECTED') throw createError(400, 'swarm intelligence payload appears to contain a secret', 'SWARM_INTELLIGENCE_SECRET_DETECTED');
  if (message === 'KNOWLEDGE_RUNTIME_OKF_PATH_ESCAPE') throw createError(403, 'OKF path is outside allowed roots', 'KNOWLEDGE_RUNTIME_OKF_PATH_ESCAPE');
  if (message?.startsWith('CAPABILITY_PROMOTION_EVIDENCE_REQUIRED')) throw createError(409, 'capability promotion requires evidence refs', 'CAPABILITY_PROMOTION_EVIDENCE_REQUIRED');
  if (message?.startsWith('CAPABILITY_PROMOTION_SECURITY_CHECKER_REQUIRED')) throw createError(409, 'high/critical capability promotion requires security checker ref', 'CAPABILITY_PROMOTION_SECURITY_CHECKER_REQUIRED');
  if (message?.startsWith('CAPABILITY_PROMOTION_HUMAN_APPROVAL_REQUIRED')) throw createError(409, 'high/critical capability promotion requires human approval ref', 'CAPABILITY_PROMOTION_HUMAN_APPROVAL_REQUIRED');
  if (message?.startsWith('SWARM_INVALID_TRANSITION:')) { const [, from, to] = message.split(':'); throw createError(400, `invalid state transition: ${from} -> ${to}`, 'SWARM_INVALID_TRANSITION'); }
  if (message === 'SWARM_MISSION_NOT_FOUND') throw createError(404, 'swarm mission not found', 'SWARM_MISSION_NOT_FOUND');
  if (message === 'SWARM_MISSION_TITLE_REQUIRED') throw createError(400, 'mission title is required', 'SWARM_MISSION_TITLE_REQUIRED');
  if (message === 'SWARM_MISSION_RISK_INVALID') throw createError(400, 'mission risk class is invalid', 'SWARM_MISSION_RISK_INVALID');
  if (message === 'SWARM_TASK_NOT_FOUND') throw createError(404, 'swarm task not found', 'SWARM_TASK_NOT_FOUND');
  if (message === 'SWARM_TASK_TITLE_REQUIRED') throw createError(400, 'task title is required', 'SWARM_TASK_TITLE_REQUIRED');
  if (message === 'SWARM_TASK_MISSION_REQUIRED') throw createError(400, 'task mission_id is required', 'SWARM_TASK_MISSION_REQUIRED');
  if (message === 'SWARM_DECISION_TYPE_INVALID') throw createError(400, 'decision type is invalid', 'SWARM_DECISION_TYPE_INVALID');
  if (message === 'SWARM_DECISION_REQUIRED') throw createError(400, 'decision is required', 'SWARM_DECISION_REQUIRED');
  if (message === 'SWARM_CAPABILITY_NOT_FOUND') throw createError(404, 'Capability not found', 'SWARM_CAPABILITY_NOT_FOUND');
  if (message === 'SWARM_CAPABILITY_ID_REQUIRED') throw createError(400, 'capability id is required', 'SWARM_CAPABILITY_ID_REQUIRED');
  if (message === 'SWARM_CAPABILITY_KIND_INVALID') throw createError(400, 'capability kind is invalid', 'SWARM_CAPABILITY_KIND_INVALID');
  if (message === 'SWARM_CAPABILITY_OWNER_REQUIRED') throw createError(400, 'capability owner is required', 'SWARM_CAPABILITY_OWNER_REQUIRED');
  if (message === 'SWARM_CAPABILITY_VERSION_REQUIRED') throw createError(400, 'capability version is required', 'SWARM_CAPABILITY_VERSION_REQUIRED');
  if (message === 'SWARM_CAPABILITY_STATUS_INVALID') throw createError(400, 'capability status is invalid', 'SWARM_CAPABILITY_STATUS_INVALID');
  if (message === 'SWARM_CAPABILITY_RISK_INVALID') throw createError(400, 'capability risk ceiling is invalid', 'SWARM_CAPABILITY_RISK_INVALID');
  if (message === 'SWARM_CAPABILITY_INPUT_SCHEMA_REQUIRED') throw createError(400, 'capability input schema is required', 'SWARM_CAPABILITY_INPUT_SCHEMA_REQUIRED');
  if (message === 'SWARM_CAPABILITY_OUTPUT_SCHEMA_REQUIRED') throw createError(400, 'capability output schema is required', 'SWARM_CAPABILITY_OUTPUT_SCHEMA_REQUIRED');
  if (message === 'SWARM_CAPABILITY_ALLOWED_ACTIONS_REQUIRED') throw createError(400, 'capability allowed actions are required', 'SWARM_CAPABILITY_ALLOWED_ACTIONS_REQUIRED');
  if (message === 'SWARM_CAPABILITY_FORBIDDEN_ACTIONS_REQUIRED') throw createError(400, 'capability forbidden actions are required', 'SWARM_CAPABILITY_FORBIDDEN_ACTIONS_REQUIRED');
  if (message === 'SWARM_CAPABILITY_REQUIRED_EVIDENCE_REQUIRED') throw createError(400, 'capability required evidence is required', 'SWARM_CAPABILITY_REQUIRED_EVIDENCE_REQUIRED');
  if (message === 'SWARM_CAPABILITY_REMOVAL_STRATEGY_REQUIRED') throw createError(400, 'capability removal strategy is required', 'SWARM_CAPABILITY_REMOVAL_STRATEGY_REQUIRED');
  if (message === 'SWARM_OKF_BASE_FORBIDDEN') throw createError(403, 'OKF base path is not permitted', 'SWARM_OKF_BASE_FORBIDDEN');
  if (message === 'SWARM_CLAIM_NOT_FOUND') throw createError(404, 'Claim not found', 'SWARM_CLAIM_NOT_FOUND');
  if (message === 'SWARM_CLAIM_TEXT_REQUIRED') throw createError(400, 'claim text is required', 'SWARM_CLAIM_TEXT_REQUIRED');
  if (message === 'SWARM_CLAIM_TYPE_INVALID') throw createError(400, 'claim type is invalid', 'SWARM_CLAIM_TYPE_INVALID');
  if (message === 'SWARM_CLAIM_REF_NOT_FOUND') throw createError(400, 'claim reference not found', 'SWARM_CLAIM_REF_NOT_FOUND');
  if (message === 'SWARM_CLAIM_SUBJECT_REQUIRED') throw createError(400, 'claim subject_ref is required', 'SWARM_CLAIM_SUBJECT_REQUIRED');
  if (message === 'SWARM_CLAIM_CREATED_FROM_REQUIRED') throw createError(400, 'claim created_from is required', 'SWARM_CLAIM_CREATED_FROM_REQUIRED');
  if (message === 'SWARM_CLAIM_VALID_UNTIL_INVALID') throw createError(400, 'claim valid_until timestamp is invalid', 'SWARM_CLAIM_VALID_UNTIL_INVALID');
  if (message === 'SWARM_EVIDENCE_EDGE_INVALID') throw createError(400, 'evidence edge is invalid', 'SWARM_EVIDENCE_EDGE_INVALID');
  if (message === 'SWARM_RUNNER_DECISION_ID_REQUIRED') throw createError(400, 'runner decision_id is required', 'SWARM_RUNNER_DECISION_ID_REQUIRED');
  if (message === 'SWARM_RUNNER_ACTION_INVALID') throw createError(400, 'runner manifest action is invalid', 'SWARM_RUNNER_ACTION_INVALID');
  if (message === 'SWARM_RUNNER_POLICY_VERSION_REQUIRED') throw createError(400, 'runner policy_version is required', 'SWARM_RUNNER_POLICY_VERSION_REQUIRED');
  if (message === 'SWARM_GOVERNANCE_RISK_INVALID') throw createError(400, 'governance risk_class is invalid', 'SWARM_GOVERNANCE_RISK_INVALID');
  throw error;
}

export function createSwarmRoutes(db: Database, auth?: AuthMiddleware, wsService?: WebSocketService): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new SwarmStatusService(db);
  const intelligence = new SwarmIntelligenceService(db);

  // Shared status endpoint
  router.get('/status', requirePermission('read:evidence'), route((_req, res) => {
    res.json(service.getStatus());
  }));

  // Mount decomposed route factories
  mountRoutes(router, [
    { prefix: '/', middleware: [], router: createWorkerRoutes(db, auth) },
    { prefix: '/', middleware: [], router: createIntelligenceRoutes(db, auth, wsService) },
    { prefix: '/', middleware: [], router: createGovernanceRoutes(db, auth, wsService) },
    { prefix: '/', middleware: [], router: createKnowledgeRoutes(db, auth) },
  ]);

  // === Routes kept in main file (tightly coupled to specific services) ===

  // Specialist panel sub-route (projectPanelToBacklog not in any factory)
  const specialistPanels = new SpecialistPanelService(db);
  router.get('/specialist-panels', requirePermission('read:evidence'), (req, res) => {
    res.json({ panels: specialistPanels.listPanels(boundedLimit(req.query.limit)) });
  });
  router.get('/specialist-panels/:id', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json(specialistPanels.getPanel(req.params.id)); } catch (error: any) {
      next(error?.message === 'SPECIALIST_PANEL_NOT_FOUND'
        ? createError(404, 'specialist panel not found', 'SPECIALIST_PANEL_NOT_FOUND')
        : error);
    }
  });
  router.post('/specialist-panels', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.status(201).json(specialistPanels.createPanel(req.body)); } catch (error: any) {
      if (error.message?.startsWith('SPECIALIST_')) {
        next(createError(400, error.message, error.message));
      } else {
        next(error);
      }
    }
  });
  router.post('/specialist-panels/:id/reviews', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.json(specialistPanels.submitReview(req.params.id, req.body, req.user?.sub || req.user?.email)); } catch (error: any) {
      if (error.message?.startsWith('SPECIALIST_')) {
        next(createError(409, error.message, error.message));
      } else {
        next(error);
      }
    }
  });
  router.post('/specialist-panels/:id/backlog', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.status(201).json(specialistPanels.projectPanelToBacklog(req.params.id)); } catch (error) { next(error); }
  });

  // OpenCode health
  router.get('/opencode/health', requirePermission('read:evidence'), (_req, res, next) => {
    try { const health = new OpenCodeHealthService(); res.json(health.inspectConfig()); } catch (error) { next(error); }
  });

  // Hypotheses
  router.get('/intelligence/hypotheses', requirePermission('read:evidence'), route((req, res) => {
    res.json(intelligence.listHypotheses(boundedLimit(req.query.limit)));
  }));
  router.post('/intelligence/hypotheses', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.status(201).json(intelligence.createHypothesis(req.body || {})); } catch (error) { try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); } }
  });
  router.post('/intelligence/hypotheses/:id/transition', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.json(intelligence.transitionHypothesis(req.params.id, req.body.state, req.body.evidence_refs)); } catch (error) { try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); } }
  });

  // Mission control is authenticated at the /swarms mount, but mutations also
  // require swarm authority and reads require evidence visibility. Keeping the
  // permission boundary here protects direct factory mounts in tests/tools too.
  const missionsSvc = () => new SwarmIntelligenceService(db);
  router.get('/intelligence/missions', requirePermission('read:evidence'), (req, res) => { res.json({ missions: missionsSvc().listMissions(boundedLimit(req.query.limit)) }); });
  router.post('/intelligence/missions', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.status(201).json(missionsSvc().createMission(req.body)); } catch (error) {
      try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); }
    }
  });
  router.get('/intelligence/missions/:id', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json(missionsSvc().getMission(req.params.id)); } catch (error) {
      try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); }
    }
  });
  router.post('/intelligence/missions/:id/transition', requirePermission('write:swarm_action'), (req, res) => { res.json(missionsSvc().transitionMission(req.params.id, req.body.status, req.body)); });
  router.get('/intelligence/missions/:id/tasks', requirePermission('read:evidence'), (req, res) => { res.json({ tasks: missionsSvc().listTasks(req.params.id) }); });
  router.post('/intelligence/missions/:id/tasks', requirePermission('write:swarm_action'), (req, res) => { res.status(201).json(missionsSvc().createTask({ ...req.body, mission_id: req.params.id })); });
  router.post('/intelligence/tasks/:id/transition', requirePermission('write:swarm_action'), (req, res) => { res.json(missionsSvc().transitionTask(req.params.id, req.body.status, req.body)); });
  router.get('/intelligence/missions/:id/decisions', requirePermission('read:evidence'), (req, res) => { res.json({ decisions: missionsSvc().listDecisions(req.params.id) }); });
  router.post('/intelligence/decisions', requirePermission('write:swarm_action'), (req, res) => { res.status(201).json(missionsSvc().recordDecision(req.body)); });

  // Circuit breaker
  router.get('/intelligence/circuit-breaker/:scope', requirePermission('read:evidence'), (req, res) => { res.json(missionsSvc().checkCircuitBreaker(req.params.scope)); });
  router.post('/intelligence/circuit-breaker/:scope/failure', requirePermission('write:swarm_action'), (req, res) => { res.json(missionsSvc().recordCircuitBreakerFailure(req.params.scope)); });
  router.post('/intelligence/circuit-breaker/:scope/reset', requirePermission('write:swarm_action'), (req, res) => { missionsSvc().resetCircuitBreaker(req.params.scope); res.json({ reset: true }); });

  // Expert Swarm
  router.post('/expert/dispatch', requirePermission('write:swarm_action'), route(async (req, res) => {
    const orchestrator = new ExpertSwarmOrchestrator(db);
    const result = await orchestrator.dispatch({ topic: req.body.topic || '', domains: req.body.domains || [], maxParallel: boundedParallel(req.body.max_parallel), sources: req.body.sources });
    res.json(result);
  }));
  router.get('/expert/history', requirePermission('read:evidence'), route((_req, res) => { res.json(new ExpertSwarmOrchestrator(db).getHistory(20)); }));
  router.get('/expert/sources', requirePermission('read:evidence'), route((_req, res) => { res.json({ sources: new ExpertSwarmOrchestrator(db).getAvailableSources() }); }));
  router.get('/expert/updates', requirePermission('read:evidence'), route((_req, res) => { res.json(new OkfKnowledgeUpdater(db).getUpdateHistory(20)); }));

  // RSI Engine
  router.post('/rsi/analyze', requirePermission('write:swarm_action'), route((_req, res) => {
    const analyzer = new ServiceRefactoringAnalyzer(db);
    const proposals = analyzer.analyzeAllServices();
    res.json({ proposals: proposals.length, items: proposals.slice(0, 10) });
  }));
  router.get('/rsi/proposals', requirePermission('read:evidence'), route((req, res) => { res.json(new ServiceRefactoringAnalyzer(db).getProposals(req.query.status as string | undefined)); }));
  router.get('/rsi/specializations', requirePermission('read:evidence'), route((_req, res) => { res.json(new EmergentSpecializationService(db).getSpecializations()); }));
  router.get('/rsi/safety', requirePermission('read:evidence'), route((_req, res) => { res.json(new RsiSafetyGuard(db).getStatus()); }));
  router.post('/rsi/safety/toggle', requirePermission('write:swarm_action'), route((req, res) => {
    if (typeof req.body?.enabled !== 'boolean') throw createError(400, 'enabled must be a boolean', 'VALIDATION_ERROR');
    const guard = new RsiSafetyGuard(db);
    guard.setEnabled(req.body.enabled);
    res.json(guard.getStatus());
  }));

  // Learning Loop
  router.post('/learning/cycle', requirePermission('write:swarm_action'), route(async (_req, res) => { res.json(await new ContinuousLearningLoop(db, { intervalMs: 999999999 }).runCycle()); }));
  router.get('/learning/history', requirePermission('read:evidence'), route((_req, res) => { res.json(new ContinuousLearningLoop(db, { intervalMs: 999999999 }).getHistory(20)); }));
  router.get('/learning/last', requirePermission('read:evidence'), route((_req, res) => { res.json(new ContinuousLearningLoop(db, { intervalMs: 999999999 }).getLastCycle()); }));
  router.get('/learning-curve', requirePermission('read:evidence'), route((_req, res) => {
    const loops = new LoopService(db);
    const runs = loops.listLoopRuns().slice().reverse().map((run) => {
      const metric = loops.computeEfficiencyMetric(run.id);
      return {
        run_id: run.id,
        created_at: run.created_at,
        success: run.status === 'completed',
        retries: Number(run.metadata.retry_count) || 0,
        dollars: metric.dollarsSpent,
      };
    });
    const first = runs[0];
    const last = runs[runs.length - 1];
    res.json({
      runs,
      first_vs_last: {
        first_success_rate: first ? Number(first.success) : 0,
        last_success_rate: last ? Number(last.success) : 0,
        first_cost: first?.dollars || 0,
        last_cost: last?.dollars || 0,
      },
      trend: { retries_decreasing: runs.length > 1 && last.retries < first.retries },
    });
  }));

  router.get('/economy', requirePermission('read:evidence'), route((_req, res) => {
    const capabilities = intelligence.listCapabilities(500)
      .filter((capability) => capability.status === 'validated' || capability.status === 'candidate')
      .map((capability) => {
        const competence = intelligence.measureCompetence(capability.id);
        const p50Dollars = Number(capability.cost_model.p50_dollars) || 0;
        const p95Dollars = Number(capability.cost_model.p95_dollars) || 0;
        return {
          capability_id: capability.id,
          capability_kind: capability.kind,
          status: capability.status,
          n_runs: competence.n_runs,
          n_completed: competence.n_completed,
          success_rate: competence.success_rate,
          p50_tokens: competence.p50_cost,
          p95_tokens: competence.p95_cost,
          p50_dollars: p50Dollars,
          p95_dollars: p95Dollars,
          verified_artifacts_per_dollar: competence.n_completed > 0 && p50Dollars > 0
            ? competence.n_completed / p50Dollars
            : null,
        };
      });
    const loops = new LoopService(db);
    const recentRuns = loops.listLoopRuns().slice(0, 10).map((run) => {
      const metric = loops.computeEfficiencyMetric(run.id);
      return {
        run_id: run.id,
        loop_name: run.loop_name,
        status: run.status,
        verified_artifacts: metric.verifiedArtifacts,
        dollars_spent: metric.dollarsSpent,
        efficiency: metric.efficiency,
      };
    });
    res.json({
      capabilities,
      recent_runs: recentRuns,
      summary: {
        total_capabilities: capabilities.length,
        total_verified_artifacts: recentRuns.reduce((sum, run) => sum + run.verified_artifacts, 0),
        total_dollars_spent: recentRuns.reduce((sum, run) => sum + run.dollars_spent, 0),
      },
    });
  }));

  // Live Code Fix Pipeline (G136)
  const fixLoops = new LoopService(db);
  const parseFixRequest = (value: unknown) => {
    if (!value || typeof value !== 'object') throw createError(400, 'fix request must be an object', 'FIX_REQUEST_INVALID');
    const input = value as Record<string, unknown>;
    const repositoryPath = typeof input.repository_path === 'string' ? input.repository_path.trim() : '';
    const filePath = typeof input.file_path === 'string' ? input.file_path.trim() : '';
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    const category = typeof input.category === 'string' ? input.category : 'bug';
    const runtime = input.runtime === undefined ? 'mock' : typeof input.runtime === 'string' ? input.runtime : '';
    if (!repositoryPath || !filePath || !description) throw createError(400, 'repository_path, file_path and description are required', 'FIX_REQUEST_REQUIRED');
    if (!['bug', 'security', 'performance', 'refactor'].includes(category)) throw createError(400, 'category is invalid', 'FIX_CATEGORY_INVALID');
    if (!['codex', 'opencode', 'claude', 'gemini', 'editor', 'pi', 'mock'].includes(runtime)) throw createError(400, 'runtime is invalid', 'FIX_RUNTIME_INVALID');
    return { repositoryPath, filePath, description, category: category as 'bug' | 'security' | 'performance' | 'refactor', runtime: runtime as 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'pi' | 'mock' };
  };
  router.post('/fix', requirePermission('write:swarm_action'), route(async (req, res) => {
    const fixService = new FixLoopService(db, fixLoops);
    res.json(await fixService.fixFile(parseFixRequest(req.body)));
  }));
  router.post('/fix/batch', requirePermission('write:swarm_action'), route(async (req, res) => {
    const fixService = new FixLoopService(db, fixLoops);
    const requestsValue = req.body?.requests;
    if (requestsValue !== undefined && !Array.isArray(requestsValue)) throw createError(400, 'requests must be an array', 'FIX_BATCH_REQUESTS_INVALID');
    const requests = (requestsValue || []).map(parseFixRequest);
    res.json({ results: await fixService.fixMultiple(requests) });
  }));
  router.get('/fix/history', requirePermission('read:evidence'), route((_req, res) => { res.json(new FixLoopService(db, fixLoops).getFixHistory(20)); }));

  return router;
}
