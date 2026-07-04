/**
 * Intelligence routes — capabilities, specialists, claims, economy, mission control.
 *
 * Extracted from swarms.ts (Phase B3 decomposition).
 * Handles: capability management, specialist panels, claims, economy metrics,
 * mission control dashboard.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import type { AuthMiddleware } from '../middleware/auth';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { ProofRunService } from '../services/proof-run-service';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import type { WebSocketService } from '../services/websocket-service';

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

function mapSpecialistPanelError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'SPECIALIST_PANEL_NOT_FOUND') throw createError(404, 'Specialist panel not found', 'SPECIALIST_PANEL_NOT_FOUND');
  if (message === 'SPECIALIST_PANEL_TOPIC_REQUIRED') throw createError(400, 'topic is required', 'SPECIALIST_PANEL_TOPIC_REQUIRED');
  if (message === 'SPECIALIST_PANEL_QUESTION_REQUIRED') throw createError(400, 'question is required', 'SPECIALIST_PANEL_QUESTION_REQUIRED');
  if (message === 'SPECIALIST_PANEL_RISK_INVALID') throw createError(400, 'risk_class is invalid', 'SPECIALIST_PANEL_RISK_INVALID');
  if (message === 'SPECIALIST_PROFILE_UNKNOWN') throw createError(400, 'specialist profile is unknown', 'SPECIALIST_PROFILE_UNKNOWN');
  if (message === 'SPECIALIST_PANEL_TOO_SMALL') throw createError(400, 'panel requires at least two specialists', 'SPECIALIST_PANEL_TOO_SMALL');
  if (message === 'SPECIALIST_PANEL_SECURITY_REVIEWER_REQUIRED') throw createError(400, 'high-risk panels require security_reviewer', 'SPECIALIST_PANEL_SECURITY_REVIEWER_REQUIRED');
  if (message === 'SPECIALIST_PANEL_CLOSED') throw createError(409, 'specialist panel is closed', 'SPECIALIST_PANEL_CLOSED');
  if (message === 'SPECIALIST_REVIEW_SPECIALIST_REQUIRED') throw createError(400, 'specialist_id is required', 'SPECIALIST_REVIEW_SPECIALIST_REQUIRED');
  if (message === 'SPECIALIST_REVIEW_STANCE_INVALID') throw createError(400, 'stance is invalid', 'SPECIALIST_REVIEW_STANCE_INVALID');
  if (message === 'SPECIALIST_REVIEW_CONFIDENCE_INVALID') throw createError(400, 'confidence is invalid', 'SPECIALIST_REVIEW_CONFIDENCE_INVALID');
  if (message === 'SPECIALIST_REVIEWER_NOT_IN_PANEL') throw createError(400, 'reviewer is not in panel', 'SPECIALIST_REVIEWER_NOT_IN_PANEL');
  if (message === 'SPECIALIST_PANEL_CONSENSUS_REQUIRED') throw createError(409, 'panel consensus is required before backlog projection', 'SPECIALIST_PANEL_CONSENSUS_REQUIRED');
  if (message === 'SPECIALIST_PANEL_BLOCKED') throw createError(409, 'blocked panel cannot be projected to backlog', 'SPECIALIST_PANEL_BLOCKED');
  throw error;
}

export function createIntelligenceRoutes(db: Database, auth?: AuthMiddleware, _wsService?: WebSocketService): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const intelligence = new SwarmIntelligenceService(db);
  const proofRuns = new ProofRunService(db);
  const specialistPanels = new SpecialistPanelService(db);

  // Mission control
  router.get('/intelligence/mission-control', requirePermission('read:evidence'), (req, res, next) => {
    if (req.query.live === 'true') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      try {
        const latest = proofRuns.latest();
        const snapshot = { ...intelligence.missionControl(), latest_proof_run: latest };
        res.write(`data: ${JSON.stringify({ type: 'snapshot', data: snapshot })}\n\n`);
      } catch { /* best-effort */ }
      const { swarmEventBus } = require('../services/swarm-event-bus');
      const unsub = swarmEventBus.subscribe((event: any) => { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* disconnected */ } });
      const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { clearInterval(ka); } }, 15_000);
      req.on('close', () => { unsub(); clearInterval(ka); });
      return;
    }
    try {
      const latest = proofRuns.latest();
      res.json({ ...intelligence.missionControl(), latest_proof_run: latest });
    } catch (error) {
      try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); }
      next(error);
    }
  });

  // Economy
  router.get('/economy', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      const caps = intelligence.listCapabilities().filter((c) => c.status === 'validated' || c.status === 'candidate');
      const economies = caps.map((cap) => {
        const competence = intelligence.measureCompetence(cap.id);
        const costModel = cap.cost_model as Record<string, unknown>;
        const p50Dollars = typeof costModel.p50_dollars === 'number' ? costModel.p50_dollars : 0;
        const efficiency = competence.n_completed > 0 && p50Dollars > 0 ? competence.n_completed / p50Dollars : null;
        return { capability_id: cap.id, capability_kind: cap.kind, status: cap.status, n_runs: competence.n_runs, n_completed: competence.n_completed, success_rate: competence.success_rate, p50_dollars: p50Dollars, verified_artifacts_per_dollar: efficiency };
      });
      res.json({ capabilities: economies, summary: { total_capabilities: economies.length } });
    } catch (error) { next(error); }
  });

  // Learning curve
  router.get('/learning-curve', requirePermission('read:evidence'), (_req, res) => {
    res.json({ message: 'Learning curve data available via /api/swarms/status' });
  });

  // Capabilities
  router.get('/intelligence/capabilities', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json({ capabilities: intelligence.listCapabilities(req.query.limit ? Number(req.query.limit) : undefined) }); } catch (error) { try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/intelligence/capabilities', requirePermission('write:capability'), (req, res, next) => {
    try { res.status(201).json(intelligence.registerCapability(req.body || {})); } catch (error) { try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/intelligence/capabilities/candidate', requirePermission('write:capability'), (req, res, next) => {
    try { res.status(201).json(intelligence.createCandidate(req.body || {})); } catch (error) { try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/intelligence/capabilities/:id/promote', requirePermission('write:capability'), (req, res, next) => {
    try { res.json(intelligence.promoteCapability(req.params.id, req.body || {})); } catch (error) { try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/intelligence/capabilities/:id/evaluate', requirePermission('write:capability'), (req, res, next) => {
    try { res.json(intelligence.evaluateCapability(req.params.id)); } catch (error) { try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  // Specialists
  router.get('/intelligence/specialists', requirePermission('read:evidence'), (_req, res, next) => {
    try { res.json({ specialists: intelligence.listSpecialistProfiles() }); } catch (error) { next(error); }
  });

  router.get('/intelligence/claims', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json({ claims: intelligence.listClaims(req.query.limit ? Number(req.query.limit) : undefined) }); } catch (error) { try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/intelligence/claims', requirePermission('write:claim'), (req, res, next) => {
    try { res.status(201).json(intelligence.createClaim(req.body || {})); } catch (error) { try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/intelligence/capacity/plan', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json(intelligence.planCapacityV2(req.body || {})); } catch (error) { try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.get('/intelligence/runner-manifests', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json({ manifests: intelligence.listRunnerManifests(req.query.limit ? Number(req.query.limit) : undefined) }); } catch (error) { try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/intelligence/runner-manifests', requirePermission('write:runner_manifest'), (req, res, next) => {
    const blockedActions = ['complete', 'fail', 'kill', 'timeout'];
    const action = req.body?.action;
    if (action && blockedActions.includes(action)) {
      throw createError(403, 'completed runner manifests can only be auto-written by the runner, not asserted via API', 'RUNNER_MANIFEST_DIRECT_ASSERTION_BLOCKED');
    }
    try { res.status(201).json(intelligence.createRunnerManifest(req.body || {})); } catch (error) { try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/intelligence/governance/evaluate', requirePermission('write:governance'), (req, res, next) => {
    try { res.json(intelligence.evaluateGovernance(req.body || {})); } catch (error) { try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.get('/intelligence/okf-drift', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json(intelligence.okfDriftReport(req.query.okf_base ? String(req.query.okf_base) : undefined)); } catch (error) { try { mapSwarmIntelligenceError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  // Specialist panels
  router.get('/specialists/catalog', requirePermission('read:evidence'), (_req, res, next) => {
    try { res.json({ specialists: specialistPanels.getCatalog() }); } catch (error) { next(error); }
  });

  router.get('/specialist-panels', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json(specialistPanels.listPanels(req.query.limit ? Number(req.query.limit) : undefined)); } catch (error) { try { mapSpecialistPanelError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/specialist-panels', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.status(201).json(specialistPanels.createPanel(req.body || {})); } catch (error) { try { mapSpecialistPanelError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.get('/specialist-panels/:id', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json(specialistPanels.getPanel(req.params.id)); } catch (error) { try { mapSpecialistPanelError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  router.post('/specialist-panels/:id/reviews', requirePermission('write:swarm_action'), (req, res, next) => {
    try { res.status(200).json(specialistPanels.submitReview(req.params.id, req.body || {})); } catch (error) { try { mapSpecialistPanelError(error); } catch (mapped) { next(mapped); } next(error); }
  });

  return router;
}
