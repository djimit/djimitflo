import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { RemoteGymService, REMOTE_GYM_SCOPE } from '../services/remote-gym-service';
import { mintSpawnToken, resolveSpawnTokenSecret, validateSpawnToken } from '../services/spawn-token';
import { RemoteMakerQueue } from '../services/remote-maker-queue';
import { ingestKbPages } from '../services/kb-corpus';

/**
 * Plan I1: a compute host pulls evolution-gym work. claim/result authenticate with a host-scoped token
 * (X-Gym-Host + X-Gym-Worker-Token, HMAC scope 'gym-worker'), like the Commons social runtimes; minting a token
 * needs an operator with manage:tokens and returns it once.
 */
export function createRemoteGymRoutes(db: Database, auth: AuthMiddleware): Router {
  const router = Router();
  const gym = new RemoteGymService(db);
  const makers = new RemoteMakerQueue(db);

  function host(req: any, res: any): string | null {
    const h = String(req.get('X-Gym-Host') || '');
    if (!h || !validateSpawnToken(resolveSpawnTokenSecret(), String(req.get('X-Gym-Worker-Token') || ''), h, REMOTE_GYM_SCOPE)) {
      res.status(401).json({ error: { code: 'GYM_WORKER_TOKEN_INVALID', message: 'Gym worker token is invalid, expired, or scoped to another host' } });
      return null;
    }
    return h;
  }
  const fail = (res: any, error: unknown) => {
    const code = error instanceof Error ? error.message : 'GYM_WORKER_ERROR';
    res.status(/^GYM_(HOST|SPECIES|RESULT)_|^MAKER_(RESULT|PATCH)_/.test(code) ? 400 : /_NOT_FOUND$/.test(code) ? 404 : code === 'GYM_RUN_ALREADY_SETTLED' || code === 'MAKER_JOB_NOT_CLAIMED' ? 409 : 500).json({ error: { code, message: code } });
  };

  router.post('/claim', (req, res) => {
    const h = host(req, res); if (!h) return;
    try { res.json(gym.claim(h, Array.isArray(req.body?.species) ? req.body.species : [])); } catch (error) { fail(res, error); }
  });

  router.post('/runs/:runId/result', (req, res) => {
    const h = host(req, res); if (!h) return;
    try { gym.record(String(req.params.runId), h, req.body || {}); res.json({ recorded: true }); } catch (error) { fail(res, error); }
  });

  // plan I3: maker jobs for real goals; only a patch comes back, the VPS applies it and runs every gate
  router.post('/maker/claim', (req, res) => {
    const h = host(req, res); if (!h) return;
    try { res.json({ job: makers.claim(h, Array.isArray(req.body?.species) ? req.body.species.map(String) : []) }); } catch (error) { fail(res, error); }
  });

  router.post('/maker/:jobId/result', (req, res) => {
    const h = host(req, res); if (!h) return;
    try { makers.record(String(req.params.jobId), h, req.body || {}); res.json({ recorded: true }); } catch (error) { fail(res, error); }
  });

  // plan L2: the workstation pushes changed DjimitKBWiki pages; stored only after a safety check and an embedding
  router.post('/kb', async (req, res) => {
    const h = host(req, res); if (!h) return;
    try { res.json(await ingestKbPages(db, h, req.body?.pages)); } catch (error) { const code = error instanceof Error ? error.message : 'KB_ERROR'; res.status(code.startsWith('KB_PAGES_INVALID') ? 400 : 500).json({ error: { code, message: code } }); }
  });

  router.post('/tokens', auth.requireAuth, auth.requirePermission('manage:tokens'), (req, res) => {
    const h = String(req.body?.host || '');
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(h)) { res.status(400).json({ error: { code: 'GYM_HOST_INVALID', message: 'host is invalid' } }); return; }
    const ttlDays = Math.max(1, Math.min(Number(req.body?.ttl_days) || 30, 90));
    res.set('Cache-Control', 'no-store').status(201).json({ host: h, token: mintSpawnToken(resolveSpawnTokenSecret(), h, REMOTE_GYM_SCOPE, ttlDays * 86_400_000), expires_in_days: ttlDays });
  });

  return router;
}
