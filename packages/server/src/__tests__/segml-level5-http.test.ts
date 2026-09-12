import { expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { UserRole } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createSegmlL5Routes } from '../routes/segml-l5';

it('does not expose unproven Level 5 proposals as applied evolution over HTTP', async () => {
  const db = createTestDb();
  try {
    const authService = new AuthService(db);
    const user = authService.createUser('segml-l5-http@example.test', 'disposable-password', UserRole.ADMIN);
    const token = authService.generateToken(user);
    const auth = createAuthMiddleware(authService);
    const app = express()
      .use('/api/segml/l5', auth.requireAuth, createSegmlL5Routes(db, auth));

    expect((await request(app).post('/api/segml/l5/self-improve')).status).toBe(401);

    const cycle = await request(app)
      .post('/api/segml/l5/self-improve')
      .set('Authorization', `Bearer ${token}`);
    expect(cycle.status).toBe(200);
    expect(cycle.body).toMatchObject({ generation: 1, steps: [], applied: 0 });

    const status = await request(app)
      .get('/api/segml/l5/status')
      .set('Authorization', `Bearer ${token}`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ generation: 1, appliedModifications: 0, totalEvolutionGain: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM segml_l5_modification_proofs WHERE verified = 1').get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM segml_l5_evolution_log').get())
      .toEqual({ count: 0 });

    expect((await request(app)
      .post('/api/segml/l5/revert/missing-step')
      .set('Authorization', `Bearer ${token}`)).body).toEqual({ reverted: false });

    db.prepare(`INSERT INTO segml_l5_improvement_areas
      (id, area, severity, description, proposed_change, expected_gain, risk_level, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'applied')`)
      .run('area-http', 'fixture', 'low', 'fixture', 'fixture change', 0, 0.1);
    db.prepare(`INSERT INTO segml_l5_modification_proofs
      (id, area_id, before_metrics_json, after_metrics_json, proof_type, verified, verified_at)
      VALUES (?, ?, ?, ?, 'test_pass', 1, ?)`)
      .run('proof-http', 'area-http', '{}', '{}', new Date().toISOString());
    db.prepare(`INSERT INTO segml_l5_evolution_log
      (id, generation, modification, proof_id, cumulative_gain)
      VALUES (?, ?, ?, ?, ?)`)
      .run('step-http', 1, 'fixture change', 'proof-http', 0);

    const reverted = await request(app)
      .post('/api/segml/l5/revert/step-http')
      .set('Authorization', `Bearer ${token}`);
    expect(reverted.status).toBe(200);
    expect(reverted.body).toEqual({ reverted: true });
    expect(db.prepare('SELECT status FROM segml_l5_improvement_areas WHERE id = ?').get('area-http'))
      .toEqual({ status: 'reverted' });
    expect(db.prepare('SELECT reverted_at IS NOT NULL AS reverted FROM segml_l5_evolution_log WHERE id = ?').get('step-http'))
      .toEqual({ reverted: 1 });
  } finally {
    db.close();
  }
});
