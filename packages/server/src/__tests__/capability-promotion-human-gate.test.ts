import express from 'express';
import Database from 'better-sqlite3';
import request from 'supertest';
import { rateLimit } from 'express-rate-limit';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { createSwarmIntelRoutes } from '../routes/swarm-intel';

/**
 * AUTHZ-F5 (S17): a high/critical capability's human gate used to accept any non-empty human_approval_ref from the body,
 * so a MAKER (write:capability) could register a high-risk capability and promote it to validated — live-routable for
 * spawn_runtime_worker — by sending human_approval_ref: "yes". The gate is now satisfied only by an authenticated caller
 * that holds approve:task, recorded as operator:<user id>.
 */
const db = new Database(':memory:');
const tokens = new Map<UserRole, string>(); const ids = new Map<UserRole, string>();
const originalSecret = process.env.JWT_SECRET;
let app: express.Express;

beforeAll(() => {
  process.env.JWT_SECRET = 'capability-gate-test-secret-'.repeat(3);
  db.exec(schema); runMigrations(db);
  const authService = new AuthService(db);
  for (const role of [UserRole.ADMIN, UserRole.MAKER]) {
    const user = authService.createUser(`${role}@cap.test`, 'Cap-test-only-password-123!', role);
    tokens.set(role, authService.generateToken(user)); ids.set(role, user.id);
  }
  const auth = createAuthMiddleware(authService);
  app = express();
  app.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use(express.json());
  app.use('/swarms', auth.requireAuth, createSwarmIntelRoutes(db, auth));
  app.use(errorHandler);
});
afterAll(() => {
  db.close();
  if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
});

const highRisk = (id: string) => new SwarmIntelligenceService(db).createCandidate({
  id, kind: 'runtime_adapter', owner: 'test', version: '0.1.0', risk_ceiling: 'high', input_schema_ref: 'none', output_schema_ref: 'none',
  allowed_actions: ['spawn_runtime_worker'], forbidden_actions: ['modify_secrets'], required_evidence: ['worker_lease'], eval_threshold: 0.8,
  removal_strategy: 'disable and review',
});
const promote = (role: UserRole, id: string, body: Record<string, unknown>) => request(app).post(`/swarms/intelligence/capabilities/${id}/promote`)
  .set('authorization', `Bearer ${tokens.get(role)}`).send({ eval_score: 0.9, evidence_refs: ['eval:1'], security_checker_ref: 'checker:1', ...body });

it('a MAKER cannot satisfy the high-risk human gate with a body string', async () => {
  highRisk('cap-maker');
  const res = await promote(UserRole.MAKER, 'cap-maker', { human_approval_ref: 'approval:yes' });
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('CAPABILITY_PROMOTION_HUMAN_APPROVAL_REQUIRED');
  expect(new SwarmIntelligenceService(db).getCapability('cap-maker')).toMatchObject({ status: 'candidate', live_route_allowed: false });
});

it('a caller holding approve:task satisfies it, recorded as operator:<user id> (not the body string)', async () => {
  highRisk('cap-admin');
  const res = await promote(UserRole.ADMIN, 'cap-admin', { human_approval_ref: 'approval:anything' });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('validated');
  expect(res.body.metadata.promotion_human_approval_ref).toBe(`operator:${ids.get(UserRole.ADMIN)}`);
});

it('an approver still has to ask for it: no human_approval_ref, no high-risk promotion', async () => {
  highRisk('cap-noref');
  const res = await promote(UserRole.ADMIN, 'cap-noref', {});
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('CAPABILITY_PROMOTION_HUMAN_APPROVAL_REQUIRED');
});

const contract = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'runtime_adapter', owner: 'maker', version: '1.0.0', risk_ceiling: 'critical', input_schema_ref: 'none', output_schema_ref: 'none',
  allowed_actions: ['spawn_runtime_worker'], forbidden_actions: ['modify_secrets'], required_evidence: ['worker_lease'], eval_score: 1, eval_threshold: 0.5,
  removal_strategy: 'disable', ...extra,
});
const register = (role: UserRole, body: Record<string, unknown>) => request(app).post('/swarms/intelligence/capabilities')
  .set('authorization', `Bearer ${tokens.get(role)}`).send(body);

it('AUTHZ-F5 (D1): a MAKER cannot register a capability straight into the live status', async () => {
  const res = await register(UserRole.MAKER, contract('cap-direct', { status: 'validated' }));
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('SWARM_CAPABILITY_PROMOTION_REQUIRED');
  expect(db.prepare("SELECT COUNT(*) n FROM swarm_capabilities WHERE id = 'cap-direct'").get()).toEqual({ n: 0 });
  expect((await register(UserRole.MAKER, contract('cap-direct', { status: 'candidate' }))).status).toBe(201); // proposing is unchanged
});

it('AUTHZ-F5 (D1): re-registering does not overwrite a validated or outcome-held capability (risk, actions, hold)', async () => {
  highRisk('cap-locked');
  expect((await promote(UserRole.ADMIN, 'cap-locked', { human_approval_ref: 'approval:ok' })).status).toBe(200);
  const res = await register(UserRole.MAKER, contract('cap-locked', { status: 'candidate', risk_ceiling: 'low' }));
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('SWARM_CAPABILITY_LOCKED');
  expect(new SwarmIntelligenceService(db).getCapability('cap-locked')).toMatchObject({ status: 'validated', risk_ceiling: 'high' });
  db.prepare("UPDATE swarm_capabilities SET status = 'candidate', metadata = json_set(metadata, '$.outcome_hold', json('{\"reason\":\"regressed\"}')) WHERE id = 'cap-locked'").run();
  expect((await register(UserRole.MAKER, contract('cap-locked', { status: 'candidate' }))).body.error.code).toBe('SWARM_CAPABILITY_LOCKED');
});
