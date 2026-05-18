/**
 * API routes aggregator
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createTaskRoutes } from './tasks';
import { createAgentRoutes } from './agents';
import { createMCPRoutes } from './mcp';
import { createApprovalRoutes } from './approvals';
import type { ExecutionEngine } from '../execution/execution-engine';

export function createRoutes(db: Database, executionEngine?: ExecutionEngine): Router {
  const router = Router();
  
  // API version
  router.get('/version', (_req, res) => {
    res.json({
      version: '0.1.0',
      name: 'Djimitflo API',
    });
  });
  
  // Mount route modules
  router.use('/tasks', createTaskRoutes(db, executionEngine));
  router.use('/agents', createAgentRoutes(db));
  router.use('/mcp', createMCPRoutes(db));
  router.use('/approvals', createApprovalRoutes(db));
  
  return router;
}
