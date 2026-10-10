import express from 'express';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rateLimit } from 'express-rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { ApprovalService } from '../services/approval-service';
import { AuditService } from '../services/audit-service';
import { MemoryCandidateService } from '../services/memory-candidate-service';
import { FleetCommands } from '../services/fleet-commands';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { createApprovalRoutes } from '../routes/approvals';
import { createSelfImprovementRoutes } from '../routes/self-improvement';
import { createGovernanceRoutes } from '../routes/swarm-governance';
import { createFleetHostRoutes } from '../routes/host-agent';

/**
 * Cockpit 3.0 audit integrity (B4 findings F1–F6): every operator decision names the human in the hash-chained audit trail,
 * approval input is validated, a self-approved root command is visible, and viewers do not see who is behind a Telegram id.
 */
describe('decision audit integrity', () => {
  const db = new Database(':memory:');
  const originalSecret = process.env.JWT_SECRET; const originalOkf = process.env.OKF_BASE;
  const okf = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-audit-'));
  const tokens = new Map<UserRole, string>(); const ids = new Map<UserRole, string>();
  let server: Server; let base = '';
  const call = (role: UserRole, p: string, method = 'POST', body: unknown = {}) => fetch(`${base}${p}`, {
    method, headers: { authorization: `Bearer ${tokens.get(role)}`, 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  const auditUser = (action: string, resource: string) =>
    (db.prepare('SELECT user_id FROM audit_events WHERE action = ? AND resource_id = ?').get(action, resource) as { user_id: string } | undefined)?.user_id;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'decision-audit-test-secret-'.repeat(3); process.env.OKF_BASE = okf;
    db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF');
    const authService = new AuthService(db);
    for (const role of Object.values(UserRole)) {
      const user = authService.createUser(`${role}@audit.test`, 'Audit-test-only-password-123!', role);
      tokens.set(role, authService.generateToken(user)); ids.set(role, user.id);
    }
    const maker = ids.get(UserRole.MAKER);
    db.prepare(`INSERT INTO tasks (id,title,description,status,priority,risk_level,execution_mode,owner_user_id,created_by)
      VALUES ('t-1','Review','x','awaiting_approval','low','high','local',?,?)`).run(maker, maker);
    const exp = new Date(Date.now() + 600_000).toISOString();
    for (const id of ['ap-1', 'ap-2', 'ap-3']) {
      db.prepare(`INSERT INTO approvals (id,task_id,status,risk_level,request_type,request_message,request_data,requested_by,expires_at)
        VALUES (?,'t-1','pending','high','high_risk_action','Review','{}',?,?)`).run(id, maker, exp);
    }
    db.prepare(`INSERT INTO telegram_identities (telegram_user_id, user_id, added_by) VALUES ('5181', ?, 'test')`).run(ids.get(UserRole.ADMIN));
    const auth = createAuthMiddleware(authService);
    const approvals = new ApprovalService(db, { broadcastTaskEventById: () => {} }, new AuditService(db));
    const engine = { handleApprovalDecision: async (id: string, ok: boolean, actor: string, reason?: string) => approvals.decideApproval(id, ok, actor, reason) } as never;
    const app = express();
    app.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false }));
    app.use(express.json());
    app.use('/approvals', auth.requireAuth, createApprovalRoutes(db, engine, auth));
    app.use('/self-improve', auth.requireAuth, createSelfImprovementRoutes(db, auth));
    app.use('/swarms', auth.requireAuth, createGovernanceRoutes(db, auth));
    app.use('/fleet-hosts', auth.requireAuth, createFleetHostRoutes(db, auth));
    app.use(errorHandler);
    server = await new Promise((resolve) => { const l = app.listen(0, () => resolve(l)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    db.close(); fs.rmSync(okf, { recursive: true, force: true });
    if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
    if (originalOkf === undefined) delete process.env.OKF_BASE; else process.env.OKF_BASE = originalOkf;
  });

  it('F1: the approval audit event names the approver, not system', async () => {
    expect((await call(UserRole.APPROVER, '/approvals/ap-1/approve', 'POST', { reason: 'ok' })).status).toBe(200);
    expect(auditUser('approval_granted', 'ap-1')).toBe(ids.get(UserRole.APPROVER));
  });

  // F3 was a false positive: decideApproval already rejects a non-boolean (INVALID_APPROVAL_DECISION → 400); kept as a guard
  it("F3: PATCH with approved: 'false' (a string) is rejected and approves nothing", async () => {
    expect((await call(UserRole.APPROVER, '/approvals/ap-2', 'PATCH', { approved: 'false' })).status).toBe(400);
    expect(db.prepare("SELECT status FROM approvals WHERE id = 'ap-2'").get()).toEqual({ status: 'pending' });
    expect((await call(UserRole.APPROVER, '/approvals/ap-2', 'PATCH', { approved: false, reason: 'no' })).status).toBe(200);
    expect(db.prepare("SELECT status FROM approvals WHERE id = 'ap-2'").get()).toEqual({ status: 'denied' });
  });

  it('F4: cancelling an approval writes an audit event with the actor', async () => {
    expect((await call(UserRole.APPROVER, '/approvals/ap-3/cancel')).status).toBe(200);
    expect(auditUser('approval_cancelled', 'ap-3')).toBe(ids.get(UserRole.APPROVER));
  });

  it('F5: memory promote and reject are audited with the session user; promoted_by is the session user', async () => {
    const mem = new MemoryCandidateService(db);
    const op = mem.create({ title: 'op', content: 'Retry the gym claim once on a socket reset.', memory_type: 'operational_memory', source_ref: 'test' } as never);
    const rule = mem.create({ title: 'rule', content: 'Guard JSON.parse on model output.', memory_type: 'engineering_rule', source_ref: 'test' } as never);
    const approver = ids.get(UserRole.APPROVER);
    expect((await call(UserRole.APPROVER, `/swarms/memory/candidates/${op.id}/promote`, 'POST', {})).status).toBe(200);
    expect(JSON.parse((db.prepare('SELECT metadata FROM memory_candidates WHERE id = ?').get(op.id) as { metadata: string }).metadata).promoted_by).toBe(approver);
    expect(auditUser('memory_candidate_promoted', op.id)).toBe(approver);
    // the session actor never satisfies the review gate on its own: a review_required rule still needs human_approved
    expect((await call(UserRole.APPROVER, `/swarms/memory/candidates/${rule.id}/promote`, 'POST', {})).status).not.toBe(200);
    expect(db.prepare('SELECT status FROM memory_candidates WHERE id = ?').get(rule.id)).toEqual({ status: 'review_required' });
    expect((await call(UserRole.APPROVER, `/swarms/memory/candidates/${rule.id}/reject`, 'POST', { reason: 'dup' })).status).toBe(200);
    expect(auditUser('memory_candidate_rejected', rule.id)).toBe(approver);
  });

  it('F2: a self-approved root command is allowed but explicit in the audit trail and on /fleet', async () => {
    const admin = ids.get(UserRole.ADMIN)!;
    const c = new FleetCommands(db).request('workstation', 'id -u', admin);
    expect((await call(UserRole.ADMIN, `/fleet-hosts/commands/${c.id}/approve`, 'POST', { sha256: c.command_sha256 })).status).toBe(200);
    const row = db.prepare("SELECT user_id, metadata FROM audit_events WHERE action = 'fleet_command_approved' AND resource_id = ?").get(c.id) as { user_id: string; metadata: string };
    expect(row.user_id).toBe(admin);
    expect(JSON.parse(row.metadata).self_approved).toBe(true);
    const list = await (await call(UserRole.ADMIN, '/fleet-hosts', 'GET')).json() as { commands: Array<{ id: string; self_approved: number }> };
    expect(list.commands.find((x) => x.id === c.id)?.self_approved).toBe(1);
  });

  it('F6: viewers see Telegram ids but not the email/role behind them; admins see both', async () => {
    const viewer = await (await call(UserRole.VIEWER, '/self-improve/decisions', 'GET')).json() as { telegram: Array<Record<string, unknown>> };
    expect(viewer.telegram).toEqual([expect.objectContaining({ telegram_user_id: '5181', email: null, role: null })]);
    const admin = await (await call(UserRole.ADMIN, '/self-improve/decisions', 'GET')).json() as { telegram: Array<Record<string, unknown>> };
    expect(admin.telegram[0]).toMatchObject({ telegram_user_id: '5181', email: `${UserRole.ADMIN}@audit.test` });
  });
});
