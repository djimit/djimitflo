import express from 'express';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rateLimit } from 'express-rate-limit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ROLE_PERMISSIONS, UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { ApprovalService } from '../services/approval-service';
import { AuditService } from '../services/audit-service';
import { MemoryCandidateService } from '../services/memory-candidate-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { TelegramApiService } from '../services/telegram-api-service';
import { TelegramBotService } from '../services/telegram-bot-service';
import { ExecutionEngine } from '../execution/execution-engine';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { createApprovalRoutes } from '../routes/approvals';
import { createGovernanceRoutes } from '../routes/swarm-governance';
import { createSwarmIntelRoutes } from '../routes/swarm-intel';
import { createLoopRoutes } from '../routes/loops';

/**
 * Invariant: an agent or system identity can never resolve a human-required gate. "Human" = a role holding approve:task
 * (ADMIN, APPROVER); every other role is how agents, workers and service accounts authenticate. The existing tests
 * (#963-#968, cockpit-decisions-authz, telegram-api-chain, operator-push) cover single roles per path; this file
 * iterates every non-human role over every human gate, plus every machine `decided_by` over reviewer inheritance.
 */
const NON_HUMAN = Object.values(UserRole).filter((r) => !ROLE_PERMISSIONS[r].includes('approve:task'));
const MACHINE_DECIDERS = ['system', 'auto', 'autonomy:oracle-lane-v1', 'autonomy:test-gap-rule-v1', 'autonomy:gym-rule-v1', 'inherit:ap-original'];

it('the human set is exactly ADMIN and APPROVER; agent roles (incl. PLATFORM_ADMIN) are all non-human', () => {
  expect(Object.values(UserRole).filter((r) => !NON_HUMAN.includes(r)).sort()).toEqual([UserRole.ADMIN, UserRole.APPROVER].sort());
  expect(NON_HUMAN).toEqual(expect.arrayContaining([UserRole.PLATFORM_ADMIN, UserRole.MAKER, UserRole.CHECKER, UserRole.AUDITOR, UserRole.VIEWER]));
});

describe('HTTP and Telegram human gates refuse every non-human role', () => {
  const db = new Database(':memory:');
  const originalSecret = process.env.JWT_SECRET;
  const tokens = new Map<UserRole, string>(); const ids = new Map<UserRole, string>();
  let server: Server; let base = ''; let memoryId = ''; let root = '';
  const call = (role: UserRole, p: string, method = 'POST', body: unknown = {}) => fetch(`${base}${p}`, {
    method, headers: { authorization: `Bearer ${tokens.get(role)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    process.env.JWT_SECRET = 'human-gate-invariant-secret-'.repeat(3);
    db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'human-gate-'));
    const authService = new AuthService(db);
    for (const role of Object.values(UserRole)) {
      const user = authService.createUser(`${role}@gate.test`, 'Gate-test-only-password-123!', role);
      tokens.set(role, authService.generateToken(user)); ids.set(role, user.id);
    }
    db.prepare(`INSERT INTO tasks (id,title,description,status,priority,risk_level,execution_mode,owner_user_id,created_by)
      VALUES ('t-1','Review','x','awaiting_approval','low','high','local',?,?)`).run(ids.get(UserRole.ADMIN), ids.get(UserRole.ADMIN));
    db.prepare(`INSERT INTO approvals (id,task_id,status,risk_level,request_type,request_message,request_data,requested_by,expires_at)
      VALUES ('ap-1','t-1','pending','high','high_risk_action','Review','{}',?,?)`).run(ids.get(UserRole.ADMIN), new Date(Date.now() + 600_000).toISOString());
    memoryId = new MemoryCandidateService(db).create({ title: 'policy', content: 'Never auto-merge without a green check.', memory_type: 'policy_rule', source_ref: 'test' } as never).id;
    const caps = new SwarmIntelligenceService(db);
    for (const risk of ['high', 'critical'] as const) {
      caps.createCandidate({ id: `cap-${risk}`, kind: 'runtime_adapter', owner: 'test', version: '0.1.0', risk_ceiling: risk, input_schema_ref: 'none', output_schema_ref: 'none',
        allowed_actions: ['spawn_runtime_worker'], forbidden_actions: ['modify_secrets'], required_evidence: ['worker_lease'], eval_threshold: 0.8, removal_strategy: 'disable and review' });
    }
    db.prepare('INSERT INTO loop_runs(id,loop_name,mode,status,repository_path,findings_json,metadata) VALUES(?,?,?,?,?,?,?)')
      .run('run-1', 'doc-drift-and-small-fix-loop', 'closed', 'running', root, '[]', '{}');

    const auth = createAuthMiddleware(authService);
    const approvals = new ApprovalService(db, { broadcastTaskEventById: () => {} }, new AuditService(db));
    const engine = { handleApprovalDecision: async (id: string, ok: boolean, actor: string, reason?: string) => approvals.decideApproval(id, ok, actor, reason) } as never;
    const app = express();
    app.use(rateLimit({ windowMs: 60_000, limit: 2_000, standardHeaders: 'draft-8', legacyHeaders: false }));
    app.use(express.json());
    app.use('/approvals', auth.requireAuth, createApprovalRoutes(db, engine, auth));
    app.use('/swarms', auth.requireAuth, createGovernanceRoutes(db, auth));
    app.use('/swarms', auth.requireAuth, createSwarmIntelRoutes(db, auth));
    app.use('/loops', auth.requireAuth, createLoopRoutes(db, auth, path.join(root, 'evidence')));
    app.use(errorHandler);
    server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    db.close(); fs.rmSync(root, { recursive: true, force: true });
    if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
  });

  const unchanged = () => {
    expect(db.prepare("SELECT status FROM approvals WHERE id = 'ap-1'").get()).toEqual({ status: 'pending' });
    expect(db.prepare('SELECT status FROM memory_candidates WHERE id = ?').get(memoryId)).toEqual({ status: 'review_required' });
    for (const risk of ['high', 'critical']) expect(new SwarmIntelligenceService(db).getCapability(`cap-${risk}`)).toMatchObject({ status: 'candidate', live_route_allowed: false });
    expect(db.prepare("SELECT status FROM loop_runs WHERE id = 'run-1'").get()).toEqual({ status: 'running' });
  };

  it('approve/deny/PATCH approval, memory promotion, high/critical capability promotion, loop verdicts and completion', async () => {
    const gates: Array<[string, string, unknown]> = [
      ['/approvals/ap-1/approve', 'POST', {}],
      ['/approvals/ap-1/deny', 'POST', { reason: 'x' }],
      ['/approvals/ap-1', 'PATCH', { approved: true }],
      [`/swarms/memory/candidates/${memoryId}/promote`, 'POST', { human_approved: true }],
      ...['high', 'critical'].map((risk): [string, string, unknown] => [`/swarms/intelligence/capabilities/cap-${risk}/promote`, 'POST',
        { eval_score: 0.9, evidence_refs: ['eval:1'], security_checker_ref: 'checker:1', human_approval_ref: 'approval:yes' }]),
      ['/loops/runs/run-1/checker-verdict', 'POST', { verdict: 'approved', reviewer: 'operator' }],
      ['/loops/runs/run-1/security-verdict', 'POST', { verdict: 'approved', reviewer: 'operator' }],
      ['/loops/runs/run-1/complete', 'POST', { human_approval_ref: 'approval:yes' }],
    ];
    for (const role of NON_HUMAN) {
      for (const [p, method, body] of gates) {
        const res = await call(role, p, method, body);
        // 403 by permission; a write:capability holder reaches the gate and gets 409 HUMAN_APPROVAL_REQUIRED instead
        if (p.includes('/capabilities/')) expect([403, 409], `${role} ${p}`).toContain(res.status);
        else expect(res.status, `${role} ${method} ${p}`).toBe(403);
      }
    }
    unchanged();
  });

  it('Telegram /approve, /reject and ap/dn buttons from an allowlisted, mapped non-human user decide nothing', async () => {
    const api = new TelegramApiService(new AuthService(db), base);
    const bot = new TelegramBotService(db, api);
    const tg = new Map(NON_HUMAN.map((role, i) => [role, 7000 + i]));
    for (const [role, tgId] of tg) {
      db.prepare("INSERT OR IGNORE INTO telegram_identities (telegram_user_id,user_id,added_by,created_at) VALUES (?,?,'test-admin',datetime('now'))").run(tgId, ids.get(role));
    }
    bot.configure({ botToken: '123:disposable', allowedUsers: [...tg.values()], userMap: Object.fromEntries([...tg].map(([role, tgId]) => [String(tgId), ids.get(role)!])) } as never);
    const replies: string[] = [];
    const send = vi.spyOn(bot, 'sendMessage').mockImplementation(async (_chat: number, text: string) => { replies.push(text); });
    try {
      for (const [role, tgId] of tg) {
        for (const text of ['/approve ap-1', '/reject ap-1']) {
          await bot.handleWebhook({ message: { chat: { id: tgId }, from: { id: tgId }, text, message_id: 1 } });
          expect(replies.at(-1), `${role} ${text}`).toMatch(/FORBIDDEN|not authorized|Not allowed/);
        }
        for (const data of ['ap:ap-1', 'rs:ap-1:s']) {
          expect(await bot.handleCallback({ id: 'q', from: { id: tgId }, data, message: { chat: { id: tgId } } }), `${role} ${data}`).toBe('refused');
        }
      }
    } finally { send.mockRestore(); }
    unchanged();
  });
});

describe('reviewer inheritance never treats a machine decision as the human maker approval', () => {
  it.each(MACHINE_DECIDERS)('decided_by %s is not inheritable', (decidedBy) => {
    const db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const prev = process.env.LOOP_REVIEWER_APPROVAL_INHERIT;
    process.env.LOOP_REVIEWER_APPROVAL_INHERIT = 'true';
    try {
      for (const [id, role] of [['maker-1', 'maker'], ['checker-1', 'checker']]) {
        db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, tags, metadata, created_at, updated_at) VALUES (?, 't', 'd', 'awaiting_approval', 'low', 'medium', 'local', ?, ?, datetime('now'), datetime('now'))")
          .run(id, JSON.stringify(['loop-worker', role, 'opencode']), JSON.stringify({ loop_run_id: 'run-1', lease_id: `lease-${id}` }));
        db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, 'run-1', ?, 'opencode', 'prepared', ?, datetime('now'), datetime('now'))")
          .run(`lease-${id}`, role, JSON.stringify({ execution_task_id: id }));
      }
      db.prepare("INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, decided_by, expires_at, created_at, updated_at) VALUES ('a1', 'maker-1', 'approved', 'medium', 'high_risk_action', 'm', '{}', ?, ?, datetime('now'), datetime('now'))")
        .run(decidedBy, new Date(Date.now() + 3_600_000).toISOString());
      const engine = new ExecutionEngine(db) as unknown as { reviewerInheritsRunApproval(id: string): boolean };
      expect(engine.reviewerInheritsRunApproval('checker-1')).toBe(false);
      // control: the same approval decided by a person is inherited
      db.exec('DROP TRIGGER IF EXISTS approvals_no_update');
      db.prepare("UPDATE approvals SET decided_by = 'user-approver' WHERE id = 'a1'").run();
      expect(engine.reviewerInheritsRunApproval('checker-1')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LOOP_REVIEWER_APPROVAL_INHERIT; else process.env.LOOP_REVIEWER_APPROVAL_INHERIT = prev;
      log.mockRestore(); db.close();
    }
  });
});
