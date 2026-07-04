/**
 * Live Canvas routes — real-time agent output streaming.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { LiveCanvasService } from '../services/live-canvas-service';

export function createCanvasRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const canvas = new LiveCanvasService(db);

  // GET /api/canvas/sessions — list active canvas sessions
  router.get('/sessions', requirePermission('read:evidence'), (_req, res) => {
    res.json({ sessions: canvas.listSessions() });
  });

  // GET /api/canvas/sessions/:runId — get session status
  router.get('/sessions/:runId', requirePermission('read:evidence'), (req, res) => {
    const status = canvas.getSessionStatus(req.params.runId);
    if (!status) {
      res.status(404).json({ error: { message: 'Session not found', code: 'NOT_FOUND' } });
      return;
    }
    res.json(status);
  });

  // POST /api/canvas/sessions — create a new canvas session
  router.post('/sessions', requirePermission('write:swarm_action'), (req, res) => {
    const { runId } = req.body;
    if (!runId) {
      res.status(400).json({ error: { message: 'runId is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const session = canvas.createSession(runId);
    res.status(201).json({ session_id: session.id, run_id: runId });
  });

  // POST /api/canvas/sessions/:runId/thinking — stream thinking
  router.post('/sessions/:runId/thinking', requirePermission('write:swarm_action'), (req, res) => {
    const { content, agentId } = req.body;
    canvas.streamThinking(req.params.runId, content, agentId);
    res.json({ streamed: true });
  });

  // POST /api/canvas/sessions/:runId/tool-call — stream tool call
  router.post('/sessions/:runId/tool-call', requirePermission('write:swarm_action'), (req, res) => {
    const { tool, args, agentId } = req.body;
    canvas.streamToolCall(req.params.runId, tool, args, agentId);
    res.json({ streamed: true });
  });

  // POST /api/canvas/sessions/:runId/tool-result — stream tool result
  router.post('/sessions/:runId/tool-result', requirePermission('write:swarm_action'), (req, res) => {
    const { tool, result, agentId } = req.body;
    canvas.streamToolResult(req.params.runId, tool, result, agentId);
    res.json({ streamed: true });
  });

  // POST /api/canvas/sessions/:runId/diff — stream code diff
  router.post('/sessions/:runId/diff', requirePermission('write:swarm_action'), (req, res) => {
    const { filePath, diff, agentId } = req.body;
    canvas.streamCodeDiff(req.params.runId, filePath, diff, agentId);
    res.json({ streamed: true });
  });

  // POST /api/canvas/sessions/:runId/progress — stream progress
  router.post('/sessions/:runId/progress', requirePermission('write:swarm_action'), (req, res) => {
    const { current, total, label } = req.body;
    canvas.streamProgress(req.params.runId, current, total, label || '');
    res.json({ streamed: true });
  });

  // POST /api/canvas/sessions/:runId/complete — mark session complete
  router.post('/sessions/:runId/complete', requirePermission('write:swarm_action'), (req, res) => {
    const { summary } = req.body;
    canvas.completeSession(req.params.runId, summary || 'Completed');
    res.json({ completed: true });
  });

  return router;
}
