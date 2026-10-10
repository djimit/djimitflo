/**
 * Self-improvement documentation diagnostics.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { AutonomousDocsService } from '../services/autonomous-docs-service';
import { ReconciliationService } from '../services/reconciliation-service';
import { SelfImprovementService, type ImprovementStatus } from '../services/self-improvement-service';
import { AutonomousGoalGenerator } from '../services/autonomous-goal-generator';
import { PanelCalibrationService } from '../services/panel-calibration-service';
import { ImprovementFunnelService } from '../services/improvement-funnel-service';
import { createError } from '../middleware/error-handler';
import { requeueImprovement } from '../services/improvement-requeue';
import { decisionsInbox, dismissRequeue, labelPrescreen, setTelegramIdentity } from '../services/decisions-inbox';
import { adjudicateAttribution } from '../services/outcome-attribution';

function boundedLimit(value: unknown, fallback = 100): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw createError(400, 'limit must be an integer between 1 and 500', 'VALIDATION_ERROR');
  }
  return limit;
}

export function createSelfImprovementRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  const docs = new AutonomousDocsService(db);
  const reconciler = new ReconciliationService(db);
  const improvements = new SelfImprovementService(db);
  const goals = new AutonomousGoalGenerator(db);

  router.get('/proposals', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status as ImprovementStatus : undefined;
      if (status && !VALID_IMPROVEMENT_STATUSES.has(status)) throw createError(400, 'Invalid improvement status', 'VALIDATION_ERROR');
      res.json({ proposals: improvements.listImprovements(status, boundedLimit(req.query.limit)) });
    } catch (error) { next(error); }
  });

  router.get('/funnel', requirePermission('read:evidence'), (_req, res, next) => {
    try { res.json(new ImprovementFunnelService(db).compute()); }
    catch (error) { next(error); }
  });

  router.get('/calibration', requirePermission('read:evidence'), (_req, res, next) => {
    try { res.json({ specialists: new PanelCalibrationService(db).compute() }); }
    catch (error) { next(error); }
  });

  router.get('/proposals/:id', requirePermission('read:evidence'), (req, res, next) => {
    try { res.json(improvements.getImprovement(req.params.id)); }
    catch (error) { next(mapImprovementError(error)); }
  });

  router.post('/proposals/:id/approve', requirePermission('write:governance'), (req, res, next) => {
    try {
      const actor = req.user?.sub || req.user?.email;
      if (!actor) throw createError(401, 'Authentication required', 'AUTH_REQUIRED');
      const result = db.transaction(() => {
        improvements.approveImprovement(req.params.id, actor);
        return {
          goalCreated: goals.generateImprovement(req.params.id) === 1,
          proposal: improvements.getImprovement(req.params.id),
        };
      })();
      res.json(result);
    } catch (error) { next(mapImprovementError(error)); }
  });

  // D2: a new attempt linked to the original (which stays untouched). Body: { reason, approve_escalation? }
  router.post('/proposals/:id/requeue', requirePermission('write:governance'), (req, res, next) => {
    try {
      const actor = req.user?.sub || req.user?.email;
      if (!actor) throw createError(401, 'Authentication required', 'AUTH_REQUIRED');
      const body = (req.body ?? {}) as { reason?: unknown; approve_escalation?: unknown };
      const result = db.transaction(() => {
        const requeued = requeueImprovement(db, req.params.id, { actor, reason: String(body.reason ?? ''), approveEscalation: body.approve_escalation === true });
        return { ...requeued, goalCreated: requeued.created && goals.generateImprovement(requeued.id) === 1 };
      })();
      res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'REQUEUE_NOT_FOUND') return next(createError(404, 'Proposal not found', code));
      if (code === 'REQUEUE_ESCALATED_NEEDS_APPROVAL') return next(createError(409, 'A run of this proposal is escalated; pass approve_escalation: true to requeue anyway', code));
      if (code.startsWith('REQUEUE_')) return next(createError(code === 'REQUEUE_BUDGET_EXHAUSTED' ? 429 : 400, code, code));
      next(mapImprovementError(error));
    }
  });

  // S2: the operator's open decisions (requeue candidates, D5 pre-screen labelling, Telegram allowlist)
  router.get('/decisions', requirePermission('read:evidence'), (_req, res) => { res.json(decisionsInbox(db)); });
  router.post('/proposals/:id/prescreen-label', requirePermission('write:governance'), (req, res, next) => {
    try {
      const actor = req.user?.sub || req.user?.email;
      if (!actor) throw createError(401, 'Authentication required', 'AUTH_REQUIRED');
      const label = (req.body ?? {}).label;
      if (label !== 'ok' && label !== 'wrong') throw createError(400, "label must be 'ok' or 'wrong'", 'VALIDATION_ERROR');
      labelPrescreen(db, req.params.id, label, actor);
      res.status(204).end();
    } catch (error) {
      next(error instanceof Error && error.message === 'LABEL_NO_PRESCREEN_REJECTION' ? createError(404, 'No pre-screen rejection for this proposal', error.message) : error);
    }
  });
  // §16 step 4: the operator judges a sampled attribution (correct / wrong / unclear) — an attribution_audit operator_label
  // judgment; only runs in this week's CAR sample. Same permission as the D5 labels.
  router.post('/attribution-audit/:runId', requirePermission('write:governance'), (req, res, next) => {
    try {
      const actor = req.user?.sub || req.user?.email;
      if (!actor) throw createError(401, 'Authentication required', 'AUTH_REQUIRED');
      const { verdict, note } = req.body ?? {};
      if (verdict !== 'correct' && verdict !== 'wrong' && verdict !== 'unclear') throw createError(400, "verdict must be 'correct', 'wrong' or 'unclear'", 'VALIDATION_ERROR');
      if (note !== undefined && typeof note !== 'string') throw createError(400, 'note must be a string', 'VALIDATION_ERROR');
      adjudicateAttribution(db, req.params.runId, verdict, actor, note ?? '');
      res.status(204).end();
    } catch (error) {
      next(error instanceof Error && error.message === 'ATTRIBUTION_AUDIT_NOT_SAMPLED' ? createError(404, "Run is not in this week's attribution audit sample", error.message) : error);
    }
  });
  // D2: the operator decides a requeue candidate needs no requeue — audited (requeue_dismiss judgment), the row leaves /decisions
  router.post('/proposals/:id/requeue-dismiss', requirePermission('write:governance'), (req, res, next) => {
    try {
      const actor = req.user?.sub || req.user?.email;
      if (!actor) throw createError(401, 'Authentication required', 'AUTH_REQUIRED');
      const reason = (req.body ?? {}).reason;
      if (reason !== undefined && typeof reason !== 'string') throw createError(400, 'reason must be a string', 'VALIDATION_ERROR');
      dismissRequeue(db, req.params.id, actor, reason ?? '');
      res.status(204).end();
    } catch (error) {
      next(error instanceof Error && error.message === 'DISMISS_NOT_A_REQUEUE_CANDIDATE' ? createError(404, 'Not a requeue candidate', error.message) : error);
    }
  });
  router.put('/telegram-identities/:telegramId', requirePermission('manage:config'), (req, res, next) => {
    try {
      const actor = req.user?.sub || req.user?.email;
      if (!actor) throw createError(401, 'Authentication required', 'AUTH_REQUIRED');
      const body = (req.body ?? {}) as { user_id?: unknown; note?: unknown };
      if (typeof body.user_id !== 'string' || !body.user_id.trim()) throw createError(400, 'user_id required', 'VALIDATION_ERROR');
      setTelegramIdentity(db, req.params.telegramId, body.user_id.trim(), actor, typeof body.note === 'string' ? body.note : undefined);
      res.status(204).end();
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      next(code.startsWith('TELEGRAM_') ? createError(code === 'TELEGRAM_USER_NOT_FOUND' ? 404 : 400, code, code) : error);
    }
  });
  router.delete('/telegram-identities/:telegramId', requirePermission('manage:config'), (req, res, next) => {
    try {
      const actor = req.user?.sub || req.user?.email;
      if (!actor) throw createError(401, 'Authentication required', 'AUTH_REQUIRED');
      setTelegramIdentity(db, req.params.telegramId, null, actor);
      res.status(204).end();
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      next(code.startsWith('TELEGRAM_') ? createError(400, code, code) : error);
    }
  });

  router.post('/proposals/:id/reject', requirePermission('write:governance'), (req, res, next) => {
    try { res.json({ proposal: improvements.rejectImprovement(req.params.id) }); }
    catch (error) { next(mapImprovementError(error)); }
  });

  // POST /api/self-improve/reconcile — re-verify generated claims against source.
  // Body: { claims?: [{title, issueNumber?}], github?: boolean, apply?: boolean }
  // github mode needs GITHUB_REPOSITORY + GITHUB_TOKEN; apply also closes stale issues.
  router.post('/reconcile', requirePermission('write:governance'), async (req, res, next) => {
    try {
      const { claims, github, apply } = req.body || {};
      if (github) {
        res.json(await reconciler.reconcileGitHub({ apply: Boolean(apply) }));
        return;
      }
      if (!Array.isArray(claims) || claims.length === 0 || claims.some((c) => typeof c?.title !== 'string')) {
        res.status(400).json({ error: { message: 'claims must be a non-empty array of {title, issueNumber?}', code: 'VALIDATION_ERROR' } });
        return;
      }
      res.json(reconciler.reconcile(claims, 'api'));
    } catch (error) {
      next(error);
    }
  });

  // GET /api/self-improve/reconciliation — latest reconciliation report
  router.get('/reconciliation', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      const report = reconciler.latestReport();
      if (!report) {
        res.status(404).json({ error: { message: 'No reconciliation runs yet', code: 'NOT_FOUND' } });
        return;
      }
      res.json(report);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/self-improve/docs/scan — scan for undocumented APIs
  router.get('/docs/scan', requirePermission('read:evidence'), (_req, res) => {
    const gaps = docs.scan();
    res.json({ gaps, count: gaps.length });
  });

  // GET /api/self-improve/docs/stats — documentation coverage
  router.get('/docs/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(docs.getStats());
  });

  return router;
}

const VALID_IMPROVEMENT_STATUSES = new Set<ImprovementStatus>([
  'proposed', 'scheduled', 'executing', 'verified', 'evaluating', 'applied', 'rejected', 'no_change', 'regressed',
  'needs_more_evidence', 'needs_grounding', 'archived',
]);

function mapImprovementError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'SELF_IMPROVEMENT_NOT_FOUND') return createError(404, message, message);
  if (message.startsWith('SELF_IMPROVEMENT_')) return createError(409, message, message);
  return error instanceof Error ? error : new Error(message);
}
