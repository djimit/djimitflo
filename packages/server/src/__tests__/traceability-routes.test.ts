import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { UserRole } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createTraceabilityRoutes } from '../routes/traceability';

describe('traceability HTTP contract', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('requires authentication and returns the generated matrix from specs', async () => {
    const db = createTestDb();
    dbs.push(db);
    const authService = new AuthService(db);
    const user = authService.createUser('traceability-http@example.test', 'disposable-password', UserRole.ADMIN);
    const token = authService.generateToken(user);
    const auth = createAuthMiddleware(authService);
    const app = express().use('/api/traceability', auth.requireAuth, createTraceabilityRoutes());

    expect((await request(app).get('/api/traceability/matrix')).status).toBe(401);
    const response = await request(app).get('/api/traceability/matrix').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('totalFRs');
    expect(response.body).toHaveProperty('coveredFRs');
    expect(response.body).toHaveProperty('coveragePercent');
    expect(response.body.totalFRs).toBeGreaterThanOrEqual(0);
  });
});
