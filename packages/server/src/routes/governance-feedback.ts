/**
 * Governance Feedback Loop routes — REST API for the governance-driven
 * self-improvement loop.
 *
 * Endpoints:
 *   GET  /api/governance-feedback/health — loop health status
 *   POST /api/governance-feedback/analyze — analyze failures for an agent
 *   POST /api/governance-feedback/propose — create improvement proposals
 *   POST /api/governance-feedback/run — run full feedback loop
 *   GET  /api/governance-feedback/history — loop execution history
 *   GET  /api/governance-feedback/proposals — list proposals by status
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import type { WebSocketService } from '../services/websocket-service';
import { ApprovalService } from '../services/approval-service';
import { AuditService } from '../services/audit-service';
import { GovernanceFeedbackLoopService } from '../services/governance-feedback-loop';

export function createGovernanceFeedbackRoutes(db: Database, auth?: AuthMiddleware, wsService?: WebSocketService): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const approvalService = wsService ? new ApprovalService(db, wsService, new AuditService(db)) : undefined;
  const service = new GovernanceFeedbackLoopService(db, {}, approvalService);

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

    if (!req.user) {
      res.status(401).json({ error: { message: 'Authentication required', code: 'AUTH_REQUIRED' } });
      return;
    }

    try {
      const result = await service.runFeedbackLoop(agent_id, req.user);
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
