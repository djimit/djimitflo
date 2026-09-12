import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { UserRole } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { AuthService } from '../services/auth-service';
import { RuntimeGovernanceService } from '../services/runtime-governance-service';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { createRuntimeGovernanceRoutes } from '../routes/runtime-governance';

describe('runtime governance release HTTP contract', () => {
  const db = createTestDb();
  const tokens = new Map<UserRole, string>();
  const service = new RuntimeGovernanceService(db);
  let server: Server;
  let app: express.Express;

  beforeAll(async () => {
    const authService = new AuthService(db);
    // Keep these tokens independent from other HTTP fixtures that mutate JWT_SECRET concurrently.
    (authService as unknown as { jwtSecret: string }).jwtSecret = 'runtime-governance-release-http-fixture-secret';
    for (const role of [UserRole.ADMIN, UserRole.VIEWER]) {
      const user = authService.createUser(`${role}@runtime-governance.test`, 'Fixture-password-123!', role);
      tokens.set(role, authService.generateToken(user));
    }
    const auth = createAuthMiddleware(authService);
    app = express();
    app.use(express.json());
    app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));
    app.use('/runtime-governance', auth.requireAuth, createRuntimeGovernanceRoutes(db, auth, service));
    app.use(errorHandler);
    server = await new Promise(resolve => {
      const listener = app.listen(0, () => resolve(listener));
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    service.stop();
    db.close();
  });

  it('enforces operator auth, rejects malformed reasons, translates missing agents, and persists an approved release', async () => {
    const path = '/runtime-governance/agents/release-fixture/release';
    const call = (role: UserRole, body: unknown) => request(app)
      .post(path)
      .set('Authorization', `Bearer ${tokens.get(role)}`)
      .send(body);

    service.registerBaseline('release-fixture', {
      overallScore: 0.9,
      categoryScores: { governance: 0.9 },
      certifiedAt: new Date().toISOString(),
    });
    db.prepare(`UPDATE runtime_governance_agents
      SET quarantined = 1, circuit_breaker_tripped = 1, violation_count = 5
      WHERE agent_id = 'release-fixture'`).run();

    expect((await request(app).post(path).send({ reason: 'reviewed' })).status).toBe(401);
    expect((await call(UserRole.VIEWER, { reason: 'reviewed' })).status).toBe(403);

    for (const reason of [42, {}, []]) {
      const invalid = await call(UserRole.ADMIN, { reason });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
      expect(service.getQuarantineStatus('release-fixture')).toMatchObject({ quarantined: true, circuitBreakerTripped: true, violationCount: 5 });
    }

    const missing = await request(app)
      .post('/runtime-governance/agents/missing-agent/release')
      .set('Authorization', `Bearer ${tokens.get(UserRole.ADMIN)}`)
      .send({ reason: 'reviewed' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('AGENT_NOT_FOUND');

    const released = await call(UserRole.ADMIN, { reason: 'independent review completed' });
    expect(released.status).toBe(200);
    expect(released.body).toEqual({ released: true, agentId: 'release-fixture' });
    expect(service.getQuarantineStatus('release-fixture')).toMatchObject({ quarantined: false, circuitBreakerTripped: false, violationCount: 0 });
    expect(service.getAlerts(10)).toContainEqual(expect.objectContaining({
      agentId: 'release-fixture',
      type: 'quarantine_released',
      evidence: { reason: 'independent review completed' },
    }));
  });

  it('rejects invalid baseline scores without writing and persists an in-range baseline', async () => {
    const path = '/runtime-governance/agents/register-fixture/register';
    const invalidBaselines = [
      { overallScore: 10.1, categoryScores: {}, certifiedAt: new Date().toISOString() },
      { overallScore: '4', categoryScores: {}, certifiedAt: new Date().toISOString() },
      { overallScore: 4, categoryScores: { governance: -0.1 }, certifiedAt: new Date().toISOString() },
      { overallScore: 4, categoryScores: { governance: '4' }, certifiedAt: new Date().toISOString() },
      { overallScore: 4, categoryScores: [], certifiedAt: new Date().toISOString() },
      { overallScore: 4, categoryScores: null, certifiedAt: new Date().toISOString() },
      { overallScore: 4, categoryScores: '4', certifiedAt: new Date().toISOString() },
      { overallScore: 4, categoryScores: 4, certifiedAt: new Date().toISOString() },
      { overallScore: 4, categoryScores: {}, certifiedAt: 42 },
      { overallScore: 4, categoryScores: {}, certifiedAt: '   ' },
      { overallScore: 4, categoryScores: {}, certifiedAt: 'not-a-date' },
    ];

    const certifiedAt = ' 2026-09-12T09:30:00.000Z ';
    for (const baseline of invalidBaselines) {
      const response = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${tokens.get(UserRole.ADMIN)}`)
        .send(baseline);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(service.getQuarantineStatus('register-fixture').baseline).toBeNull();
    }

    const registered = await request(app)
      .post(path)
      .set('Authorization', `Bearer ${tokens.get(UserRole.ADMIN)}`)
      .send({ overallScore: 10, categoryScores: { governance: 0, injection: 10 }, certifiedAt });
    expect(registered.status).toBe(200);
    expect(service.getQuarantineStatus('register-fixture').baseline).toMatchObject({
      certifiedScore: 10,
      categoryScores: { governance: 0, injection: 10 },
      certifiedAt: certifiedAt.trim(),
    });
  });
});
