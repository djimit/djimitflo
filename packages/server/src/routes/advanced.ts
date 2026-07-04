/**
 * Advanced services routes — context compression, workflow graphs, governance feedback.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { ContextCompressionService } from '../services/context-compression-service';
import { WorkflowGraphService } from '../services/workflow-graph-service';
import { GovernanceFeedbackService } from '../services/governance-feedback-service';

export function createAdvancedRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  // ─── Context Compression ─────────────────────────────────────────────
  const compression = new ContextCompressionService(db);

  router.get('/compression/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(compression.getStats());
  });

  router.post('/compression/compress', requirePermission('read:evidence'), (req, res) => {
    const { content, type } = req.body;
    if (!content) {
      res.status(400).json({ error: { message: 'content is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    res.json(compression.compress(content, type));
  });

  router.get('/compression/retrieve/:hash', requirePermission('read:evidence'), (req, res) => {
    const original = compression.retrieve(req.params.hash);
    if (!original) {
      res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
      return;
    }
    res.json({ original });
  });

  // ─── Workflow Graphs ──────────────────────────────────────────────────
  const workflows = new WorkflowGraphService(db);

  router.post('/workflows', requirePermission('write:swarm_action'), (req, res) => {
    const { name, description, nodes, edges } = req.body;
    if (!name) {
      res.status(400).json({ error: { message: 'name is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const workflow = workflows.createWorkflow({ name, description, nodes, edges });
    res.status(201).json(workflow);
  });

  router.get('/workflows/:id', requirePermission('read:evidence'), (req, res) => {
    const workflow = workflows.getWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
      return;
    }
    res.json(workflow);
  });

  router.get('/workflows/:id/next', requirePermission('read:evidence'), (req, res) => {
    res.json({ nodes: workflows.getNextNodes(req.params.id) });
  });

  router.post('/workflows/:id/nodes/:nodeId/approve', requirePermission('write:governance'), (req, res) => {
    const { approvedBy } = req.body;
    workflows.approveGate(req.params.id, req.params.nodeId, approvedBy || 'unknown');
    res.json({ approved: true });
  });

  router.post('/workflows/:id/nodes/:nodeId/reject', requirePermission('write:governance'), (req, res) => {
    workflows.rejectGate(req.params.id, req.params.nodeId);
    res.json({ rejected: true });
  });

  router.post('/workflows/:id/nodes/:nodeId/status', requirePermission('write:swarm_action'), (req, res) => {
    const { status, outputs } = req.body;
    workflows.updateNodeStatus(req.params.id, req.params.nodeId, status, outputs);
    res.json({ updated: true });
  });

  // ─── Governance Feedback ──────────────────────────────────────────────
  const feedback = new GovernanceFeedbackService(db);

  router.post('/feedback', requirePermission('write:governance'), (req, res) => {
    const entry = feedback.recordFeedback(req.body);
    res.status(201).json(entry);
  });

  router.get('/feedback/analyze', requirePermission('read:evidence'), (_req, res) => {
    res.json({ proposals: feedback.analyzeFeedback() });
  });

  router.get('/feedback/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(feedback.getStats());
  });

  router.get('/feedback/recent', requirePermission('read:evidence'), (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    res.json({ entries: feedback.getRecentFeedback(limit) });
  });

  router.post('/feedback/apply', requirePermission('write:governance'), (req, res) => {
    const { pattern } = req.body;
    if (!pattern) {
      res.status(400).json({ error: { message: 'pattern is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    feedback.applyFeedback(pattern);
    res.json({ applied: true });
  });

  return router;
}
