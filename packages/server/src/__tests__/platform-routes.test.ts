import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { UserRole } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createPlatformRoutes } from '../routes/platform';

describe('cognitive platform HTTP contracts', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('requires authentication and executes status and cycle against the shared SQLite platform', async () => {
    const db = createTestDb();
    dbs.push(db);
    const authService = new AuthService(db);
    const user = authService.createUser('platform-http@example.test', 'disposable-password', UserRole.ADMIN);
    const token = authService.generateToken(user);
    const auth = createAuthMiddleware(authService);
    const app = express().use('/api/platform', auth.requireAuth, createPlatformRoutes(db, auth));

    expect((await request(app).get('/api/platform/status')).status).toBe(401);
    const status = await request(app).get('/api/platform/status').set('Authorization', `Bearer ${token}`);
    expect(status.status).toBe(200);
    expect(status.body).toHaveProperty('cognitive');
    expect(status.body).toHaveProperty('governance');

    const cycle = await request(app).post('/api/platform/cycle').set('Authorization', `Bearer ${token}`).send({});
    expect(cycle.status).toBe(200);
    expect(cycle.body).toHaveProperty('cycleId');
    expect(cycle.body).toHaveProperty('memoryMaintenance');
  });
});
