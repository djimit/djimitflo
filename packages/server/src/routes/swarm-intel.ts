/**
 * Swarm Intelligence routes — task decomposition, knowledge sharing, skill evolution.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { createError } from '../middleware/error-handler';
import { SwarmTaskDecomposer } from '../services/swarm-task-decomposer';
import { KnowledgeSharingService } from '../services/knowledge-sharing-service';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { SpecialistPanelService } from '../services/specialist-panel-service';

/** @deprecated Backward compatibility for swarms.ts — use createSwarmIntelRoutes */
export function createIntelligenceRoutes(db: Database, auth?: AuthMiddleware, _wsService?: any): Router {
  return createSwarmIntelRoutes(db, auth);
}

export function createSwarmIntelRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  const decomposer = new SwarmTaskDecomposer(db);
  const knowledge = new KnowledgeSharingService(db);
  const evolution = new SkillEvolutionEngine(db);
  const intelligence = new SwarmIntelligenceService(db);
  const specialistPanel = new SpecialistPanelService(db);

  // ─── Task Decomposition ─────────────────────────────────────────────
  router.post('/decompose', requirePermission('write:swarm_action'), (req, res) => {
    const { goal, maxParallelism, priority } = req.body;
    if (!goal?.trim()) {
      res.status(400).json({ error: { message: 'goal is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const plan = decomposer.decompose(goal, { maxParallelism, priority });
    res.status(201).json(plan);
  });

  router.get('/plans', requirePermission('read:evidence'), (_req, res) => {
    res.json({ plans: decomposer.listPlans() });
  });

  router.get('/plans/:id', requirePermission('read:evidence'), (req, res) => {
    const plan = decomposer.getPlan(req.params.id);
    if (!plan) {
      res.status(404).json({ error: { message: 'Plan not found', code: 'NOT_FOUND' } });
      return;
    }
    res.json(plan);
  });

  // ─── Knowledge Sharing ──────────────────────────────────────────────
  router.post('/knowledge/publish', requirePermission('write:claim'), (req, res) => {
    const { agentId, topic, claim, confidence, evidence } = req.body;
    if (!agentId || !topic || !claim) {
      res.status(400).json({ error: { message: 'agentId, topic, and claim are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const result = knowledge.publish({ agentId, topic, claim, confidence, evidence });
    res.status(201).json(result);
  });

  router.get('/knowledge/query', requirePermission('read:evidence'), (req, res) => {
    const topic = req.query.topic as string;
    const minConfidence = req.query.min_confidence ? Number(req.query.min_confidence) : 0.5;
    if (!topic) {
      res.status(400).json({ error: { message: 'topic is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    res.json({ claims: knowledge.query(topic, minConfidence) });
  });

  router.post('/knowledge/subscribe', requirePermission('write:config'), (req, res) => {
    const { agentId, topic, priority } = req.body;
    if (!agentId || !topic) {
      res.status(400).json({ error: { message: 'agentId and topic are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const sub = knowledge.subscribe(agentId, topic, priority);
    res.status(201).json(sub);
  });

  router.post('/knowledge/vote', requirePermission('write:claim'), (req, res) => {
    const { claimId, agentId, agree, reason } = req.body;
    if (!claimId || !agentId || agree === undefined) {
      res.status(400).json({ error: { message: 'claimId, agentId, and agree are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    knowledge.vote(claimId, agentId, agree, reason || '');
    res.json({ voted: true });
  });

  router.get('/knowledge/contradictions', requirePermission('read:evidence'), (_req, res) => {
    res.json({ contradictions: knowledge.getContradictions() });
  });

  router.get('/knowledge/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(knowledge.getStats());
  });

  // ─── Skill Evolution ────────────────────────────────────────────────
  router.post('/evolution/register', requirePermission('write:config'), (req, res) => {
    const { skillId, traits } = req.body;
    if (!skillId) {
      res.status(400).json({ error: { message: 'skillId is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const genome = evolution.registerSkill(skillId, traits);
    res.status(201).json(genome);
  });

  router.post('/evolution/evolve', requirePermission('write:config'), (_req, res) => {
    const nextGen = evolution.evolve();
    res.json({ generation: nextGen.length > 0 ? nextGen[0].generation : 0, count: nextGen.length });
  });

  router.post('/evolution/outcome', requirePermission('write:config'), (req, res) => {
    const { skillId, success, tokensUsed, durationMs, domain } = req.body;
    if (!skillId) {
      res.status(400).json({ error: { message: 'skillId is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    evolution.recordOutcome(skillId, { success, tokensUsed, durationMs, domain });
    res.json({ recorded: true });
  });

  router.get('/evolution/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(evolution.getStats());
  });

  // ─── Runner Manifests ──────────────────────────────────────────────
  router.post('/intelligence/runner-manifests', requirePermission('write:runner_manifest'), (req, res) => {
    const { decision_id, lease_id, loop_run_id, action, policy_version, runtime_contract, capacity_snapshot, budget_snapshot, gate_refs, blocked_reasons, metadata } = req.body;
    if (action === 'complete') {
      res.status(403).json({ error: { message: 'Direct assertion of completed runner manifests is blocked', code: 'RUNNER_MANIFEST_DIRECT_ASSERTION_BLOCKED' } });
      return;
    }
    const manifest = intelligence.createRunnerManifest({ decision_id, lease_id, loop_run_id, action, policy_version, runtime_contract, capacity_snapshot, budget_snapshot, gate_refs, blocked_reasons, metadata });
    res.status(201).json(manifest);
  });

  // ─── Governance Evaluate ───────────────────────────────────────────
  router.post('/intelligence/governance/evaluate', requirePermission('write:swarm_action'), (req, res) => {
    res.json(intelligence.evaluateGovernance(req.body));
  });

  // ─── Mission Control ───────────────────────────────────────────────
  router.get('/intelligence/mission-control', requirePermission('read:evidence'), (_req, res) => {
    res.json(intelligence.missionControl());
  });

  // ─── OKF Drift ─────────────────────────────────────────────────────
  router.get('/intelligence/okf-drift', requirePermission('read:evidence'), (_req, res) => {
    res.json(intelligence.okfDriftReport());
  });

  // ─── Capabilities ──────────────────────────────────────────────────
  router.post('/intelligence/capabilities', requirePermission('write:capability'), (req, res, next) => {
    try {
      const capability = intelligence.registerCapability(req.body);
      res.status(201).json(capability);
    } catch (error: any) {
      if (error.message?.startsWith('SWARM_CAPABILITY_')) {
        next(createError(400, error.message, error.message));
      } else {
        next(error);
      }
    }
  });

  router.post('/intelligence/capabilities/:id/evaluate', requirePermission('read:evidence'), (req, res) => {
    const capability = intelligence.listCapabilities(100).find(c => c.id === req.params.id);
    if (!capability) {
      res.status(404).json({ error: { message: 'Capability not found', code: 'SWARM_CAPABILITY_NOT_FOUND' } });
      return;
    }
    res.json({ id: capability.id, status: capability.status, live_route_allowed: capability.live_route_allowed, blocked_reasons: capability.blocked_reasons });
  });

  // ─── Specialists ───────────────────────────────────────────────────
  router.get('/intelligence/specialists', requirePermission('read:evidence'), (_req, res) => {
    res.json({ specialists: specialistPanel.getCatalog() });
  });

  router.get('/specialists/catalog', requirePermission('read:evidence'), (_req, res) => {
    res.json({ specialists: specialistPanel.getCatalog() });
  });

  // ─── Claims ────────────────────────────────────────────────────────
  router.post('/intelligence/claims', requirePermission('write:claim'), (req, res, next) => {
    try {
      const claim = intelligence.submitClaim(req.body);
      res.status(201).json(claim);
    } catch (error) {
      next(error);
    }
  });

  // ─── Capacity Plan ─────────────────────────────────────────────────
  router.post('/intelligence/capacity/plan', requirePermission('write:swarm_action'), (req, res) => {
    res.json(intelligence.planCapacityV2(req.body || {}));
  });

  return router;
}
