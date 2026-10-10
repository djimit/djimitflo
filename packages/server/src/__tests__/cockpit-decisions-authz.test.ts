import express from 'express';
import Database from 'better-sqlite3';
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
import { createHealthRoutes } from '../routes/health';

/**
 * Cockpit 3.0 adversarial scenario 9: a low-privilege user attempts an operator decision → 403 and nothing is written;
 * the authorized path writes an attributable record. Auth behaviour is NOT changed here; known gaps are `it.fails`.
 */
describe('cockpit + decisions route permissions (scenario 9)', () => {
  const db = new Database(':memory:');
  const originalSecret = process.env.JWT_SECRET;
  const tokens = new Map<UserRole, string>();
  const ids = new Map<UserRole, string>();
  let server: Server; let base: string; let memoryId = ''; let fleetId = ''; let fleetSha = '';
  const LOW = [UserRole.VIEWER, UserRole.AUDITOR, UserRole.CHECKER, UserRole.MAKER];
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const call = (role: UserRole, path: string, method = 'POST', body: unknown = {}) => fetch(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${tokens.get(role)}`, 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });

  beforeAll(async () => {
    process.env.JWT_SECRET = 'cockpit-authz-test-secret-'.repeat(3);
    db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF');
    const authService = new AuthService(db);
    for (const role of Object.values(UserRole)) {
      const user = authService.createUser(`${role}@authz.test`, 'Authz-test-only-password-123!', role);
      tokens.set(role, authService.generateToken(user)); ids.set(role, user.id);
    }
    const t = new Date(Date.now() - 3_600_000).toISOString();
    const proposal = db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at)
      VALUES (?, 'test', ?, 'd', 'r', 'gap_analysis', ?, '["test-gap:x"]', ?, ?)`);
    proposal.run('reg-1', 'regressed one', 'regressed', t, t);
    proposal.run('nme-1', 'parked one', 'needs_more_evidence', t, t);
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
      VALUES ('ps-1', 'proposal_prescreen', 'self_improvement', 'nme-1', 'h', 'shadow', 'no', 'vague', ?)`).run(t);
    db.prepare(`INSERT INTO tasks (id,title,description,status,priority,risk_level,execution_mode,owner_user_id,created_by)
      VALUES ('t-1','Review','x','awaiting_approval','low','high','local',?,?)`).run(ids.get(UserRole.MAKER), ids.get(UserRole.MAKER));
    db.prepare(`INSERT INTO approvals (id,task_id,status,risk_level,request_type,request_message,request_data,requested_by,expires_at)
      VALUES ('ap-1','t-1','pending','high','high_risk_action','Review','{}',?,?)`).run(ids.get(UserRole.MAKER), new Date(Date.now() + 600_000).toISOString());
    memoryId = new MemoryCandidateService(db).create({ title: 'rule', content: 'Guard JSON.parse on model output.', memory_type: 'engineering_rule', source_ref: 'test' } as never).id;
    const fc = new FleetCommands(db).request('workstation', 'uptime -p && id -u', ids.get(UserRole.ADMIN)!);
    fleetId = fc.id; fleetSha = fc.command_sha256;

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
    app.use('/health', createHealthRoutes(db, auth));
    app.use(errorHandler);
    server = await new Promise((resolve) => { const l = app.listen(0, () => resolve(l)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    db.close();
    if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
  });

  it('low-privilege roles get 403 on every decision endpoint and nothing is written', async () => {
    const judgments = count('SELECT COUNT(*) AS n FROM judgments');
    const proposals = count('SELECT COUNT(*) AS n FROM self_improvements');
    const audits = count('SELECT COUNT(*) AS n FROM audit_events');
    const decisions: Array<[string, string, unknown]> = [
      ['/self-improve/proposals/reg-1/requeue', 'POST', { reason: 'x' }],
      ['/self-improve/proposals/reg-1/requeue-dismiss', 'POST', { reason: 'x' }],
      ['/self-improve/proposals/nme-1/prescreen-label', 'POST', { label: 'wrong' }],
      ['/self-improve/proposals/nme-1/approve', 'POST', {}],
      ['/self-improve/attribution-audit/any-run', 'POST', { verdict: 'correct' }],
      ['/self-improve/telegram-identities/123', 'PUT', { user_id: 'x' }],
      ['/self-improve/telegram-identities/123', 'DELETE', {}],
      [`/swarms/memory/candidates/${memoryId}/promote`, 'POST', { human_approved: true }],
      [`/swarms/memory/candidates/${memoryId}/reject`, 'POST', { reason: 'x' }],
      ['/approvals/ap-1/approve', 'POST', {}],
      ['/approvals/ap-1/deny', 'POST', { reason: 'x' }],
      ['/approvals/ap-1', 'PATCH', { approved: true }],
      ['/approvals/ap-1/cancel', 'POST', {}],
      [`/fleet-hosts/commands/${fleetId}/approve`, 'POST', { sha256: fleetSha }],
      [`/fleet-hosts/commands/${fleetId}/deny`, 'POST', {}],
      ['/fleet-hosts/commands', 'POST', { host: 'workstation', command: 'rm -rf /' }],
    ];
    for (const role of LOW) {
      for (const [path, method, body] of decisions) expect((await call(role, path, method, body)).status, `${role} ${method} ${path}`).toBe(403);
    }
    // the operator-only reads stay closed too
    for (const role of LOW) {
      expect((await call(role, '/health/evolution-evidence', 'GET')).status, role).toBe(403);
      expect((await call(role, '/health/schedulers', 'GET')).status, role).toBe(403);
      expect((await call(role, '/health/config', 'GET')).status, role).toBe(403);
    }
    expect(count('SELECT COUNT(*) AS n FROM judgments')).toBe(judgments);
    expect(count('SELECT COUNT(*) AS n FROM self_improvements')).toBe(proposals);
    expect(count('SELECT COUNT(*) AS n FROM audit_events')).toBe(audits);
    expect(db.prepare("SELECT status FROM approvals WHERE id = 'ap-1'").get()).toEqual({ status: 'pending' });
    expect(db.prepare('SELECT status FROM memory_candidates WHERE id = ?').get(memoryId)).toEqual({ status: 'review_required' });
    expect(db.prepare('SELECT status FROM fleet_commands WHERE id = ?').get(fleetId)).toEqual({ status: 'pending_approval' });
    expect(count("SELECT COUNT(*) AS n FROM fleet_commands")).toBe(1);
  });

  it('unauthenticated callers get 401 on the cockpit reads and decisions', async () => {
    for (const path of ['/health/cockpit', '/health/stalls', '/health/attribution', '/health/efficiency', '/health/knowledge', '/self-improve/decisions']) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(401);
    }
  });

  it('a viewer can read the cockpit, stalls and decisions inbox (read:evidence) without writing', async () => {
    const before = count('SELECT COUNT(*) AS n FROM judgments') + count('SELECT COUNT(*) AS n FROM audit_events');
    for (const path of ['/health/cockpit', '/health/stalls', '/self-improve/decisions']) expect((await call(UserRole.VIEWER, path, 'GET')).status, path).toBe(200);
    expect(count('SELECT COUNT(*) AS n FROM judgments') + count('SELECT COUNT(*) AS n FROM audit_events')).toBe(before);
  });

  it('the authorized paths record the session actor, not a body-supplied one', async () => {
    const admin = ids.get(UserRole.ADMIN)!;
    expect((await call(UserRole.ADMIN, '/self-improve/proposals/nme-1/prescreen-label', 'POST', { label: 'ok', actor: 'spoofed' })).status).toBe(204);
    expect((db.prepare("SELECT reason FROM judgments WHERE judgment = 'operator_label' AND subject_id = 'nme-1'").get() as { reason: string }).reason)
      .toBe(`proposal_prescreen rejection labelled 'ok' by ${admin}`);
    expect((await call(UserRole.ADMIN, '/self-improve/proposals/reg-1/requeue-dismiss', 'POST', { reason: 'known flake', actor: 'spoofed' })).status).toBe(204);
    expect((db.prepare("SELECT reason FROM judgments WHERE judgment = 'requeue_dismiss' AND subject_id = 'reg-1'").get() as { reason: string }).reason)
      .toContain(`dismissed by ${admin}`);
    expect((await call(UserRole.APPROVER, `/swarms/memory/candidates/${memoryId}/reject`, 'POST', { reason: 'dup', rejected_by: 'spoofed' })).status).toBe(200);
    const meta = JSON.parse((db.prepare('SELECT metadata FROM memory_candidates WHERE id = ?').get(memoryId) as { metadata: string }).metadata);
    expect(meta.rejected_by).toBe(ids.get(UserRole.APPROVER));
    expect((await call(UserRole.APPROVER, '/approvals/ap-1/approve', 'POST', { reason: 'ok', decided_by: 'spoofed' })).status).toBe(200);
    expect(db.prepare("SELECT status, decided_by FROM approvals WHERE id = 'ap-1'").get()).toEqual({ status: 'approved', decided_by: ids.get(UserRole.APPROVER) });
    expect(count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'approval_granted' AND resource_id = 'ap-1'")).toBe(1);
  });

  // GAP (operator decision, auth = ask-first): the approval_granted/denied audit_events row names 'system', not the approver —
  // approval-service.ts decideApproval → auditService.record() passes no user_id. The approver is only in approvals.decided_by
  // (a mutable row), so the hash-chained audit trail cannot attribute a human approval.
  it.fails('GAP: the approval audit event names the approver', () => {
    expect(db.prepare("SELECT user_id FROM audit_events WHERE action = 'approval_granted' AND resource_id = 'ap-1'").get())
      .toEqual({ user_id: ids.get(UserRole.APPROVER) });
  });

  // GAP: fleet root shell has no separation of duties — the admin who requested the command can approve it himself
  // (fleet-commands.ts approve() never compares approver with requested_by; approvals.ts has SELF_APPROVAL_FORBIDDEN).
  it.fails('GAP: the requester of a root shell command cannot approve it', async () => {
    expect((await call(UserRole.ADMIN, `/fleet-hosts/commands/${fleetId}/approve`, 'POST', { sha256: fleetSha })).status).toBe(403);
  });
});
