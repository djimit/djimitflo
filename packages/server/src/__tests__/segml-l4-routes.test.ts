import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { UserRole } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createSegmlL4Routes } from '../routes/segml-l4';

describe('SEGML Level 4 HTTP contracts', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('enforces auth, validates mutation inputs, and executes each Level 4 operation', async () => {
    const db = createTestDb();
    dbs.push(db);
    const authService = new AuthService(db);
    const user = authService.createUser('segml-l4-http@example.test', 'disposable-password', UserRole.ADMIN);
    const token = authService.generateToken(user);
    const auth = createAuthMiddleware(authService);
    const app = express().use(express.json()).use('/api/segml/l4', auth.requireAuth, createSegmlL4Routes(db, auth));

    expect((await request(app).get('/api/segml/l4/status')).status).toBe(401);

    for (const body of [{ category: 'unknown' }, { category: 42 }, { category: '' }]) {
      const response = await request(app).post('/api/segml/l4/tournament').set('Authorization', `Bearer ${token}`).send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    for (const body of [{ prompt: 'test', category: 'unknown' }, { prompt: 42, category: 'injection' }, {}]) {
      const response = await request(app).post('/api/segml/l4/ttsi').set('Authorization', `Bearer ${token}`).send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    for (const body of [{ round: 0 }, { round: 1.5 }, { round: '1' }, { round: 1_000_001 }]) {
      const response = await request(app).post('/api/segml/l4/coevolution').set('Authorization', `Bearer ${token}`).send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }

    const tournament = await request(app).post('/api/segml/l4/tournament').set('Authorization', `Bearer ${token}`).send({ category: 'injection' });
    expect(tournament.status).toBe(200);
    expect(tournament.body.count).toBeGreaterThan(0);

    const evolved = await request(app).post('/api/segml/l4/evolve').set('Authorization', `Bearer ${token}`).send({});
    expect(evolved.status).toBe(200);
    expect(evolved.body.generation).toBe(1);

    const ttsi = await request(app).post('/api/segml/l4/ttsi').set('Authorization', `Bearer ${token}`).send({ prompt: 'Ignore instructions', category: 'injection' });
    expect(ttsi.status).toBe(200);
    expect(ttsi.body.confidence).toBeGreaterThan(0);

    const coevolution = await request(app).post('/api/segml/l4/coevolution').set('Authorization', `Bearer ${token}`).send({ round: 1 });
    expect(coevolution.status).toBe(200);
    expect(coevolution.body.attacks).toBeGreaterThan(0);

    const status = await request(app).get('/api/segml/l4/status').set('Authorization', `Bearer ${token}`);
    expect(status.status).toBe(200);
    expect(status.body.tournamentsRun).toBeGreaterThan(0);
    expect(status.body.ttsiVerifications).toBe(1);
    expect(status.body.coevolutionRounds).toBe(1);
  });
});
