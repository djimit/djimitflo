import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { FleetCommands } from '../services/fleet-commands';
import { LocalShadowQueue } from '../services/local-shadow-queue';
import { mintSpawnToken, resolveSpawnTokenSecret, spawnTokenRejection } from '../services/spawn-token';
import { recordPowerSample, resourceLedgerEnabled } from '../services/resource-ledger';
import { hourBucket, recordPolicyViolation } from '../services/policy-violations';

export const HOST_AGENT_SCOPE = 'host-agent';
const limiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false });

const fail = (res: any, error: unknown) => {
  const code = error instanceof Error ? error.message : 'FLEET_ERROR';
  const status = /_NOT_FOUND$/.test(code) ? 404 : /_NOT_(PENDING|RUNNING)$|HASH_MISMATCH/.test(code) ? 409 : /^FLEET_/.test(code) ? 400 : 500;
  res.status(status).json({ error: { code, message: code } });
};

/** Hosts pull (never the other way round): heartbeat + command hand-out + results, authenticated per host (HMAC token). */
export function createHostAgentRoutes(db: Database, auth: AuthMiddleware): Router {
  const router = Router();
  router.use(limiter);
  const fleet = new FleetCommands(db);
  const host = (req: any, res: any): string | null => {
    const h = String(req.get('X-Host') || '');
    const rejection = h ? spawnTokenRejection(resolveSpawnTokenSecret(), String(req.get('X-Host-Token') || ''), h, HOST_AGENT_SCOPE) : 'wrong_subject';
    if (rejection) {
      console.warn(`[host-agent] token rejected host=${JSON.stringify(h.slice(0, 100))} reason=${rejection}`);
      // §16 step 8 (shadow, POLICY_VIOLATION_LOG): one row per host × reason × hour, never per request
      recordPolicyViolation(db, { kind: 'token_rejected', actor: `host:${h.slice(0, 100)}`, severity: 'medium', dedupe_key: `${HOST_AGENT_SCOPE}:${h.slice(0, 100)}:${rejection}:${hourBucket()}`,
        evidence_ref: `token:${HOST_AGENT_SCOPE}`, description: `${HOST_AGENT_SCOPE} token rejected: ${rejection}` });
      res.status(401).json({ error: { code: 'HOST_TOKEN_INVALID', message: 'Host token is invalid, expired, or scoped to another host' } });
      return null;
    }
    return h;
  };
  router.post('/poll', (req, res) => {
    const h = host(req, res); if (!h) return;
    const info = typeof req.body?.info === 'object' && req.body.info ? req.body.info : {};
    // E1: the agent's GPU power reading (absent on hosts without rocm-smi / nvidia-smi); a bad sample never fails the heartbeat
    if (resourceLedgerEnabled()) { try { recordPowerSample(db, h, info.power); } catch { /* ledger is advisory */ } }
    try { res.json({ commands: fleet.poll(h, info, String(req.body?.version ?? '')) }); } catch (e) { fail(res, e); }
  });
  router.post('/commands/:id/result', (req, res) => {
    const h = host(req, res); if (!h) return;
    try { fleet.result(String(req.params.id), h, req.body?.exit_code ?? null, String(req.body?.output ?? '')); res.json({ recorded: true }); } catch (e) { fail(res, e); }
  });
  // T1 pull: the host's local System One claims queued shadow judgments and posts its answers
  const shadow = new LocalShadowQueue(db);
  router.post('/shadow/claim', (req, res) => {
    const h = host(req, res); if (!h) return;
    try { res.json({ jobs: shadow.claim(h, Number(req.body?.limit) || 4) }); } catch (e) { fail(res, e); }
  });
  router.post('/shadow/:id/result', (req, res) => {
    const h = host(req, res); if (!h) return;
    try { shadow.record(String(req.params.id), h, req.body || {}); res.json({ recorded: true }); } catch (e) {
      const code = e instanceof Error ? e.message : '';
      if (code === 'SHADOW_JOB_NOT_FOUND') { res.status(404).json({ error: { code, message: code } }); return; }
      if (code === 'SHADOW_JOB_NOT_CLAIMED') { res.status(409).json({ error: { code, message: code } }); return; }
      fail(res, e);
    }
  });
  router.post('/tokens', auth.requireAuth, auth.requirePermission('manage:tokens'), (req, res) => {
    const h = String(req.body?.host || '');
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(h)) { res.status(400).json({ error: { code: 'FLEET_HOST_INVALID', message: 'host is invalid' } }); return; }
    const ttlDays = Math.max(1, Math.min(Number(req.body?.ttl_days) || 90, 365));
    res.set('Cache-Control', 'no-store').status(201).json({ host: h, token: mintSpawnToken(resolveSpawnTokenSecret(), h, HOST_AGENT_SCOPE, ttlDays * 86_400_000), expires_in_days: ttlDays });
  });
  return router;
}

/** Operator side: liveness, requests (manage:config), approvals (approve:task). */
export function createFleetHostRoutes(db: Database, auth: AuthMiddleware): Router {
  const router = Router();
  router.use(limiter);
  const fleet = new FleetCommands(db);
  const actor = (req: any) => String(req.user?.sub || req.user?.email || '');
  router.get('/', auth.requirePermission('read:evidence'), (_req, res) => { res.json({ hosts: fleet.hosts(), commands: fleet.recent(100) }); });
  router.post('/commands', auth.requirePermission('manage:config'), (req, res) => {
    try { res.status(201).json(fleet.request(String(req.body?.host ?? ''), String(req.body?.command ?? ''), actor(req))); } catch (e) { fail(res, e); }
  });
  router.post('/commands/:id/approve', auth.requirePermission('approve:task'), (req, res) => {
    try { res.json(fleet.approve(String(req.params.id), actor(req), String(req.body?.sha256 ?? ''))); } catch (e) { fail(res, e); }
  });
  router.post('/commands/:id/deny', auth.requirePermission('approve:task'), (req, res) => {
    try { res.json(fleet.deny(String(req.params.id), actor(req), String(req.body?.reason ?? ''))); } catch (e) { fail(res, e); }
  });
  return router;
}
