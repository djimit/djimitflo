import express from 'express';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { AuditService } from '../services/audit-service';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { createApprovalRoutes } from '../routes/approvals';
import { createAuthRoutes } from '../routes/auth';
import { createBackupRoutes } from '../routes/backup';
import { createExportRoutes } from '../routes/exports';
import { createOpenMythosRoutes } from '../routes/openmythos';
import { createRuntimeGovernanceRoutes } from '../routes/runtime-governance';
import { createSpawnRoutes } from '../routes/spawns';

describe('critical HTTP contracts', () => {
  const envKeys = ['DB_PATH', 'BACKUP_DIR', 'JWT_SECRET', 'AUTH_BOOTSTRAP_ADMIN_EMAIL', 'AUTH_BOOTSTRAP_ADMIN_PASSWORD'] as const;
  const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;
  let dataDir: string;
  let authToken: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'djimitflo-critical-http-'));
    process.env.DB_PATH = join(dataDir, 'test.sqlite');
    process.env.BACKUP_DIR = join(dataDir, 'backups');
    process.env.JWT_SECRET = 'c'.repeat(64);
    process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL = 'contract@example.com';
    process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD = 'Contract-test-password-123!';
    db = new Database(process.env.DB_PATH);
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);

    const authService = new AuthService(db);
    authService.bootstrapAdmin();
    authToken = authService.authenticate(process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL, process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD)!.token;
    const realAuth = createAuthMiddleware(authService);
    const passAuth = {
      requireAuth: (req: any, _res: any, next: any) => { req.user ||= { sub: 'contract-admin', email: 'contract@example.com', role: 'admin' }; next(); },
      optionalAuth: (req: any, _res: any, next: any) => { req.user ||= { sub: 'contract-admin', email: 'contract@example.com', role: 'admin' }; next(); },
      requirePermission: () => (req: any, _res: any, next: any) => { req.user ||= { sub: 'contract-admin', email: 'contract@example.com', role: 'admin' }; next(); },
    } as any;

    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.user = { sub: 'contract-admin', email: 'contract@example.com', role: 'admin' }; next(); });
    app.use('/auth', createAuthRoutes(authService, realAuth, new AuditService(db)));
    const expiredEngine = {
      handleApprovalDecision: async () => { throw new Error('APPROVAL_EXPIRED: Expired approvals cannot authorize execution.'); },
    } as any;
    app.use('/approvals', createApprovalRoutes(db, expiredEngine, passAuth));
    app.use('/backups', createBackupRoutes(db, passAuth));
    app.use('/exports', createExportRoutes(db, passAuth));
    app.use('/openmythos', createOpenMythosRoutes(db, passAuth));
    app.use('/runtime-governance', createRuntimeGovernanceRoutes(db, passAuth));
    app.use('/swarms/spawns', createSpawnRoutes(db, passAuth));
    app.use(errorHandler);
    server = await new Promise(resolve => {
      const listening = app.listen(0, () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  async function request(path: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  }

  it('exercises auth and approval success/error contracts', async () => {
    expect((await request('/auth/login', { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await request('/auth/me', { headers: { authorization: `Bearer ${authToken}` } })).status).toBe(200);
    expect((await request('/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${authToken}` } })).status).toBe(200);
    expect((await request('/approvals')).status).toBe(200);
    for (const [path, method] of [
      ['/approvals/missing', 'GET'], ['/approvals/missing', 'PATCH'], ['/approvals/missing/approve', 'POST'],
      ['/approvals/missing/deny', 'POST'], ['/approvals/missing/cancel', 'POST'],
    ]) expect((await request(path, { method })).status).toBe(404);

    db.prepare(`INSERT INTO tasks (id,title,description,status,priority,risk_level,execution_mode,tags,metadata)
      VALUES ('expired-task','Expired','Expired approval','awaiting_approval','low','high','local','[]','{}')`).run();
    db.prepare(`INSERT INTO approvals (id,task_id,status,risk_level,request_type,request_message,request_data,requested_by)
      VALUES ('expired-approval','expired-task','expired','high','high_risk_action','Expired','{}','maker')`).run();
    const expired = await request('/approvals/expired-approval/approve', { method: 'POST', body: '{}' });
    expect(expired.status).toBe(410);
    expect((await expired.json() as any).error.code).toBe('APPROVAL_EXPIRED');
  });

  it('exercises backup creation, retrieval, download, validation, and restore refusal', async () => {
    const created = await request('/backups', { method: 'POST', body: '{}' });
    expect(created.status).toBe(201);
    const filename = (await created.json() as any).filename;
    expect((await request('/backups')).status).toBe(200);
    expect((await request(`/backups/${filename}`)).status).toBe(200);
    expect((await request(`/backups/${filename}/download`)).status).toBe(200);
    expect((await request(`/backups/${filename}/validate`, { method: 'POST' })).status).toBe(200);
    expect((await request(`/backups/${filename}/restore`, { method: 'POST', body: JSON.stringify({ confirm: 'NO' }) })).status).toBe(400);
  });

  it('exercises every export contract with admin and missing-resource controls', async () => {
    expect((await request('/exports/task/missing', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await request('/exports/evidence/missing', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await request('/exports/audit', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await request('/exports/repository/missing', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await request('/exports/report/summary', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await request('/exports/training')).status).toBe(200);
  });

  it('exercises OpenMythos validation, no-data, guard, and report contracts', async () => {
    expect((await request('/openmythos/eval/agent', { method: 'POST', body: JSON.stringify({ case_ids: 'invalid' }) })).status).toBe(400);
    expect((await request('/openmythos/score/agent')).status).toBe(404);
    expect((await request('/openmythos/report/agent')).status).toBe(200);
    expect((await request('/openmythos/trend/agent')).status).toBe(200);
    expect((await request('/openmythos/guard/check/skill', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await request('/openmythos/guard/certified/skill')).status).toBe(200);
  });

  it('exercises every runtime-governance and spawn control contract', async () => {
    expect((await request('/runtime-governance/status')).status).toBe(200);
    expect((await request('/runtime-governance/alerts')).status).toBe(200);
    expect((await request('/runtime-governance/agents/agent')).status).toBe(200);
    expect((await request('/runtime-governance/agents/agent/register', { method: 'POST', body: JSON.stringify({ overallScore: 4, categoryScores: {}, certifiedAt: new Date().toISOString() }) })).status).toBe(200);
    expect((await request('/runtime-governance/agents/agent/check', { method: 'POST' })).status).toBe(200);
    expect((await request('/runtime-governance/agents/agent/release', { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await request('/runtime-governance/agents/agent/reset', { method: 'POST' })).status).toBe(200);
    expect((await request('/swarms/spawns/root', { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await request('/swarms/spawns', { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await request('/swarms/spawns/missing/status')).status).toBe(404);
  });
});
