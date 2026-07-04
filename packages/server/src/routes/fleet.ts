/**
 * Fleet Mesh routes — cross-machine agent coordination.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { FleetMeshService } from '../services/fleet-mesh-service';

export function createFleetRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const service = new FleetMeshService(db);

  // GET /api/fleet/status — fleet status summary
  router.get('/status', requirePermission('read:evidence'), (_req, res) => {
    res.json(service.getStatus());
  });

  // GET /api/fleet/nodes — list all fleet nodes
  router.get('/nodes', requirePermission('read:evidence'), (_req, res) => {
    res.json({ nodes: service.listNodes() });
  });

  // POST /api/fleet/nodes — register a fleet node
  router.post('/nodes', requirePermission('write:swarm_action'), (req, res) => {
    const { name, endpoint, capabilities, maxAgents, metadata } = req.body;
    if (!name || !endpoint) {
      res.status(400).json({ error: { message: 'name and endpoint are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const node = service.registerNode({ name, endpoint, capabilities, maxAgents, metadata });
    res.status(201).json(node);
  });

  // GET /api/fleet/nodes/:id — get node details
  router.get('/nodes/:id', requirePermission('read:evidence'), (req, res) => {
    const node = service.getNode(req.params.id);
    if (!node) {
      res.status(404).json({ error: { message: 'Node not found', code: 'NOT_FOUND' } });
      return;
    }
    res.json(node);
  });

  // POST /api/fleet/handoff — request agent handoff
  router.post('/handoff', requirePermission('write:swarm_action'), (req, res) => {
    const { fromNode, toNode, agentId, leaseId, context } = req.body;
    if (!fromNode || !toNode || !agentId) {
      res.status(400).json({ error: { message: 'fromNode, toNode, and agentId are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const handoff = service.requestHandoff({ fromNode, toNode, agentId, leaseId, context });
    res.status(201).json(handoff);
  });

  // POST /api/fleet/handoff/:id/accept — accept handoff
  router.post('/handoff/:id/accept', requirePermission('write:swarm_action'), (req, res) => {
    service.acceptHandoff(req.params.id);
    res.json({ accepted: true });
  });

  // POST /api/fleet/handoff/:id/complete — complete handoff
  router.post('/handoff/:id/complete', requirePermission('write:swarm_action'), (req, res) => {
    service.completeHandoff(req.params.id);
    res.json({ completed: true });
  });

  // POST /api/fleet/distribute — distribute work to optimal node
  router.post('/distribute', requirePermission('write:swarm_action'), (req, res) => {
    const { loopRunId, requiredCapabilities, priority } = req.body;
    if (!loopRunId) {
      res.status(400).json({ error: { message: 'loopRunId is required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const distribution = service.distributeWork({ loopRunId, requiredCapabilities, priority });
    if (!distribution) {
      res.status(503).json({ error: { message: 'No available nodes', code: 'FLEET_CAPACITY_EXHAUSTED' } });
      return;
    }
    res.status(201).json(distribution);
  });

  // POST /api/fleet/sync-capability — sync capability from another node
  router.post('/sync-capability', requirePermission('write:swarm_action'), (req, res) => {
    const { sourceNode, capabilityId, capabilityType, score } = req.body;
    if (!sourceNode || !capabilityId) {
      res.status(400).json({ error: { message: 'sourceNode and capabilityId are required', code: 'VALIDATION_ERROR' } });
      return;
    }
    const sync = service.syncCapability({ sourceNode, capabilityId, capabilityType, score });
    res.status(201).json(sync);
  });

  return router;
}
