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
  const requireSession = (runId: string, res: any): boolean => {
    if (canvas.getSessionStatus(runId)) return true;
    res.status(404).json({ error: { message: 'Session not found', code: 'CANVAS_SESSION_NOT_FOUND' } });
    return false;
  };

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
    if (typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: { message: 'content is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    if (!requireSession(req.params.runId, res)) return;
    canvas.streamThinking(req.params.runId, content, agentId);
    res.json({ streamed: true });
  });

  // POST /api/canvas/sessions/:runId/tool-call — stream tool call
  router.post('/sessions/:runId/tool-call', requirePermission('write:swarm_action'), (req, res) => {
    const { tool, args, agentId } = req.body;
    if (typeof tool !== 'string' || !tool.trim() || !args || typeof args !== 'object' || Array.isArray(args)) {
      res.status(400).json({ error: { message: 'tool and object args are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    if (!requireSession(req.params.runId, res)) return;
    canvas.streamToolCall(req.params.runId, tool, args, agentId);
    res.json({ streamed: true });
  });

  // POST /api/canvas/sessions/:runId/tool-result — stream tool result
  router.post('/sessions/:runId/tool-result', requirePermission('write:swarm_action'), (req, res) => {
    const { tool, result, agentId } = req.body;
    if (typeof tool !== 'string' || !tool.trim() || typeof result !== 'string') {
      res.status(400).json({ error: { message: 'tool and string result are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    if (!requireSession(req.params.runId, res)) return;
    canvas.streamToolResult(req.params.runId, tool, result, agentId);
    res.json({ streamed: true });
  });

  // POST /api/canvas/sessions/:runId/diff — stream code diff
  router.post('/sessions/:runId/diff', requirePermission('write:swarm_action'), (req, res) => {
    const { filePath, diff, agentId } = req.body;
    if (typeof filePath !== 'string' || !filePath.trim() || typeof diff !== 'string') {
      res.status(400).json({ error: { message: 'filePath and string diff are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    if (!requireSession(req.params.runId, res)) return;
    canvas.streamCodeDiff(req.params.runId, filePath, diff, agentId);
    res.json({ streamed: true });
  });

  // POST /api/canvas/sessions/:runId/progress — stream progress
  router.post('/sessions/:runId/progress', requirePermission('write:swarm_action'), (req, res) => {
    const { current, total, label } = req.body;
    if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0 || current < 0 || current > total) {
      res.status(400).json({ error: { message: 'current and total must be finite progress values', code: 'VALIDATION_ERROR' } });
      return;
    }
    if (!requireSession(req.params.runId, res)) return;
    canvas.streamProgress(req.params.runId, current, total, label || '');
    res.json({ streamed: true });
  });

  // POST /api/canvas/sessions/:runId/complete — mark session complete
  router.post('/sessions/:runId/complete', requirePermission('write:swarm_action'), (req, res) => {
    const { summary } = req.body;
    if (!requireSession(req.params.runId, res)) return;
    canvas.completeSession(req.params.runId, summary || 'Completed');
    res.json({ completed: true });
  });

  return router;
}
