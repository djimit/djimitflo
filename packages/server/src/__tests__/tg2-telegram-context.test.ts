import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { approvalContext, approvalMessage, pushApproval, setPushSender } from '../services/operator-push';
import { telegramConfigStatus } from '../routes/telegram';
import { SECRET_PATTERNS } from '../services/secret-patterns';

let db: Database.Database;
const sent: Array<{ id: string; text: string }> = [];
const sender = { requestApproval: vi.fn(async (id: string, text: string) => { sent.push({ id, text }); }), broadcastAlert: vi.fn(async () => {}) };
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); sent.length = 0; setPushSender(sender); });
afterEach(() => { setPushSender(null); db.close(); });

const ENV = {
  TELEGRAM_BOT_TOKEN: 'secret-token', TELEGRAM_ALLOWED_USERS: '111', TELEGRAM_WEBHOOK_URL: 'https://example.test/api/telegram/webhook',
  TELEGRAM_WEBHOOK_SECRET: 'webhook-secret', TELEGRAM_USER_MAP: '{"111":"u-111"}',
};
const user = (id: string, role: string, active = 1) => db.prepare("INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, 'x', ?, ?, datetime('now'), datetime('now'))").run(id, `${id}@example.test`, role, active);

it('TG-2: status is not ready while only TELEGRAM_USER_MAP is set — buttons are authorised by the D3 table', () => {
  user('u-111', 'admin');
  const s = telegramConfigStatus(ENV, true, db);
  expect(s).toMatchObject({ ready: false, approver_identity_count: 0 });
  expect(s.blocking.join(' ')).toContain('telegram_identities');
  expect(JSON.stringify(s)).not.toContain('secret-token');
});

it('TG-2: status is ready with a D3 row for an active user holding approve:task; a viewer or inactive user does not count', () => {
  user('u-111', 'admin'); user('u-222', 'viewer'); user('u-333', 'admin', 0);
  const row = db.prepare("INSERT INTO telegram_identities (telegram_user_id, user_id, added_by, created_at) VALUES (?, ?, 'test', datetime('now'))");
  row.run('222', 'u-222'); row.run('333', 'u-333');
  expect(telegramConfigStatus(ENV, true, db)).toMatchObject({ ready: false, approver_identity_count: 0 });
  row.run('111', 'u-111');
  expect(telegramConfigStatus(ENV, true, db)).toMatchObject({ ready: true, approver_identity_count: 1, blocking: [] });
});

function seedChain() {
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, grounding_json, created_at, updated_at)
    VALUES ('p1', 'feature', 'Raise the mutation score of services/runtime-health.ts', 'd', 'r', 'gap_analysis', 'executing', ?, datetime('now'), datetime('now'))`)
    .run(JSON.stringify({ target: 'packages/server/src/services/runtime-health.ts', artifactPath: 'packages/server/src/__tests__/runtime-health.test.ts' }));
  db.prepare("INSERT INTO goals (id, improvement_id, objective, risk_class, status) VALUES ('g1', 'p1', 't', 'low', 'running')").run();
  db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES ('run-1234abcd', 'g1', 'doc-drift-and-small-fix-loop', 'closed', 'running', ?, '{}', '[]', '[]', '{}', datetime('now'), datetime('now'))`)
    .run(JSON.stringify([{ id: 'f1', file: 'packages/server/src/__tests__/runtime-health.test.ts', message: 'Raise the mutation score' }]));
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, metadata, created_at, updated_at) VALUES ('lease-1', 'run-1234abcd', 'maker', 'remote', 'prepared', 'f1', '{}', datetime('now'), datetime('now'))").run();
  return {
    id: 'ap-1', title: 'Approval required before task execution', risk_level: 'high', action_type: 'task_execution', expires_at: '2026-10-06T22:41:38Z',
    task_id: 'loop-worker-lease-1-ab12cd34',
    request_data: JSON.stringify({ assessment: { matched_rules: ['sensitive-keywords'], explanation: 'Task description contains sensitive keywords. token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' } }),
    metadata: {},
  };
}

it('TG-2: the push carries lane, proposal, file, run and why it is high risk — redacted, under 1 000 chars', () => {
  const a = seedChain();
  const ctx = approvalContext(db, a);
  expect(ctx).toMatchObject({ lane: 'doc-drift-and-small-fix-loop', proposal: 'Raise the mutation score of services/runtime-health.ts', run_id: 'run-1234abcd', role: 'maker' });
  const text = approvalMessage(a, ctx);
  expect(text).toContain('Proposal: Raise the mutation score of services/runtime-health.ts');
  expect(text).toContain('Lane: doc-drift-and-small-fix-loop');
  expect(text).toContain('File: packages/server/src/__tests__/runtime-health.test.ts');
  expect(text).toContain('Run: run-1234');
  expect(text).toContain('Why high risk: sensitive-keywords');
  expect(text.length).toBeLessThanOrEqual(1000);
  for (const { pattern } of SECRET_PATTERNS) { pattern.lastIndex = 0; expect(pattern.test(text)).toBe(false); }
});

it('TG-2: an unlinked approval falls back to the plain message', () => {
  const plain = { id: 'ap-2', title: 'Approval required before task execution', risk_level: 'high', action_type: 'task_execution', task_id: 'unknown-task', metadata: {} };
  expect(approvalContext(db, plain)).toBeNull();
  expect(approvalMessage(plain, null)).toBe(approvalMessage(plain));
});

it('TG-2: an approval that was already decided (e.g. auto-approved) is not pushed', async () => {
  db.prepare(`INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, requested_by, expires_at, metadata) VALUES ('ap-3', 't', 'approved', 'high', 'high_risk_action', 'm', '{}', 'system', '2026-10-07T00:00:00Z', '{}')`).run();
  db.prepare(`INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, requested_by, expires_at, metadata) VALUES ('ap-4', 't', 'pending', 'high', 'high_risk_action', 'm', '{}', 'system', '2026-10-07T00:00:00Z', '{}')`).run();
  const env = { TELEGRAM_PUSH_ENABLED: 'true' };
  expect(await pushApproval(db, { id: 'ap-3', title: 'x' }, env, new Date('2026-10-06T12:00:00Z'))).toBe('decided');
  expect(await pushApproval(db, { id: 'ap-4', title: 'x' }, env, new Date('2026-10-06T12:00:00Z'))).toBe('sent');
  expect(sent.map((s) => s.id)).toEqual(['ap-4']);
});
