/**
 * Citation Research routes — source registry, citation links and reports.
 * Registered sources alone do not verify claims; claim verification is fail-closed.
 */

import { Router, type NextFunction, type Response } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { CitationResearchService } from '../services/citation-research-service';

function handleResearchInputError(error: unknown, res: Response, next: NextFunction): void {
  const code = error instanceof Error ? error.message : '';
  if (code.startsWith('RESEARCH_')) {
    const status = code === 'RESEARCH_SOURCE_NOT_FOUND' || code === 'RESEARCH_CLAIM_NOT_FOUND' ? 404
      : code === 'RESEARCH_REPORT_HIGH_SEVERITY_CONTRADICTION' ? 409
        : 400;
    res.status(status)
      .json({ error: { message: code, code } });
    return;
  }
  next(error);
}

export function createResearchRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new CitationResearchService(db);

  // GET /api/research/stats — research statistics
  router.get('/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(service.getStats());
  });

  // POST /api/research/sources — register a source
  router.post('/sources', requirePermission('write:claim'), (req, res, next) => {
    const { url, title, source_type, metadata } = req.body || {};
    if (!url || !title) {
      res.status(400).json({ error: { message: 'url and title are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    try {
      const source = service.registerSource({ url, title, source_type, metadata });
      res.status(201).json(source);
    } catch (error) {
      handleResearchInputError(error, res, next);
    }
  });

  // GET /api/research/sources/trusted — get trusted sources
  router.get('/sources/trusted', requirePermission('read:evidence'), (req, res) => {
    const minTrust = req.query.min_trust === undefined ? 0.7 : Number(req.query.min_trust);
    if (!Number.isFinite(minTrust) || minTrust < 0 || minTrust > 1) {
      res.status(400).json({ error: { message: 'min_trust must be a number between 0 and 1', code: 'VALIDATION_ERROR' } });
      return;
    }
    res.json({ sources: service.getTrustedSources(minTrust) });
  });

  // POST /api/research/claims — create a citation-linked claim
  router.post('/claims', requirePermission('write:claim'), (req, res, next) => {
    const { text, source_ids, confidence } = req.body || {};
    if (typeof text !== 'string' || !text.trim() || !Array.isArray(source_ids) || source_ids.length === 0
      || !source_ids.every((sourceId: unknown) => typeof sourceId === 'string' && sourceId.trim())
      || (confidence !== undefined && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1))) {
      res.status(400).json({ error: { message: 'text and source_ids are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    try {
      const claim = service.createClaim({ text, source_ids, confidence });
      res.status(201).json(claim);
    } catch (error) {
      handleResearchInputError(error, res, next);
    }
  });

  // POST /api/research/contradictions/detect — detect contradictions
  router.post('/contradictions/detect', requirePermission('read:evidence'), (_req, res) => {
    const contradictions = service.detectContradictions();
    res.json({ contradictions, count: contradictions.length });
  });

  // POST /api/research/reports/generate — generate research report
  router.post('/reports/generate', requirePermission('write:claim'), (req, res, next) => {
    const { title, claim_ids } = req.body || {};
    if (typeof title !== 'string' || !title.trim() || title.length > 500
      || (claim_ids !== undefined && (!Array.isArray(claim_ids) || claim_ids.length === 0 || claim_ids.length > 100
        || !claim_ids.every((claimId: unknown) => typeof claimId === 'string' && claimId.trim())))) {
      res.status(400).json({ error: { message: 'title and optional claim_ids are invalid', code: 'VALIDATION_ERROR' } });
      return;
    }
    if (claim_ids !== undefined && claim_ids.some((claimId: string, index: number) => claim_ids.indexOf(claimId) !== index)) {
      res.status(400).json({ error: { message: 'claim_ids must not contain duplicates', code: 'VALIDATION_ERROR' } });
      return;
    }
    try {
      const report = service.generateReport({ title, claim_ids });
      res.status(201).json(report);
    } catch (error) {
      handleResearchInputError(error, res, next);
    }
  });

  return router;
}
