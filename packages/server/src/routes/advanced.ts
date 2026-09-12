/**
 * Advanced services routes — context compression, workflow graphs, governance feedback.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { ContextCompressionService } from '../services/context-compression-service';
import { WorkflowGraphService } from '../services/workflow-graph-service';
import { GovernanceFeedbackService } from '../services/governance-feedback-service';

function requireWorkflowNode(workflows: WorkflowGraphService, workflowId: string, nodeId: string, res: any): boolean {
  const workflow = workflows.getWorkflow(workflowId);
  if (!workflow || !workflow.nodes.some((node) => node.id === nodeId)) {
    res.status(404).json({ error: { code: 'WORKFLOW_NODE_NOT_FOUND', message: 'Workflow or node not found' } });
    return false;
  }
  return true;
}

function requireWorkflowGate(workflows: WorkflowGraphService, workflowId: string, nodeId: string, res: any): boolean {
  if (!requireWorkflowNode(workflows, workflowId, nodeId, res)) return false;
  const node = workflows.getWorkflow(workflowId)?.nodes.find((candidate) => candidate.id === nodeId);
  if (node?.type !== 'gate') {
    res.status(409).json({ error: { code: 'WORKFLOW_GATE_REQUIRED', message: 'Workflow node is not an approval gate' } });
    return false;
  }
  return true;
}

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
    if (!workflows.getWorkflow(req.params.id)) {
      res.status(404).json({ error: { code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found' } });
      return;
    }
    res.json({ nodes: workflows.getNextNodes(req.params.id) });
  });

  router.post('/workflows/:id/nodes/:nodeId/approve', requirePermission('write:governance'), (req, res) => {
    if (!requireWorkflowGate(workflows, req.params.id, req.params.nodeId, res)) return;
    const { approvedBy } = req.body;
    workflows.approveGate(req.params.id, req.params.nodeId, approvedBy || 'unknown');
    res.json({ approved: true });
  });

  router.post('/workflows/:id/nodes/:nodeId/reject', requirePermission('write:governance'), (req, res) => {
    if (!requireWorkflowGate(workflows, req.params.id, req.params.nodeId, res)) return;
    workflows.rejectGate(req.params.id, req.params.nodeId);
    res.json({ rejected: true });
  });

  router.post('/workflows/:id/nodes/:nodeId/status', requirePermission('write:swarm_action'), (req, res) => {
    if (!requireWorkflowNode(workflows, req.params.id, req.params.nodeId, res)) return;
    const { status, outputs } = req.body;
    workflows.updateNodeStatus(req.params.id, req.params.nodeId, status, outputs);
    res.json({ updated: true });
  });

  // ─── Governance Feedback ──────────────────────────────────────────────
  const feedback = new GovernanceFeedbackService(db);

  router.post('/feedback', requirePermission('write:governance'), (req, res) => {
    const input = req.body || {};
    const sources = ['openmythos_case', 'runtime_violation', 'human_correction', 'self_modification'];
    if (!sources.includes(input.source)
      || typeof input.category !== 'string' || !input.category.trim()
      || typeof input.originalDecision !== 'string' || !input.originalDecision.trim()
      || typeof input.correctedDecision !== 'string' || !input.correctedDecision.trim()
      || typeof input.reason !== 'string' || !input.reason.trim()
      || (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1))) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'source, category, originalDecision, correctedDecision and reason are required; confidence must be between 0 and 1' } });
      return;
    }
    const entry = feedback.recordFeedback(input);
    res.status(201).json(entry);
  });

  router.get('/feedback/analyze', requirePermission('read:evidence'), (_req, res) => {
    res.json({ proposals: feedback.analyzeFeedback() });
  });

  router.get('/feedback/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(feedback.getStats());
  });

  router.get('/feedback/recent', requirePermission('read:evidence'), (req, res) => {
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      res.status(400).json({ error: { message: 'limit must be an integer between 1 and 100', code: 'VALIDATION_ERROR' } });
      return;
    }
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
