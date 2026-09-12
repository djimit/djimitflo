import express from 'express';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { AuditService } from '../services/audit-service';
import { ApprovalService } from '../services/approval-service';
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
import { createSelfModificationRoutes } from '../routes/self-modification';
import { createSBOMRoutes } from '../routes/sbom';
import { createRepositoryIndexRoutes } from '../routes/repository-index';

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
    const approvalService = new ApprovalService(db, { broadcastTaskEventById: () => {} } as any, new AuditService(db));
    const approvalEngine = {
      handleApprovalDecision: async (id: string, approved: boolean, decidedBy: string, reason?: string) =>
        approvalService.decideApproval(id, approved, decidedBy, reason),
    } as any;
    app.use('/approvals', createApprovalRoutes(db, approvalEngine, passAuth));
    app.use('/backups', createBackupRoutes(db, passAuth));
    app.use('/exports', createExportRoutes(db, passAuth));
    app.use('/openmythos', createOpenMythosRoutes(db, passAuth));
    app.use('/runtime-governance', createRuntimeGovernanceRoutes(db, passAuth));
    app.use('/mcp', createMCPRoutes(db, passAuth));
    app.use('/swarms/spawns', createSpawnRoutes(db, passAuth));
    app.use('/swarms', createSwarmRoutes(db, passAuth));
    app.use('/self-modification', createSelfModificationRoutes(db, passAuth));
    app.use('/sbom', createSBOMRoutes(db, passAuth));
    app.use('/repo-index', createRepositoryIndexRoutes(db, passAuth));
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

  it('rejects coerced decisions and preserves terminal approvals', async () => {
    db.prepare(`INSERT INTO tasks (id,title,description,status,priority,risk_level,execution_mode)
      VALUES ('decision-task','Decision','Adversarial decision','awaiting_approval','low','high','local')`).run();
    const insert = db.prepare(`INSERT INTO approvals (id,task_id,status,risk_level,request_type,request_message,request_data,requested_by,expires_at)
      VALUES (?,'decision-task','pending','high','high_risk_action','Decision','{}','maker',?)`);
    const expiry = new Date(Date.now() + 60_000).toISOString();
    for (const [index, approved] of ['false', 'true', 1, 0, null, {}, []].entries()) {
      const id = `malformed-decision-${index}`;
      insert.run(id, expiry);
      expect((await request(`/approvals/${id}`, { method: 'PATCH', body: JSON.stringify({ approved }) })).status).toBe(400);
      expect((db.prepare('SELECT status FROM approvals WHERE id = ?').get(id) as any).status).toBe('pending');
    }
    insert.run('valid-denial', expiry);
    expect((await request('/approvals/valid-denial', { method: 'PATCH', body: JSON.stringify({ approved: false }) })).status).toBe(200);
    expect((db.prepare('SELECT status FROM approvals WHERE id = ?').get('valid-denial') as any).status).toBe('denied');
    expect((await request('/approvals/valid-denial/cancel', { method: 'POST' })).status).toBe(409);
    expect((db.prepare('SELECT status FROM approvals WHERE id = ?').get('valid-denial') as any).status).toBe('denied');
    insert.run('invalid-expiry', 'not-a-date');
    expect((await request('/approvals/invalid-expiry/approve', { method: 'POST', body: '{}' })).status).toBe(410);
    expect((db.prepare('SELECT status FROM approvals WHERE id = ?').get('invalid-expiry') as any).status).toBe('expired');
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
    const stream = await request('/exports/stream/audit');
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('application/x-ndjson');
    const events = (await stream.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(events.length).toBeGreaterThan(0);
    expect(events.map(event => event.id)).toEqual(
      (db.prepare('SELECT id FROM audit_events ORDER BY timestamp ASC').all() as any[]).map(event => event.id),
    );
  });

  it('exercises OpenMythos validation, no-data, guard, and report contracts', async () => {
    for (const path of ['/openmythos/attestations?limit=0', '/openmythos/runs?limit=NaN', '/openmythos/trend/agent?limit=1.5']) {
      const response = await request(path);
      expect(response.status, path).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
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

    for (const max_parallel of [0, -1, 1.5, 'NaN', null, 11]) {
      const response = await request('/swarms/expert/dispatch', {
        method: 'POST',
        body: JSON.stringify({ topic: 'validation-only', domains: [], max_parallel }),
      });
      expect(response.status, String(max_parallel)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }

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
    const invalidSafetyToggle = await request('/swarms/rsi/safety/toggle', { method: 'POST', body: JSON.stringify({ enabled: 'false' }) });
    expect(invalidSafetyToggle.status).toBe(400);
    const disabledSafety = await request('/swarms/rsi/safety/toggle', { method: 'POST', body: JSON.stringify({ enabled: false }) });
    expect(disabledSafety.status).toBe(200);
    expect(await disabledSafety.json()).toMatchObject({ enabled: false });
    expect(await (await request('/swarms/rsi/safety')).json()).toMatchObject({ enabled: false });
    expect((db.prepare("SELECT value FROM system_state WHERE key = 'rsi_safety_enabled'").get() as any).value).toBe('false');
    const loopRunsBeforeBlockedBatch = (db.prepare('SELECT COUNT(*) AS count FROM loop_runs').get() as { count: number }).count;
    const blockedBatch = await request('/swarms/fix/batch', {
      method: 'POST',
      body: JSON.stringify({ requests: [{
        repository_path: join(dataDir, 'missing-fix-repository'),
        file_path: 'README.md',
        description: 'Must be blocked before repository dispatch.',
        category: 'bug',
      }] }),
    });
    expect(blockedBatch.status).toBe(200);
    expect(await blockedBatch.json()).toMatchObject({
      results: [{ success: false, status: 'blocked', gates: ['rsi_safety_guard:blocked'] }],
    });
    expect((db.prepare('SELECT COUNT(*) AS count FROM loop_runs').get() as { count: number }).count).toBe(loopRunsBeforeBlockedBatch);
    const enabledSafety = await request('/swarms/rsi/safety/toggle', { method: 'POST', body: JSON.stringify({ enabled: true }) });
    expect(await enabledSafety.json()).toMatchObject({ enabled: true });
    expect((await request('/swarms/rsi/analyze', { method: 'POST', body: '{}' })).status).toBe(200);
    const learningCycleResponse = await request('/swarms/learning/cycle', { method: 'POST', body: '{}' });
    expect(learningCycleResponse.status).toBe(200);
    const learningCycle = await learningCycleResponse.json() as any;
    expect(learningCycle).toMatchObject({ id: expect.any(String), producer: 'continuous-learning-loop', schemaVersion: 1 });
    expect(await (await request('/swarms/learning/last')).json()).toMatchObject({ id: learningCycle.id });
    expect((db.prepare('SELECT result_json FROM learning_cycles WHERE id = ?').get(learningCycle.id) as any).result_json)
      .toContain(learningCycle.id);
    expect((await request('/swarms/fix', { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await request('/swarms/fix', { method: 'POST', body: JSON.stringify({ repository_path: '/tmp', file_path: 'x', description: 'x', runtime: 'unknown' }) })).status).toBe(400);
    expect((await request('/swarms/fix/batch', { method: 'POST', body: JSON.stringify({ requests: {} }) })).status).toBe(400);
    expect((await request('/swarms/fix/batch', { method: 'POST', body: JSON.stringify({ requests: [] }) })).status).toBe(200);
  });

  it('exercises self-modification planning gates and SBOM generation', async () => {
    const status = await request('/self-modification/status');
    expect(status.status).toBe(200);
    const analysis = await request('/self-modification/analyze', { method: 'POST', body: '{}' });
    expect(analysis.status).toBe(200);
    const opportunities = (await analysis.json() as any).opportunities;
    expect(Array.isArray(opportunities)).toBe(true);
    if (opportunities.length > 0) {
      const plan = await request('/self-modification/plan', {
        method: 'POST', body: JSON.stringify({ opportunityId: opportunities[0].id }),
      });
      expect(plan.status).toBe(201);
    }
    expect((await request('/self-modification/plan', { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await request('/self-modification/plan', { method: 'POST', body: JSON.stringify({ opportunityId: 'missing' }) })).status).toBe(404);
    const execute = await request('/self-modification/execute', { method: 'POST', body: '{}' });
    expect(execute.status).toBe(451);
    expect((await execute.json() as any).error.code).toBe('SELF_MODIFICATION_DISABLED');

    const sbom = await request('/sbom/generate');
    expect(sbom.status).toBe(200);
    expect(sbom.headers.get('content-disposition')).toContain('sbom.json');
    const sbomBody = await sbom.json() as any;
    expect(sbomBody).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1 });
    expect(sbomBody.components.length).toBeGreaterThan(0);
    expect((await request('/sbom/summary')).status).toBe(200);
  });

  it('exercises repository-index registration, indexing, search, and deletion', async () => {
    const repositoryPath = join(dataDir, 'indexed-repository');
    mkdirSync(repositoryPath, { recursive: true });
    writeFileSync(join(repositoryPath, 'governance.ts'), 'export const governanceSignal = "verified";\n');
    for (const body of [{ name: {}, path: repositoryPath }, { name: 'fixture', path: [] }, { name: ' ', path: repositoryPath }, { name: 'fixture', path: repositoryPath, url: 7 }]) {
      const invalid = await request('/repo-index/register', { method: 'POST', body: JSON.stringify(body) });
      expect(invalid.status, JSON.stringify(body)).toBe(400);
    }
    const registered = await request('/repo-index/register', {
      method: 'POST', body: JSON.stringify({ name: 'fixture', path: repositoryPath }),
    });
    expect(registered.status).toBe(201);
    const repository = await registered.json() as any;
    expect((await request('/repo-index/repositories')).status).toBe(200);
    const indexed = await request(`/repo-index/${repository.id}/index`, { method: 'POST', body: '{}' });
    expect(indexed.status).toBe(200);
    expect((await indexed.json() as any).indexed_files).toBe(1);
    expect((await request(`/repo-index/${repository.id}/stats`)).status).toBe(200);
    const search = await request('/repo-index/search', {
      method: 'POST', body: JSON.stringify({ query: 'governanceSignal', repository_id: repository.id }),
    });
    expect(search.status).toBe(200);
    expect((await search.json() as any).count).toBeGreaterThan(0);
    for (const body of [
      { query: null }, { query: {} }, { query: [] }, { query: 7 }, { query: '   ' },
      { query: 'governanceSignal', repository_id: {} },
      { query: 'governanceSignal', file_pattern: [] },
      { query: 'governanceSignal', language: 7 },
      { query: 'governanceSignal', search_type: 'semantic' },
    ]) {
      const invalid = await request('/repo-index/search', { method: 'POST', body: JSON.stringify(body) });
      expect(invalid.status, JSON.stringify(body)).toBe(400);
    }
    for (const [field, value] of [['limit', 0], ['limit', -1], ['limit', 1.5], ['limit', 'invalid'], ['offset', -1], ['offset', 1.5], ['offset', 'invalid']] as const) {
      const invalid = await request('/repo-index/search', {
        method: 'POST', body: JSON.stringify({ query: 'governanceSignal', repository_id: repository.id, [field]: value }),
      });
      expect(invalid.status, `${field}=${value}`).toBe(400);
    }
    expect((await request(`/repo-index/${repository.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(`/repo-index/${repository.id}/stats`)).status).toBe(404);
    expect((await request(`/repo-index/${repository.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});
