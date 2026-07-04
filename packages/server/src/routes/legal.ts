/**
 * Legal RuleOps routes — UC-06: Publicatie Rule Service.
 *
 * POST /api/legal/check-pii → classify + anonymize + report
 * POST /api/legal/classify → classify only
 * POST /api/legal/feedback → submit correction
 * GET  /api/legal/rechtsgebied/:ecli → detect rechtsgebied
 * GET  /api/legal/status → service status
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { LegalRuleService } from '../services/legal-ruleops/rule-service';

export function createLegalRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new LegalRuleService(db);

  // POST /api/legal/check-pii — full PII check + anonymization
  router.post('/check-pii', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const { ecli, bodyText, rechtsgebied } = req.body;
      if (!ecli || !bodyText) {
        res.status(400).json({ error: { message: 'ecli and bodyText are required', code: 'VALIDATION_ERROR' } });
        return;
      }
      res.json(service.checkPII({ ecli, bodyText, rechtsgebied }));
    } catch (error) {
      next(error);
    }
  });

  // POST /api/legal/classify — classify only (no anonymization)
  router.post('/classify', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const { text, rechtsgebied } = req.body;
      if (!text) {
        res.status(400).json({ error: { message: 'text is required', code: 'VALIDATION_ERROR' } });
        return;
      }
      res.json(service.classifyOnly({ text, rechtsgebied }));
    } catch (error) {
      next(error);
    }
  });

  // GET /api/legal/rechtsgebied/:ecli — detect rechtsgebied from ECLI
  router.get('/rechtsgebied/:ecli', requirePermission('read:evidence'), (req, res) => {
    res.json({ ecli: req.params.ecli, rechtsgebied: service.detectRechtsgebied(req.params.ecli) });
  });

  // POST /api/legal/feedback — submit correction feedback
  router.post('/feedback', requirePermission('write:governance'), (req, res, next) => {
    try {
      const { ecli, detection_index, original_action, corrected_action, reason, corrected_by } = req.body;
      if (!ecli || !corrected_action || !reason) {
        res.status(400).json({ error: { message: 'ecli, corrected_action, and reason are required', code: 'VALIDATION_ERROR' } });
        return;
      }
      const entry = service.submitFeedback({ ecli, detection_index, original_action, corrected_action, reason, corrected_by: corrected_by || 'anonymous' });
      res.status(201).json(entry);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/legal/status — service status
  router.get('/status', requirePermission('read:evidence'), (_req, res) => {
    res.json(service.getStatus());
  });

  return router;
}
