import { Router } from 'express';
import type { AuthMiddleware } from '../middleware/auth';
import { buildTraceabilityMatrix } from '../services/traceability-service';
import { scanSpecsDirectory } from '../services/spec-compliance-service';

export function createTraceabilityRoutes(auth?: AuthMiddleware): Router {
  const router = Router();
  const requireAuth = auth?.requireAuth ?? ((_req: any, _res: any, next: any) => next());

  // GET /api/traceability/matrix — full traceability matrix
  router.get('/matrix', requireAuth, (_req, res) => {
    try {
      const specs = scanSpecsDirectory();
      const matrix = buildTraceabilityMatrix(specs);
      res.json(matrix);
    } catch (error) {
      res.status(500).json({ error: { message: 'Failed to build matrix', details: error instanceof Error ? error.message : String(error) } });
    }
  });

  return router;
}
