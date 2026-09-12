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
import { AgentInteractionLedgerService } from '../services/agent-interaction-ledger-service';
import { OutcomeLearningService } from '../services/outcome-learning-service';
import { ReviewerIndependenceService } from '../services/reviewer-independence-service';
import { BoardHandoffService } from '../services/board-handoff-service';

function boundedLimit(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw createError(400, `limit must be an integer between 1 and ${maximum}`, 'VALIDATION_ERROR');
  }
  return limit;
}

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
    if (typeof goal !== 'string' || !goal.trim()
      || (maxParallelism !== undefined && (!Number.isInteger(maxParallelism) || maxParallelism < 1 || maxParallelism > 50))
      || (priority !== undefined && (!Number.isInteger(priority) || priority < 1 || priority > 5))) {
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
    if (typeof agentId !== 'string' || !agentId.trim()
      || typeof topic !== 'string' || !topic.trim()
      || typeof claim !== 'string' || !claim.trim()
      || (confidence !== undefined && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1))
      || (evidence !== undefined && (!Array.isArray(evidence) || evidence.some((item) => typeof item !== 'string')))) {
      res.status(400).json({ error: { message: 'agentId, topic, and claim are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const result = knowledge.publish({ agentId, topic, claim, confidence, evidence });
    res.status(201).json(result);
  });

  router.get('/knowledge/query', requirePermission('read:evidence'), (req, res) => {
    const topic = req.query.topic as string;
    const minConfidence = req.query.min_confidence === undefined ? 0.5 : Number(req.query.min_confidence);
    if (!topic) {
      res.status(400).json({ error: { message: 'topic is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      res.status(400).json({ error: { message: 'min_confidence must be a number between 0 and 1', code: 'VALIDATION_ERROR' } });
      return;
    }
    res.json({ claims: knowledge.query(topic, minConfidence) });
  });

  router.post('/knowledge/subscribe', requirePermission('write:claim'), (req, res) => {
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
    if (typeof claimId !== 'string' || !claimId.trim()
      || typeof agentId !== 'string' || !agentId.trim()
      || typeof agree !== 'boolean'
      || (reason !== undefined && typeof reason !== 'string')) {
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
  router.post('/evolution/register', requirePermission('write:skills'), (req, res) => {
    const { skillId, traits } = req.body;
    const traitNames = ['efficiency', 'reliability', 'generality', 'complexity', 'adaptability'];
    const validTraits = traits === undefined || (traits !== null && !Array.isArray(traits)
      && typeof traits === 'object'
      && Object.entries(traits).every(([name, value]) => traitNames.includes(name)
        && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1));
    if (typeof skillId !== 'string' || !skillId.trim() || !validTraits) {
      res.status(400).json({ error: { message: 'skillId is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const genome = evolution.registerSkill(skillId, traits);
    res.status(201).json(genome);
  });

  router.post('/evolution/evolve', requirePermission('write:skills'), (_req, res) => {
    const nextGen = evolution.evolve();
    res.json({ generation: nextGen.length > 0 ? nextGen[0].generation : 0, count: nextGen.length });
  });

  router.post('/evolution/outcome', requirePermission('write:evidence'), (req, res) => {
    const { skillId, success, tokensUsed, durationMs, domain } = req.body;
    if (typeof skillId !== 'string' || !skillId.trim() || typeof success !== 'boolean'
      || !Number.isFinite(tokensUsed) || tokensUsed < 0 || !Number.isFinite(durationMs) || durationMs < 0
      || typeof domain !== 'string' || !domain.trim()) {
      res.status(400).json({ error: { message: 'skillId, domain, boolean success and nonnegative numeric metrics are required', code: 'VALIDATION_ERROR' } });
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

  router.get('/intelligence/interactions', requirePermission('read:evidence'), (req, res) => {
    const ledger = new AgentInteractionLedgerService(db);
    const interactions = ledger.list({
      agent_id: typeof req.query.agent_id === 'string' ? req.query.agent_id : undefined,
      correlation_id: typeof req.query.correlation_id === 'string' ? req.query.correlation_id : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      source: typeof req.query.source === 'string' ? req.query.source : undefined,
      limit: boundedLimit(req.query.limit, 100, 500),
    });
    res.json({ interactions, ...ledger.dataQuality() });
  });

  router.get('/intelligence/interaction-digest', requirePermission('read:evidence'), (req, res) => {
    res.json(new AgentInteractionLedgerService(db).digest(boundedLimit(req.query.limit, 500, 500)));
  });

  router.post('/intelligence/interaction-handoff/reconcile', requirePermission('write:swarm_action'), (req, res) => {
    const limit = boundedLimit(req.body?.limit, 100, 500);
    res.json(new BoardHandoffService(db).reconcile(limit));
  });

  router.get('/intelligence/outcome-learning', requirePermission('read:evidence'), (req, res) => {
    res.json({ assessments: new OutcomeLearningService(db).list(boundedLimit(req.query.limit, 100, 500)) });
  });

  router.post('/intelligence/outcome-learning/capabilities/:id/release', requirePermission('write:capability'), (req, res, next) => {
    try {
      new OutcomeLearningService(db).releaseContainment(req.params.id, req.body || {});
      res.json({ released: true, capability_id: req.params.id });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'OUTCOME_CONTAINMENT_RELEASE_FAILED';
      next(createError(code.endsWith('_NOT_FOUND') ? 404 : code.endsWith('_REQUIRED') ? 400 : 409,
        'Outcome containment release rejected', code));
    }
  });

  router.get('/intelligence/reviewer-independence', requirePermission('read:evidence'), (req, res) => {
    res.json({ assessments: new ReviewerIndependenceService(db).latest(boundedLimit(req.query.limit, 20, 100)) });
  });

  // ─── OKF Drift ─────────────────────────────────────────────────────
  router.get('/intelligence/okf-drift', requirePermission('read:evidence'), (_req, res) => {
    res.json(intelligence.okfDriftReport());
  });

  // ─── Capabilities ──────────────────────────────────────────────────
  router.get('/intelligence/capabilities', requirePermission('read:evidence'), (req, res) => {
    res.json({ capabilities: intelligence.listCapabilities(boundedLimit(req.query.limit, 100, 500)) });
  });

  router.post('/intelligence/capabilities', requirePermission('write:capability'), (req, res, next) => {
    try {
      const capability = intelligence.registerCapability(req.body);
      res.status(201).json(capability);
    } catch (err: any) {
      if (err.message?.startsWith('SWARM_CAPABILITY_')) {
        next(createError(400, err.message, err.message));
      } else {
        next(err);
      }
    }
  });

  router.post('/intelligence/capabilities/:id/evaluate', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const result = intelligence.evaluateCapability(req.params.id);
      res.json(result);
    } catch (err: any) {
      if (err.message?.startsWith('SWARM_CAPABILITY_')) {
        next(createError(404, err.message, err.message));
      } else {
        next(err);
      }
    }
  });

  router.post('/intelligence/capabilities/:id/promote', requirePermission('write:capability'), (req, res, next) => {
    try {
      res.json(intelligence.promoteCapability(req.params.id, req.body || {}));
    } catch (err: any) {
      if (err.message?.startsWith('CAPABILITY_') || err.message === 'SWARM_CAPABILITY_NOT_FOUND') {
        next(createError(409, err.message, err.message.split(':')[0]));
      } else {
        next(err);
      }
    }
  });

  // ─── Specialists ───────────────────────────────────────────────────
  router.get('/intelligence/specialists', requirePermission('read:evidence'), (_req, res) => {
    res.json({ specialists: specialistPanel.getCatalog() });
  });

  router.get('/specialists/catalog', requirePermission('read:evidence'), (_req, res) => {
    res.json({ specialists: specialistPanel.getCatalog() });
  });

  // ─── Claims ────────────────────────────────────────────────────────
  router.get('/intelligence/claims', requirePermission('read:evidence'), (req, res) => {
    res.json({ claims: intelligence.listClaims(boundedLimit(req.query.limit, 100, 500)) });
  });

  router.post('/intelligence/claims', requirePermission('write:claim'), (req, res, next) => {
    try {
      const input = req.body || {};
      const claimTypes = ['observation', 'hypothesis', 'decision', 'memory', 'capability', 'backlog', 'policy'];
      if (typeof input.claim !== 'string' || !input.claim.trim()
        || !claimTypes.includes(input.claim_type)
        || typeof input.subject_ref !== 'string' || !input.subject_ref.trim()
        || typeof input.created_from !== 'string' || !input.created_from.trim()) {
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'claim, valid claim_type, subject_ref and created_from are required' } });
        return;
      }
      const claim = intelligence.submitClaim(input);
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
