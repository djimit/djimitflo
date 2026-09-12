import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createRepositoryRoutes } from '../routes/repositories';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { errorHandler } from '../middleware/error-handler';

describe('repository route chain', () => {
  let db: Database.Database;
  let root: string;
  let token: string;
  let app: express.Express;
  let previousJwtSecret: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-repository-route-'));
    root = fs.realpathSync(root);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Fixture instructions\n\nKeep changes bounded.\n');
    previousJwtSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'repository-route-fixture-secret';
    db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
    const authService = new AuthService(db);
    token = authService.generateToken(authService.createUser('repository-admin@test', 'test-password-only', 'admin'));
    const auth = createAuthMiddleware(authService);
    app = express(); app.use(express.json()); app.use(auth.requireAuth);
    app.use('/api/repositories', createRepositoryRoutes(db, auth)); app.use(errorHandler);
  });

  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); if (previousJwtSecret) process.env.JWT_SECRET = previousJwtSecret; else delete process.env.JWT_SECRET; });

  it('scans, persists, reopens and validates repository projections', async () => {
    const scan = await request(app).post('/api/repositories/scan').auth(token, { type: 'bearer' }).send({ path: root });
    expect(scan.status).toBe(200);
    expect(scan.body.repository).toMatchObject({ path: root, has_agents_md: true, package_manager: 'npm' });
    const id = scan.body.repository.id;

    const list = await request(app).get('/api/repositories').auth(token, { type: 'bearer' });
    expect(list.status).toBe(200); expect(list.body.repositories).toHaveLength(1);
    expect(list.body.repositories[0]).toMatchObject({ id, path: root });
    const detail = await request(app).get('/api/repositories/missing-repository').auth(token, { type: 'bearer' });
    expect(detail.status).toBe(404); expect(detail.body.error.code).toBe('REPOSITORY_NOT_FOUND');

    const rescan = await request(app).post(`/api/repositories/${id}/rescan`).auth(token, { type: 'bearer' }).send({});
    expect(rescan.status).toBe(200); expect(rescan.body.repository.id).toBe(id);
    const health = await request(app).get(`/api/repositories/${id}/health`).auth(token, { type: 'bearer' });
    expect(health.status).toBe(200); expect(health.body.health_score).toEqual(expect.any(Number));
    const agents = await request(app).get(`/api/repositories/${id}/agents-md`).auth(token, { type: 'bearer' });
    expect(agents.status).toBe(200); expect(agents.body.files).toHaveLength(1);
    const effective = await request(app).get(`/api/repositories/${id}/agents-md/effective?path=/`).auth(token, { type: 'bearer' });
    expect(effective.status).toBe(200); expect(effective.body).toBeDefined();
    const validated = await request(app).post(`/api/repositories/${id}/agents-md/validate`).auth(token, { type: 'bearer' }).send({});
    expect(validated.status).toBe(200); expect(validated.body.total).toEqual(expect.any(Number));
    const changes = await request(app).get(`/api/repositories/${id}/file-changes`).auth(token, { type: 'bearer' });
    expect(changes.status).toBe(200); expect(changes.body.file_changes).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM repository_scans WHERE repository_id = ?').get(id)).toEqual({ n: 2 });
  });
});
