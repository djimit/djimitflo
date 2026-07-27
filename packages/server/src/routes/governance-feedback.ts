/**
 * Governance Feedback Loop routes — REST API for the governance-driven
 * self-improvement loop.
 *
 * Endpoints:
 *   GET  /api/governance-feedback/health — loop health status
 *   POST /api/governance-feedback/analyze — analyze failures for an agent
 *   POST /api/governance-feedback/propose — create improvement proposals
 *   POST /api/governance-feedback/authorize — authorize proposals via ToolBroker
 *   POST /api/governance-feedback/run — run full feedback loop
 *   GET  /api/governance-feedback/history — loop execution history
 *   GET  /api/governance-feedback/proposals — list proposals by status
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { GovernanceFeedbackLoopService } from '../services/governance-feedback-loop';
import { OpenMythosEvalService } from '../services/openmythos-eval-service';
import type { ExecutionEngine } from '../execution/execution-engine';
import type { ExecutorKind } from '../execution/types';
import { randomUUID } from 'crypto';

export function createGovernanceFeedbackRoutes(
  db: Database,
  auth?: AuthMiddleware,
  executionEngine?: ExecutionEngine,
): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const evaluator = new OpenMythosEvalService(db);
  const service = new GovernanceFeedbackLoopService(db, {}, {
    dispatchImprovement: async (proposal, agentId) => {
      if (!executionEngine) throw new Error('GOVERNANCE_EXECUTION_ENGINE_UNAVAILABLE');
      const taskId = randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO tasks (
          id, title, description, status, priority, risk_level, execution_mode,
          tags, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', 'high', ?, 'local', ?, ?, ?, ?)
      `).run(
        taskId,
        proposal.title,
        proposal.description,
        proposal.risk_level,
        JSON.stringify(['governance-feedback', proposal.category]),
        JSON.stringify({
          governance_proposal_id: proposal.id,
          target_finding_ids: proposal.target_finding_ids,
          subject_agent_id: agentId,
        }),
        now,
        now,
      );
      const result = await executionEngine.executeTask(
        taskId,
        (process.env.GOVERNANCE_FEEDBACK_EXECUTOR || 'opencode') as ExecutorKind,
      );
      const status = result.status === 'started'
        ? await executionEngine.waitForTaskCompletion(taskId)
        : result.status;
      return { taskId, status };
    },
    rerunEvaluation: async (agentId, caseIds) => {
      const result = await evaluator.runEval(agentId, undefined, undefined, caseIds);
      return { runId: result.id };
    },
  });

  // GET /api/governance-feedback/health — loop health status
  router.get('/health', requirePermission('read:evidence'), (_req, res) => {
    const history = service.getLoopHistory(1);
    const proposals = service.getProposalsByStatus('proposed');
    res.json({
      status: 'healthy',
      last_run: history[0]?.created_at || null,
      pending_proposals: proposals.length,
      total_runs: history.length,
    });
  });

  // POST /api/governance-feedback/analyze — analyze failures
  router.post('/analyze', requirePermission('write:governance'), (req, res) => {
    const { agent_id } = req.body;
    if (!agent_id) {
      res.status(400).json({ error: { message: 'agent_id is required', code: 'VALIDATION_ERROR' } });
      return;
    }

    const failures = service.analyzeFailures(agent_id);
    res.json({
      agent_id,
      failures_detected: failures.length,
      failures,
    });
  });

  // POST /api/governance-feedback/propose — create proposals from failures
  router.post('/propose', requirePermission('write:governance'), (req, res) => {
    const { agent_id } = req.body;
    if (!agent_id) {
      res.status(400).json({ error: { message: 'agent_id is required', code: 'VALIDATION_ERROR' } });
      return;
    }

    const failures = service.analyzeFailures(agent_id);
    const proposals = service.createProposals(failures);

    res.json({
      agent_id,
      proposals_created: proposals.length,
      proposals,
    });
  });

  // POST /api/governance-feedback/run — run full feedback loop
  router.post('/run', requirePermission('write:governance'), async (req, res) => {
    const { agent_id } = req.body;
    if (!agent_id) {
      res.status(400).json({ error: { message: 'agent_id is required', code: 'VALIDATION_ERROR' } });
      return;
    }

    const principal = (req.user || {
      sub: 'system',
      email: 'system@djimitflo',
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }) as import('@djimitflo/shared').AuthTokenPayload;

    try {
      const result = await service.runFeedbackLoop(agent_id, principal);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: {
          message: `Feedback loop failed: ${error instanceof Error ? error.message : String(error)}`,
          code: 'FEEDBACK_LOOP_ERROR',
        },
      });
    }
  });

  // GET /api/governance-feedback/history — loop execution history
  router.get('/history', requirePermission('read:evidence'), (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const history = service.getLoopHistory(limit);
    res.json({ history });
  });

  // GET /api/governance-feedback/proposals — list proposals
  router.get('/proposals', requirePermission('read:evidence'), (req, res) => {
    const status = (req.query.status as string) || 'proposed';
    const proposals = service.getProposalsByStatus(status as any);
    res.json({ proposals, count: proposals.length });
  });

  // GET /api/governance-feedback/dormant-capabilities — detect unused capabilities
  router.get('/dormant-capabilities', requirePermission('read:evidence'), (_req, res) => {
    const dormant = service.detectDormantCapabilities();
    res.json({ dormant_capabilities: dormant, count: dormant.length });
  });

  return router;
}
