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

const RECHTSGEBIEDEN = new Set(['civiel', 'straf', 'bestuursrecht', 'familierecht', 'arbeidsrecht', 'cassatie', 'onbekend']);
const ACTIES = new Set(['pseudonimiseer', 'niet_pseudonimiseer', 'handmatige_controle']);

export function createLegalRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new LegalRuleService(db);

  // POST /api/legal/check-pii — full PII check + anonymization
  router.post('/check-pii', requirePermission('read:evidence'), (req, res, next) => {
    try {
      const { ecli, bodyText, rechtsgebied } = req.body;
      if (typeof ecli !== 'string' || !ecli.trim() || typeof bodyText !== 'string' || !bodyText.trim()
        || (rechtsgebied !== undefined && (typeof rechtsgebied !== 'string' || !RECHTSGEBIEDEN.has(rechtsgebied)))) {
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
      if (typeof text !== 'string' || !text.trim()
        || (rechtsgebied !== undefined && (typeof rechtsgebied !== 'string' || !RECHTSGEBIEDEN.has(rechtsgebied)))) {
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
      if (typeof ecli !== 'string' || !ecli.trim()
        || (detection_index !== undefined && (!Number.isInteger(detection_index) || detection_index < 0))
        || (original_action !== undefined && (typeof original_action !== 'string' || !ACTIES.has(original_action)))
        || (typeof corrected_action !== 'string' || !ACTIES.has(corrected_action))
        || (typeof reason !== 'string' || !reason.trim())
        || (corrected_by !== undefined && (typeof corrected_by !== 'string' || !corrected_by.trim()))) {
        res.status(400).json({ error: { message: 'ecli, corrected_action, and reason are required', code: 'VALIDATION_ERROR' } });
        return;
      }
      const entry = service.submitFeedback({ ecli, detection_index: detection_index ?? 0, original_action: original_action ?? 'pseudonimiseer', corrected_action, reason, corrected_by: corrected_by || 'anonymous' });
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
