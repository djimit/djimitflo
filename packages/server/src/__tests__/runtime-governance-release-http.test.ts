import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { UserRole } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { AuthService } from '../services/auth-service';
import { RuntimeGovernanceService } from '../services/runtime-governance-service';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { createRuntimeGovernanceRoutes } from '../routes/runtime-governance';

describe('runtime governance release HTTP contract', () => {
  const originalSecret = process.env.JWT_SECRET;
  const db = createTestDb();
  const tokens = new Map<UserRole, string>();
  const service = new RuntimeGovernanceService(db);
  let server: Server;
  let app: express.Express;

  beforeAll(async () => {
    vi.stubEnv('JWT_SECRET', 'runtime-governance-release-http-fixture-secret');
    const authService = new AuthService(db);
    for (const role of [UserRole.ADMIN, UserRole.VIEWER]) {
      const user = authService.createUser(`${role}@runtime-governance.test`, 'Fixture-password-123!', role);
      tokens.set(role, authService.generateToken(user));
    }
    const auth = createAuthMiddleware(authService);
    app = express();
    app.use(express.json());
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
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
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
});
