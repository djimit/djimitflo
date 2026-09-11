import express from 'express';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { ApprovalService } from '../services/approval-service';
import { AuditService } from '../services/audit-service';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { createApprovalRoutes } from '../routes/approvals';
import { createAuditRoutes } from '../routes/audit';
import { createAuditLogRoutes } from '../routes/audit-logs';
import { createAuthorityRoutes } from '../routes/authority';
import { createHealthRoutes } from '../routes/health';
import { KnowledgeRuntimeService } from '../services/knowledge-runtime-service';

describe('approval HTTP role visibility and independent decision', () => {
  const db = new Database(':memory:');
  const originalSecret = process.env.JWT_SECRET;
  const tokens = new Map<UserRole, string>();
  let server: Server;
  let base: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'approval-http-test-secret-'.repeat(3);
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    const authService = new AuthService(db);
    const users = new Map(Object.values(UserRole).map(role => {
      const user = authService.createUser(`${role}@approval.test`, 'Approval-test-only-password-123!', role);
      tokens.set(role, authService.generateToken(user));
      return [role, user];
    }));
    db.prepare(`INSERT INTO tasks (id,title,description,status,priority,risk_level,execution_mode,owner_user_id,created_by)
      VALUES ('role-task','Review','Independent review','awaiting_approval','low','high','local',?,?)`)
      .run(users.get(UserRole.MAKER)!.id, users.get(UserRole.MAKER)!.id);
    db.prepare(`INSERT INTO approvals (id,task_id,status,risk_level,request_type,request_message,request_data,requested_by,expires_at)
      VALUES ('role-approval','role-task','pending','high','high_risk_action','Review','{}',?,?)`)
      .run(users.get(UserRole.MAKER)!.id, new Date(Date.now() + 60_000).toISOString());
    const auth = createAuthMiddleware(authService);
    const service = new ApprovalService(db, { broadcastTaskEventById: () => {} }, new AuditService(db));
    const engine = { handleApprovalDecision: async (id: string, approved: boolean, actor: string) => service.decideApproval(id, approved, actor) } as any;
    const app = express();
    app.use(express.json());
    app.use('/approvals', auth.requireAuth, createApprovalRoutes(db, engine, auth));
    app.use('/audit', auth.requireAuth, createAuditRoutes(db, new AuditService(db), auth));
    app.use('/audit-logs', createAuditLogRoutes(db, auth.requireAuth));
    app.use('/authority', auth.requireAuth, createAuthorityRoutes(db, auth));
    app.use('/health', createHealthRoutes(db, auth));
    app.use('/api/health', createHealthRoutes(db, auth));
    app.use(errorHandler);
    server = await new Promise(resolve => { const listener = app.listen(0, () => resolve(listener)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  it('shows the correct queue to each role and lets an independent approver decide', async () => {
    const request = (role: UserRole, path = '/approvals', method = 'GET') => fetch(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${tokens.get(role)}`, 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    for (const role of Object.values(UserRole)) {
      const expectedVisible = ![UserRole.CHECKER, UserRole.VIEWER].includes(role);
      const list = await request(role);
      expect(list.status, role).toBe(200);
      expect((await list.json() as any).approvals.map((row: any) => row.id), role).toEqual(expectedVisible ? ['role-approval'] : []);
      expect((await request(role, '/approvals/role-approval')).status, role).toBe(expectedVisible ? 200 : 404);
      if (![UserRole.ADMIN, UserRole.APPROVER].includes(role)) {
        expect((await request(role, '/approvals/role-approval/approve', 'POST')).status, role).toBe(403);
      }
    }
    expect((await request(UserRole.APPROVER, '/approvals/role-approval/approve', 'POST')).status).toBe(200);
    expect((db.prepare("SELECT status FROM approvals WHERE id = 'role-approval'").get() as any).status).toBe('approved');
    expect((db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'approval.granted'").get() as any).count).toBe(1);
    const audit = await request(UserRole.AUDITOR, '/audit');
    expect(audit.status).toBe(200);
    expect((await audit.json() as any).events.some((event: any) => event.event_type === 'approval.granted')).toBe(true);
    expect((await request(UserRole.VIEWER, '/audit')).status).toBe(403);
    expect((await request(UserRole.VIEWER, '/audit-logs')).status).toBe(403);
    expect((await request(UserRole.VIEWER, '/audit-logs/export')).status).toBe(403);
    const logs = await request(UserRole.AUDITOR, '/audit-logs?resource_type=approval');
    expect(logs.status).toBe(200);
    expect((await logs.json() as any[]).every(event => event.resource_type === 'approval')).toBe(true);
    for (const query of ['limit=0', 'limit=NaN', 'limit=1.5', 'offset=-1', 'offset=NaN', 'offset=1.5']) {
      const invalid = await request(UserRole.AUDITOR, `/audit-logs?${query}`);
      expect(invalid.status, query).toBe(400);
      expect((await invalid.json() as any).error.code, query).toBe('VALIDATION_ERROR');
    }
  });

  it('authenticates protected health routes and grants authority reads to audit roles', async () => {
    for (const role of Object.values(UserRole)) {
      const headers = { authorization: `Bearer ${tokens.get(role)}` };
      const canAudit = [UserRole.ADMIN, UserRole.PLATFORM_ADMIN, UserRole.AUDITOR].includes(role);
      for (const path of ['/authority/stats', '/authority/trace/test', '/authority/events']) {
        const response = await fetch(`${base}${path}`, { headers });
        expect(response.status, role).toBe(canAudit ? 503 : 403);
        if (canAudit) expect((await response.json() as any).error.code).toBe('AUTHORITY_LEDGER_UNAVAILABLE');
      }
      expect((await fetch(`${base}/health/metrics/json`, { headers })).status, role).toBe(200);
      expect((await fetch(`${base}/api/health/metrics/json`, { headers })).status, role).toBe(200);
    }
    for (const path of ['/health/metrics', '/health/metrics/json', '/health/deep']) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(401);
      expect((await fetch(`${base}${path}`, { headers: { authorization: 'Bearer invalid' } })).status, path).toBe(401);
    }
    // Existing externally provisioned ledger contract, confined to this fixture.
    db.exec(`CREATE TABLE authority_events (id TEXT PRIMARY KEY, event_id TEXT, correlation_id TEXT, sequence INTEGER,
      occurred_at TEXT, previous_state TEXT, requested_state TEXT, policy_decision TEXT, actor_subject TEXT,
      actor_type TEXT, actor_issuer TEXT, source_system TEXT)`);
    for (const path of ['/authority/stats', '/authority/trace/test', '/authority/events']) {
      expect((await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${tokens.get(UserRole.AUDITOR)}` } })).status).toBe(200);
    }
    for (const query of ['limit=-1', 'limit=NaN', 'limit=1.5', 'offset=-1', 'offset=NaN', 'offset=1.5']) {
      const invalid = await fetch(`${base}/authority/events?${query}`, { headers: { authorization: `Bearer ${tokens.get(UserRole.ADMIN)}` } });
      expect(invalid.status, query).toBe(400);
      expect((await invalid.json() as any).error.code, query).toBe('VALIDATION_ERROR');
    }
    const validPage = await fetch(`${base}/authority/events?decision=invalid&limit=1&offset=0`, { headers: { authorization: `Bearer ${tokens.get(UserRole.ADMIN)}` } });
    expect(validPage.status).toBe(200);
    expect((await validPage.json() as any).events.length).toBeLessThanOrEqual(1);
    const health = vi.spyOn(KnowledgeRuntimeService.prototype, 'health').mockReturnValue({
      exists: true, validate_okf: { status: 'pass' }, blocked_reasons: [],
    } as any);
    for (const name of ['LITELLM_URL', 'LITELLM_BASE_URL', 'OLLAMA_URL', 'QDRANT_URL']) vi.stubEnv(name, '');
    try {
      const response = await fetch(`${base}/health/deep`, { headers: { authorization: `Bearer ${tokens.get(UserRole.ADMIN)}` } });
      expect([200, 503]).toContain(response.status);
      const body = await response.json() as any;
      expect(body.checks.database.status).toBe('ok');
      expect(body.database).toHaveProperty('commit_sha');
    } finally {
      health.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
