import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { UserRole } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createAgiRoutes } from '../routes/agi';
import { errorHandler } from '../middleware/error-handler';

let db: ReturnType<typeof createTestDb>;
let app: express.Express;
let token: string;

beforeEach(() => {
  db = createTestDb();
  const authService = new AuthService(db);
  const user = authService.createUser('agi-route@test.invalid', 'Agi-route-test-password-123!', UserRole.ADMIN);
  const auth = createAuthMiddleware(authService);
  token = authService.generateToken(user);
  app = express().use(express.json());
  app.use('/agi', auth.requireAuth, createAgiRoutes(db, auth));
  app.use(errorHandler);
});

afterEach(() => db.close());

it('requires authentication and executes the reasoning projection through SQLite', async () => {
  expect((await request(app).post('/agi/reason').send({})).status).toBe(401);
  const response = await request(app).post('/agi/reason').auth(token, { type: 'bearer' }).send({});
  expect(response.status).toBe(200);
  expect(response.body).toHaveProperty('observations');
  expect(response.body).toHaveProperty('hypotheses');
  expect(response.body).toHaveProperty('strategies');
  const observed = await request(app).get('/agi/observe').auth(token, { type: 'bearer' });
  expect(observed.status).toBe(200);
  expect(observed.body).toEqual(response.body.observations);
  expect((await request(app).get('/agi/reasoning/stats').auth(token, { type: 'bearer' })).body.totalReasoningSteps).toBe(3);
  expect((db.prepare('SELECT COUNT(*) AS count FROM goal_hypotheses').get() as { count: number }).count).toBeGreaterThanOrEqual(0);
});

it('drives the authenticated multi-agent consensus lifecycle through SQLite', async () => {
  expect((await request(app).post('/agi/consensus/debates').auth(token, { type: 'bearer' }).send({})).status).toBe(400);
  const debateResponse = await request(app).post('/agi/consensus/debates').auth(token, { type: 'bearer' })
    .send({ topic: 'Should the audit loop retain evidence?', context: 'G236 route proof' });
  expect(debateResponse.status).toBe(201);
  const debateId = debateResponse.body.id as string;

  expect((await request(app).post(`/agi/consensus/debates/${debateId}/proposals`).auth(token, { type: 'bearer' }).send({ agentId: 'agent-a' })).status).toBe(400);
  const proposalResponse = await request(app).post(`/agi/consensus/debates/${debateId}/proposals`).auth(token, { type: 'bearer' })
    .send({ agentId: 'agent-a', content: 'Retain immutable evidence and label uncertainty.', evidence: ['evidence:g236'], confidence: 0.9 });
  expect(proposalResponse.status).toBe(201);
  const proposalId = proposalResponse.body.id as string;

  expect((await request(app).post(`/agi/consensus/debates/${debateId}/vote`).auth(token, { type: 'bearer' }).send({ proposalId, agentId: 'agent-b' })).status).toBe(400);
  const voteResponse = await request(app).post(`/agi/consensus/debates/${debateId}/vote`).auth(token, { type: 'bearer' })
    .send({ proposalId, agentId: 'agent-b', type: 'strong_agree', reason: 'Evidence remains auditable.' });
  expect(voteResponse.status).toBe(200);

  const resolved = await request(app).post(`/agi/consensus/debates/${debateId}/resolve`).auth(token, { type: 'bearer' }).send({});
  expect(resolved.status).toBe(200);
  expect(resolved.body).toMatchObject({ debateId, winningProposalId: proposalId, status: 'resolved' });
  const stored = await request(app).get(`/agi/consensus/debates/${debateId}`).auth(token, { type: 'bearer' });
  expect(stored.status).toBe(200);
  expect(stored.body.proposals[0].votes).toHaveLength(1);
  expect((await request(app).get('/agi/consensus/stats').auth(token, { type: 'bearer' })).body).toMatchObject({ totalDebates: 1, resolved: 1, totalProposals: 1, totalVotes: 1 });
});
