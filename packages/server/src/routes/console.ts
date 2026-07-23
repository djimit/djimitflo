/**
 * Operational Capability Console — system health and capability monitoring.
 *
 * Provides operational visibility into:
 * - Capability status (active, dormant, candidate, deprecated)
 * - Gate status (which gates are active/blocked)
 * - Memory health (vector store status, index size, latency)
 * - Model routing (which models used, costs, latency)
 * - Audit chain status (latest anchor, integrity check)
 * - Self-improvement status (open proposals, completed improvements)
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { GovernanceFeedbackLoopService } from '../services/governance-feedback-loop';
import { AuditAnchoringService } from '../services/audit-anchoring';


export function createConsoleRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const feedback = new GovernanceFeedbackLoopService(db);
  const audit = new AuditAnchoringService(db);

  // GET /api/console/overview — system overview
  router.get('/overview', requirePermission('read:audit'), (_req, res) => {
    const proposals = feedback.getProposalsByStatus('proposed');
    const dormant = feedback.detectDormantCapabilities();
    const anchors = audit.getAnchors();

    res.json({
      capabilities: {
        total: db.prepare('SELECT COUNT(*) as c FROM swarm_capabilities').get() as { c: number },
        active: db.prepare("SELECT COUNT(*) as c FROM swarm_capabilities WHERE status IN ('active', 'validated')").get() as { c: number },
        dormant: dormant.length,
        candidate: db.prepare("SELECT COUNT(*) as c FROM swarm_capabilities WHERE status = 'candidate'").get() as { c: number },
      },
      improvements: {
        pending_proposals: proposals.length,
        dead_letter_queue: audit.getDeadLetterQueue().length,
        latest_anchor: anchors.length > 0 ? anchors[anchors.length - 1] : null,
      },
      system: {
        uptime_seconds: process.uptime(),
        memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        node_version: process.version,
      },
    });
  });

  // GET /api/console/capabilities — capability status detail
  router.get('/capabilities', requirePermission('read:audit'), (_req, res) => {
    const capabilities = db.prepare(`
      SELECT id, kind, owner, version, status, risk_ceiling, eval_score, removal_strategy
      FROM swarm_capabilities ORDER BY status, id
    `).all();

    const dormant = feedback.detectDormantCapabilities();

    res.json({ capabilities, dormant_capabilities: dormant });
  });

  // GET /api/console/gates — gate status
  router.get('/gates', requirePermission('read:audit'), (_req, res) => {
    const gates = db.prepare(`
      SELECT name, status, COUNT(*) as count
      FROM (
        SELECT json_extract(value, '$.name') as name, json_extract(value, '$.status') as status
        FROM loop_runs, json_each(loop_runs.gates_json)
        WHERE status IN ('running', 'verifying', 'completed')
      )
      GROUP BY name, status
      ORDER BY name
    `).all();

    res.json({ gates });
  });

  // GET /api/console/memory — memory health
  router.get('/memory', requirePermission('read:audit'), (_req, res) => {
    let memoryCount = { c: 0 };
    try {
      memoryCount = db.prepare('SELECT COUNT(*) as c FROM vector_memories').get() as { c: number };
    } catch { /* table may not exist */ }
    res.json({
      total_memories: memoryCount.c,
      metrics: { uptime: process.uptime(), memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) },
    });
  });

  // GET /api/console/models — model routing stats
  router.get('/models', requirePermission('read:audit'), (_req, res) => {
    const models = db.prepare(`
      SELECT runtime, COUNT(*) as usage_count
      FROM worker_leases
      GROUP BY runtime
      ORDER BY usage_count DESC
    `).all();

    res.json({ model_usage: models });
  });

  // GET /api/console/audit — audit chain status
  router.get('/audit', requirePermission('read:audit'), (_req, res) => {
    const chainIntegrity = audit.verifyChainIntegrity();
    const anchors = audit.getAnchors();
    const totalEvents = db.prepare('SELECT COUNT(*) as c FROM compliance_audit_log').get() as { c: number };

    res.json({
      chain_integrity: chainIntegrity.valid,
      first_invalid_event: chainIntegrity.firstInvalidEvent || null,
      total_events: totalEvents.c,
      total_anchors: anchors.length,
      latest_anchor: anchors.length > 0 ? anchors[anchors.length - 1] : null,
      dead_letter_queue: audit.getDeadLetterQueue().length,
    });
  });

  // GET /api/console/improvements — self-improvement status
  router.get('/improvements', requirePermission('read:audit'), (_req, res) => {
    const proposals = {
      proposed: feedback.getProposalsByStatus('proposed').length,
      authorized: feedback.getProposalsByStatus('authorized').length,
      rejected: feedback.getProposalsByStatus('rejected').length,
      executing: feedback.getProposalsByStatus('executing').length,
      completed: feedback.getProposalsByStatus('completed').length,
      failed: feedback.getProposalsByStatus('failed').length,
    };

    const history = feedback.getLoopHistory(10);

    res.json({ proposals, recent_loops: history });
  });

  return router;
}
