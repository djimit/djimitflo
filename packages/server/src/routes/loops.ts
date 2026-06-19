import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { createError } from '../middleware/error-handler';
import { LoopService } from '../services/loop-service';

function mapLoopServiceError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'GOAL_NOT_FOUND') throw createError(404, 'Goal not found', 'GOAL_NOT_FOUND');
  if (message === 'LOOP_NAME_UNSUPPORTED') throw createError(400, 'loop_name is not supported', 'LOOP_NAME_UNSUPPORTED');
  if (message === 'LOOP_RUN_NOT_FOUND') throw createError(404, 'Loop run not found', 'LOOP_RUN_NOT_FOUND');
  if (message === 'REPOSITORY_PATH_NOT_FOUND') throw createError(400, 'repository_path does not exist', 'REPOSITORY_PATH_NOT_FOUND');
  if (message === 'REPOSITORY_PATH_NOT_DIRECTORY') throw createError(400, 'repository_path must be a directory', 'REPOSITORY_PATH_NOT_DIRECTORY');
  if (message === 'LOOP_REPOSITORY_REQUIRED') throw createError(400, 'loop run has no repository_path', 'LOOP_REPOSITORY_REQUIRED');
  if (message === 'LOOP_NO_FINDINGS_TO_ASSIGN') throw createError(409, 'loop run has no findings to assign', 'LOOP_NO_FINDINGS_TO_ASSIGN');
  if (message === 'LOOP_FINDING_ID_REQUIRED') throw createError(400, 'finding_id is required', 'LOOP_FINDING_ID_REQUIRED');
  if (message === 'LOOP_FINDING_NOT_FOUND') throw createError(404, 'selected finding was not found in loop run', 'LOOP_FINDING_NOT_FOUND');
  if (message === 'LOOP_FINDING_ALREADY_SPLIT') throw createError(409, 'finding has already been split and cannot be assigned directly', 'LOOP_FINDING_ALREADY_SPLIT');
  if (message === 'LOOP_SPLIT_CHILDREN_REQUIRED') throw createError(400, 'split requires at least two child findings', 'LOOP_SPLIT_CHILDREN_REQUIRED');
  if (message === 'LOOP_SPLIT_CHILD_INVALID') throw createError(400, 'each split child requires message and suggested_fix', 'LOOP_SPLIT_CHILD_INVALID');
  if (message === 'LOOP_WORKER_BUDGET_EXHAUSTED') throw createError(409, 'worker budget exhausted for this loop run', 'LOOP_WORKER_BUDGET_EXHAUSTED');
  if (message === 'LOOP_TOKEN_BUDGET_EXHAUSTED') throw createError(409, 'token budget exhausted for this loop run', 'LOOP_TOKEN_BUDGET_EXHAUSTED');
  if (message === 'LOOP_WALL_CLOCK_BUDGET_EXHAUSTED') throw createError(409, 'wall-clock budget exhausted for this loop run', 'LOOP_WALL_CLOCK_BUDGET_EXHAUSTED');
  if (message === 'LOOP_RETRY_BUDGET_EXHAUSTED') throw createError(409, 'retry budget exhausted for this loop run', 'LOOP_RETRY_BUDGET_EXHAUSTED');
  if (message === 'LOOP_RETRY_NOT_ALLOWED') throw createError(409, 'maker lease is not failed, rejected, or marked for revision', 'LOOP_RETRY_NOT_ALLOWED');
  if (message === 'LOOP_ESCALATED_REQUIRES_HUMAN') throw createError(409, 'loop is escalated and requires human review before leasing more workers', 'LOOP_ESCALATED_REQUIRES_HUMAN');
  if (message === 'LOOP_FAILED_GATES_BLOCK_CONTINUE') throw createError(409, 'failed gates block continuation', 'LOOP_FAILED_GATES_BLOCK_CONTINUE');
  if (message.startsWith('WORKTREE_CREATE_FAILED')) throw createError(500, message, 'WORKTREE_CREATE_FAILED');
  if (message === 'MAKER_LEASE_NOT_FOUND') throw createError(404, 'maker lease not found', 'MAKER_LEASE_NOT_FOUND');
  if (message === 'LEASE_NOT_MAKER') throw createError(400, 'lease is not a maker lease', 'LEASE_NOT_MAKER');
  if (message === 'MAKER_LEASE_NOT_PREPARED') throw createError(409, 'maker lease is not prepared', 'MAKER_LEASE_NOT_PREPARED');
  if (message === 'MAKER_LEASE_NOT_COMPLETED') throw createError(409, 'maker lease is not completed', 'MAKER_LEASE_NOT_COMPLETED');
  if (message === 'MAKER_WORKTREE_NOT_FOUND') throw createError(404, 'maker worktree not found', 'MAKER_WORKTREE_NOT_FOUND');
  if (message === 'MANUAL_MAKER_REQUIRES_HUMAN') throw createError(409, 'manual maker leases require human execution', 'MANUAL_MAKER_REQUIRES_HUMAN');
  if (message === 'MAKER_RUNTIME_UNSUPPORTED') throw createError(400, 'maker runtime is unsupported', 'MAKER_RUNTIME_UNSUPPORTED');
  if (message === 'RUNTIME_UNAVAILABLE') throw createError(409, 'requested runtime is unavailable', 'RUNTIME_UNAVAILABLE');
  if (message === 'RUNTIME_CONTRACT_DRIFTED') throw createError(409, 'requested runtime contract is drifted or unavailable', 'RUNTIME_CONTRACT_DRIFTED');
  if (message === 'CHECKER_VERDICT_REQUIRED') throw createError(400, 'checker verdict is required', 'CHECKER_VERDICT_REQUIRED');
  if (message === 'CHECKER_VERDICT_INVALID') throw createError(400, 'checker verdict is invalid', 'CHECKER_VERDICT_INVALID');
  if (message === 'CHECKER_LEASE_NOT_FOUND') throw createError(404, 'checker lease not found', 'CHECKER_LEASE_NOT_FOUND');
  if (message === 'SECURITY_CHECKER_LEASE_NOT_FOUND') throw createError(404, 'security checker lease not found', 'SECURITY_CHECKER_LEASE_NOT_FOUND');
  if (message === 'LEASE_NOT_CHECKER') throw createError(400, 'lease is not a checker lease', 'LEASE_NOT_CHECKER');
  if (message === 'LEASE_NOT_SECURITY_CHECKER') throw createError(400, 'lease is not a security checker lease', 'LEASE_NOT_SECURITY_CHECKER');
  if (message === 'CHECKER_MAKER_LINK_MISSING') throw createError(400, 'checker maker link is missing', 'CHECKER_MAKER_LINK_MISSING');
  if (message === 'CHECKER_MAKER_NOT_COMPLETED') throw createError(409, 'maker lease is not completed yet', 'CHECKER_MAKER_NOT_COMPLETED');
  if (message === 'HIGH_RISK_SECURITY_CHECK_REQUIRED') throw createError(409, 'high-risk loop requires accepted security checker verdict before completion', 'HIGH_RISK_SECURITY_CHECK_REQUIRED');
  if (message === 'LOOP_COMPLETION_LEASES_INCOMPLETE') throw createError(409, 'all worker leases must be completed before loop completion', 'LOOP_COMPLETION_LEASES_INCOMPLETE');
  if (message === 'LOOP_COMPLETION_NO_WORKERS') throw createError(409, 'loop has no completed worker path to close', 'LOOP_COMPLETION_NO_WORKERS');
  if (message.startsWith('LOOP_COMPLETION_BLOCKED:')) {
    const gate = message.split(':')[1] || 'unknown';
    throw createError(409, `loop completion blocked by gate: ${gate}`, 'LOOP_COMPLETION_BLOCKED');
  }
  throw error;
}

export function createLoopRoutes(db: Database, auth?: AuthMiddleware, evidenceRoot?: string): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const loopService = new LoopService(db, evidenceRoot);

  router.get('/catalog', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      res.json(loopService.getCatalog());
    } catch (error) {
      next(error);
    }
  });

  router.get('/runtime-contracts', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      res.json(loopService.getRuntimeContracts());
    } catch (error) {
      next(error);
    }
  });

  router.get('/runs', requirePermission('read:evidence'), (_req, res, next) => {
    try {
      res.json({ runs: loopService.listLoopRuns() });
    } catch (error) {
      next(error);
    }
  });

  router.get('/runs/:id', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json(loopService.getLoopRun(req.params.id));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.get('/runs/:id/review-bundle', requirePermission('read:evidence'), (req, res, next) => {
    try {
      res.json(loopService.getReviewBundle(req.params.id));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/start', requirePermission('create:task'), (req, res, next) => {
    try {
      const body = req.body || {};
      const run = loopService.startLoop(body);
      res.status(201).json(run);
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/doc-drift-and-small-fix/start', requirePermission('create:task'), (req, res, next) => {
    try {
      const run = loopService.startDocDriftAndSmallFixLoop(req.body || {});
      res.status(201).json(run);
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/runs/:id/step', requirePermission('create:task'), (req, res, next) => {
    try {
      res.json(loopService.stepLoopRun(req.params.id));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/runs/:id/continue', requirePermission('create:task'), (req, res, next) => {
    try {
      res.status(201).json(loopService.continueLoopRun(req.params.id, req.body || {}));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/runs/:id/retry', requirePermission('create:task'), (req, res, next) => {
    try {
      res.status(201).json(loopService.retryLoopRun(req.params.id, req.body || {}));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/runs/:id/split', requirePermission('create:task'), (req, res, next) => {
    try {
      res.status(201).json(loopService.splitLoopFinding(req.params.id, req.body || {}));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/runs/:id/verify', requirePermission('create:task'), (req, res, next) => {
    try {
      res.json(loopService.verifyLoopRun(req.params.id));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/runs/:id/execute-maker', requirePermission('create:task'), async (req, res, next) => {
    try {
      res.json(await loopService.executeMaker(req.params.id, req.body || {}));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/runs/:id/execute-worker', requirePermission('create:task'), async (req, res, next) => {
    try {
      res.json(await loopService.executeWorker(req.params.id, req.body || {}));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/runs/:id/execute-checker', requirePermission('create:task'), async (req, res, next) => {
    try {
      res.json(await loopService.executeChecker(req.params.id, req.body || {}));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/runs/:id/checker-verdict', requirePermission('create:task'), (req, res, next) => {
    try {
      res.json(loopService.submitCheckerVerdict(req.params.id, req.body || {}));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/runs/:id/security-verdict', requirePermission('create:task'), (req, res, next) => {
    try {
      res.json(loopService.submitSecurityVerdict(req.params.id, req.body || {}));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/runs/:id/run-checks', requirePermission('create:task'), (req, res, next) => {
    try {
      res.json(loopService.runDeterministicChecks(req.params.id, req.body || {}));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/runs/:id/complete', requirePermission('create:task'), (req, res, next) => {
    try {
      res.json(loopService.completeLoopRun(req.params.id));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  router.post('/runs/:id/stop', requirePermission('create:task'), (req, res, next) => {
    try {
      res.json(loopService.stopLoopRun(req.params.id));
    } catch (error) {
      try {
        mapLoopServiceError(error);
      } catch (mapped) {
        next(mapped);
      }
    }
  });

  return router;
}
