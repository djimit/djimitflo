import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { UserRole } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createLoopRoutes } from '../routes/loops';
import { errorHandler } from '../middleware/error-handler';

it('projects a real loop plan and review bundle over authenticated HTTP', async () => {
  const db = createTestDb();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-loop-http-repo-'));
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-loop-http-evidence-'));
  try {
    fs.writeFileSync(path.join(repo, 'README.md'), '# Loop fixture\n\nTODO: document the bounded loop fixture.\n');
    const authService = new AuthService(db);
    const user = authService.createUser('loops-http@example.test', 'disposable-password', UserRole.ADMIN);
    const token = authService.generateToken(user);
    const auth = createAuthMiddleware(authService);
    const app = express()
      .use(express.json())
      .use('/api/loops', auth.requireAuth, createLoopRoutes(db, auth, evidenceRoot))
      .use(errorHandler);

    expect((await request(app).post('/api/loops/start')).status).toBe(401);

    const started = await request(app)
      .post('/api/loops/start')
      .set('Authorization', `Bearer ${token}`)
      .send({ loop_name: 'doc-drift-and-small-fix-loop', repository_path: repo, max_findings: 1 });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({
      id: expect.any(String),
      loop_name: 'doc-drift-and-small-fix-loop',
      repository_path: repo,
      metadata: { dry_run: true, workers_leased: 0, mutating_actions: false },
    });
    const runId = started.body.id as string;

    const listed = await request(app)
      .get('/api/loops/runs')
      .set('Authorization', `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body.runs).toEqual(expect.arrayContaining([expect.objectContaining({ id: runId })]));

    const runtimeContracts = await request(app)
      .get('/api/loops/runtime-contracts')
      .set('Authorization', `Bearer ${token}`);
    expect(runtimeContracts.status).toBe(200);
    expect(runtimeContracts.body).toEqual(expect.any(Object));

    const bundle = await request(app)
      .get(`/api/loops/runs/${runId}/review-bundle`)
      .set('Authorization', `Bearer ${token}`);
    expect(bundle.status).toBe(200);
    expect(bundle.body).toMatchObject({ run: { id: runId }, leases: [], state_content: expect.stringContaining(runId) });
    expect(bundle.body.events.length).toBeGreaterThan(0);

    const step = await request(app)
      .post(`/api/loops/runs/${runId}/step`)
      .set('Authorization', `Bearer ${token}`);
    expect(step.status).toBe(200);
    expect(step.body).toMatchObject({ run: { id: runId }, decision: expect.any(String), next_actions: expect.any(Array) });
  } finally {
    db.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
});
