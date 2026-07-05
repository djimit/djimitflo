/**
 * AGI routes — goal reasoning, consensus, predictive analytics.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { AgiGoalReasoningEngine } from '../services/agi-goal-reasoning-engine';
import { MultiAgentConsensusService } from '../services/multi-agent-consensus-service';

export function createAgiRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  const reasoning = new AgiGoalReasoningEngine(db);
  const consensus = new MultiAgentConsensusService(db);

  // ─── Goal Reasoning ─────────────────────────────────────────────────
  router.post('/reason', requirePermission('write:governance'), (_req, res) => {
    const result = reasoning.reason();
    res.json(result);
  });

  router.get('/observe', requirePermission('read:evidence'), (_req, res) => {
    res.json(reasoning.observe());
  });

  router.get('/reasoning/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(reasoning.getStats());
  });

  // ─── Multi-Agent Consensus ──────────────────────────────────────────
  router.post('/consensus/debates', requirePermission('write:governance'), (req, res) => {
    const { topic, context } = req.body;
    if (!topic) {
      res.status(400).json({ error: { message: 'topic is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const debate = consensus.createDebate(topic, context || '');
    res.status(201).json(debate);
  });

  router.post('/consensus/debates/:debateId/proposals', requirePermission('write:governance'), (req, res) => {
    const { agentId, content, evidence, confidence } = req.body;
    if (!agentId || !content) {
      res.status(400).json({ error: { message: 'agentId and content are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const proposal = consensus.submitProposal(req.params.debateId, agentId, content, evidence, confidence);
    res.status(201).json(proposal);
  });

  router.post('/consensus/debates/:debateId/vote', requirePermission('write:governance'), (req, res) => {
    const { proposalId, agentId, type, reason } = req.body;
    if (!proposalId || !agentId || !type) {
      res.status(400).json({ error: { message: 'proposalId, agentId, and type are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    consensus.vote(req.params.debateId, proposalId, agentId, type, reason || '');
    res.json({ voted: true });
  });

  router.post('/consensus/debates/:debateId/resolve', requirePermission('write:governance'), (req, res) => {
    res.json(consensus.resolve(req.params.debateId));
  });

  router.get('/consensus/debates/:debateId', requirePermission('read:evidence'), (req, res) => {
    const debate = consensus.getDebate(req.params.debateId);
    if (!debate) {
      res.status(404).json({ error: { message: 'Debate not found', code: 'NOT_FOUND' } });
      return;
    }
    res.json(debate);
  });

  router.get('/consensus/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(consensus.getStats());
  });

  return router;
}
