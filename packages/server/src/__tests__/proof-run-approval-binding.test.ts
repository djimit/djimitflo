import express from 'express';
import Database from 'better-sqlite3';
import request from 'supertest';
import { rateLimit } from 'express-rate-limit';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { errorHandler } from '../middleware/error-handler';
import { createGovernanceRoutes } from '../routes/swarm-governance';
import { ProofRunService } from '../services/proof-run-service';

/**
 * AUTHZ-F1: POST /swarms/proof-runs passed body.human_approval_ref to completeLoopRun, whose human gate accepts any
 * non-empty string. The ref is now the authenticated caller (operator:<id>), and only when that caller holds approve:task.
 */
let db: Database.Database;
let user: { sub: string; role: string } | undefined;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });

function app() {
  const a = express();
  a.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false }));
  a.use(express.json());
  a.use((req, _res, next) => { (req as unknown as { user?: unknown }).user = user; next(); });
  a.use('/swarms', createGovernanceRoutes(db, { requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next() } as never));
  a.use(errorHandler);
  return a;
}

it('binds the proof run\'s human_approval_ref to the authenticated approver, never the body string', async () => {
  const create = vi.spyOn(ProofRunService.prototype, 'create').mockResolvedValue({ id: 'p1' } as never);
  user = { sub: 'admin-1', role: 'admin' };
  await request(app()).post('/swarms/proof-runs').send({ runtime: 'codex', human_approval_ref: 'approval:anything' }).expect(201);
  expect(create.mock.calls[0][0]).toMatchObject({ runtime: 'codex', human_approval_ref: 'operator:admin-1' });
  user = { sub: 'maker-1', role: 'maker' }; // no approve:task
  await request(app()).post('/swarms/proof-runs').send({ runtime: 'codex', human_approval_ref: 'approval:anything' }).expect(201);
  expect(create.mock.calls[1][0].human_approval_ref).toBeUndefined();
  user = { sub: 'admin-1', role: 'admin' };
  await request(app()).post('/swarms/proof-runs').send({ runtime: 'codex' }).expect(201); // not asked for: none
  expect(create.mock.calls[2][0].human_approval_ref).toBeUndefined();
});
