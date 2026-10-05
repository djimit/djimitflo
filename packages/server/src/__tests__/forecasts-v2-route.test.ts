import { expect, it } from 'vitest';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createTestDb } from './helpers/test-db';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createHealthRoutes } from '../routes/health';
import { buildEvolutionEvidence } from '../services/evolution-evidence';

it('RX-7: GET /api/health/forecasts-v2 requires read:evidence and returns forecasters + would_have_stopped', async () => {
  const db = createTestDb();
  const authService = new AuthService(db);
  const auth = createAuthMiddleware(authService);
  const viewer = authService.generateToken(authService.createUser('fv2-viewer@example.test', 'disposable-password', UserRole.VIEWER));
  const app = express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use('/api/health', createHealthRoutes(db, auth));
  expect((await request(app).get('/api/health/forecasts-v2')).status).toBe(401);
  const res = await request(app).get('/api/health/forecasts-v2').set('Authorization', `Bearer ${viewer}`);
  expect(res.status).toBe(200); // viewers hold read:evidence
  expect(res.body).toMatchObject({ forecasters: expect.any(Array), would_have_stopped: expect.any(Array) });
});

it('RX-7: Gate D is unknown with no scored forecaster and red when every forecaster is insufficient', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
  const NOW = Date.now();
  expect(buildEvolutionEvidence(db, {}, NOW).gates.D.state).toBe('unknown');
  const at = (m: number) => new Date(NOW - 86_400_000 + m * 60_000).toISOString();
  for (let i = 0; i < 5; i++) {
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at) VALUES (?, 'feature', 't', 'd', 'r', 'gap_analysis', ?, 0.5, ?, ?)`).run(`p${i}`, i ? 'regressed' : 'verified', at(0), at(300));
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at) VALUES (?, 'forecast:resident:a', 'self_improvement', ?, '', 'shadow', 'yes', '', '{"p":0.3}', ?)`).run(`j${i}`, `p${i}`, at(100));
  }
  const e = buildEvolutionEvidence(db, {}, NOW);
  expect(e.forecasts_v2).toMatchObject({ scored: 1, decision_grade: 0, insufficient: 1 });
  expect(e.gates.D.state).toBe('red');
});
