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
import { createMCPRoutes } from '../routes/mcp';
import { createSwarmRoutes } from '../routes/swarms';

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
    app.use('/approvals', createApprovalRoutes(db, undefined, passAuth));
    app.use('/backups', createBackupRoutes(db, passAuth));
    app.use('/exports', createExportRoutes(db, passAuth));
    app.use('/openmythos', createOpenMythosRoutes(db, passAuth));
    app.use('/runtime-governance', createRuntimeGovernanceRoutes(db, passAuth));
    app.use('/mcp', createMCPRoutes(db, passAuth));
    app.use('/swarms/spawns', createSpawnRoutes(db, passAuth));
    app.use('/swarms', createSwarmRoutes(db, passAuth));
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
    expect((await request('/openmythos/runs')).status).toBe(200);
    expect((await request('/openmythos/leaderboard')).status).toBe(200);
    expect((await request('/openmythos/apex/reports')).status).toBe(200);
    expect((await request('/openmythos/apex/reports/-1')).status).toBe(400);
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

  it('exercises MCP and swarm intelligence contracts without external execution', async () => {
    expect((await request('/mcp/tools')).status).toBe(200);
    expect((await request('/mcp/permissions/missing', { method: 'PATCH', body: '{}' })).status).toBe(404);
    expect((await request('/swarms/specialist-panels')).status).toBe(200);
    expect((await request('/swarms/opencode/health')).status).toBe(200);

    const hypothesis = await request('/swarms/intelligence/hypotheses', {
      method: 'POST', body: JSON.stringify({ question: 'Is the contract reachable?' }),
    });
    expect(hypothesis.status).toBe(201);
    const hypothesisId = (await hypothesis.json() as any).id;
    expect((await request('/swarms/intelligence/hypotheses')).status).toBe(200);
    expect((await request(`/swarms/intelligence/hypotheses/${hypothesisId}/transition`, {
      method: 'POST', body: JSON.stringify({ state: 'testing', evidence_refs: [] }),
    })).status).toBe(200);

    const mission = await request('/swarms/intelligence/missions', {
      method: 'POST', body: JSON.stringify({ title: 'Contract mission' }),
    });
    expect(mission.status).toBe(201);
    const missionId = (await mission.json() as any).id;
    expect((await request('/swarms/intelligence/missions')).status).toBe(200);
    expect((await request(`/swarms/intelligence/missions/${missionId}`)).status).toBe(200);
    expect((await request(`/swarms/intelligence/missions/${missionId}/transition`, {
      method: 'POST', body: JSON.stringify({ status: 'hypothesized' }),
    })).status).toBe(200);
    expect((await request(`/swarms/intelligence/missions/${missionId}/tasks`)).status).toBe(200);
    const task = await request(`/swarms/intelligence/missions/${missionId}/tasks`, {
      method: 'POST', body: JSON.stringify({ title: 'Contract task' }),
    });
    expect(task.status).toBe(201);
    const taskId = (await task.json() as any).id;
    expect((await request(`/swarms/intelligence/tasks/${taskId}/transition`, {
      method: 'POST', body: JSON.stringify({ status: 'hypothesized' }),
    })).status).toBe(200);
    expect((await request(`/swarms/intelligence/missions/${missionId}/decisions`)).status).toBe(200);
    expect((await request('/swarms/intelligence/decisions', {
      method: 'POST', body: JSON.stringify({ mission_id: missionId, decision_type: 'route', decision: 'contract' }),
    })).status).toBe(201);

    expect((await request('/swarms/intelligence/circuit-breaker/contract')).status).toBe(200);
    expect((await request('/swarms/intelligence/circuit-breaker/contract/failure', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await request('/swarms/intelligence/circuit-breaker/contract/reset', { method: 'POST', body: '{}' })).status).toBe(200);

    for (const path of [
      '/swarms/expert/history', '/swarms/expert/sources', '/swarms/expert/updates',
      '/swarms/rsi/proposals', '/swarms/rsi/specializations', '/swarms/rsi/safety',
      '/swarms/learning/history', '/swarms/learning/last', '/swarms/learning-curve',
      '/swarms/economy', '/swarms/fix/history',
    ]) expect((await request(path)).status, path).toBe(200);
    expect((await request('/swarms/rsi/safety/toggle', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await request('/swarms/rsi/analyze', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await request('/swarms/learning/cycle', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await request('/swarms/fix/batch', { method: 'POST', body: JSON.stringify({ requests: [] }) })).status).toBe(200);
  });
});
