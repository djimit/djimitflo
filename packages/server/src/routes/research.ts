/**
 * Citation Research routes — source-based research with verification.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { CitationResearchService } from '../services/citation-research-service';

export function createResearchRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new CitationResearchService(db);

  // GET /api/research/stats — research statistics
  router.get('/stats', requirePermission('read:evidence'), (_req, res) => {
    res.json(service.getStats());
  });

  // POST /api/research/sources — register a source
  router.post('/sources', requirePermission('write:claim'), (req, res) => {
    const { url, title, source_type, trust_score, metadata } = req.body;
    if (!url || !title) {
      res.status(400).json({ error: { message: 'url and title are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const source = service.registerSource({ url, title, source_type, trust_score, metadata });
    res.status(201).json(source);
  });

  // GET /api/research/sources/trusted — get trusted sources
  router.get('/sources/trusted', requirePermission('read:evidence'), (req, res) => {
    const minTrust = req.query.min_trust ? Number(req.query.min_trust) : 0.7;
    res.json({ sources: service.getTrustedSources(minTrust) });
  });

  // POST /api/research/claims — create a citation-linked claim
  router.post('/claims', requirePermission('write:claim'), (req, res) => {
    const { text, source_ids, confidence } = req.body;
    if (!text || !source_ids?.length) {
      res.status(400).json({ error: { message: 'text and source_ids are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const claim = service.createClaim({ text, source_ids, confidence });
    res.status(201).json(claim);
  });

  // POST /api/research/contradictions/detect — detect contradictions
  router.post('/contradictions/detect', requirePermission('read:evidence'), (_req, res) => {
    const contradictions = service.detectContradictions();
    res.json({ contradictions, count: contradictions.length });
  });

  // POST /api/research/reports/generate — generate research report
  router.post('/reports/generate', requirePermission('write:claim'), (req, res) => {
    const { title, claim_ids } = req.body;
    if (!title) {
      res.status(400).json({ error: { message: 'title is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const report = service.generateReport({ title, claim_ids });
    res.status(201).json(report);
  });

  return router;
}
