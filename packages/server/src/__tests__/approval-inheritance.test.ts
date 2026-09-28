import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { inheritableApproval } from '../services/approval-inheritance';

let db: Database.Database;
const NOW = Date.parse('2026-09-28T18:00:00Z');
const ON = { APPROVAL_INHERIT_ENABLED: 'true' };
const approval = (id: string, task: string, o: { status?: string; risk?: string; hash?: string; kind?: string; by?: string | null; at?: string } = {}) =>
  db.prepare(`INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, decided_by, decided_at, metadata)
    VALUES (?, ?, ?, ?, 'high_risk_action', 'm', ?, ?, ?, ?)`).run(id, task, o.status ?? 'approved', o.risk ?? 'high',
    JSON.stringify({ assessment: { metadata: { executorKind: o.kind ?? 'opencode', executionMode: 'local', workspacePath: '/app' } } }),
    o.by === undefined ? 'operator-uuid' : o.by, o.at ?? '2026-09-28T17:30:00Z', JSON.stringify({ executionInputHash: o.hash ?? 'h1' }));
const lease = (id: string, run: string, task: string) =>
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'opencode', 'prepared', ?, '', '')`)
    .run(id, run, JSON.stringify({ execution_task_id: task }));
beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF');
  lease('first', 'run', 't1'); lease('retry', 'run', 't2');
  approval('human', 't1');
});
afterEach(() => db.close());
const pending = (o: Parameters<typeof approval>[2] = {}) => { approval('p', 't2', { status: 'pending', by: null, ...o }); return inheritableApproval(db, 'p', 'run', NOW, ON); };

it('inherits when action, risk, scope, target and freshness all hold', () => {
  expect(pending()?.originalId).toBe('human');
});
it('is off by default', () => { approval('p', 't2', { status: 'pending', by: null }); expect(inheritableApproval(db, 'p', 'run', NOW, {})).toBeNull(); });
it('refuses a different action hash', () => expect(pending({ hash: 'h2' })).toBeNull());
it('refuses a higher risk level', () => expect(pending({ risk: 'critical' })).toBeNull());
it('accepts a lower risk level', () => expect(pending({ risk: 'medium' })?.originalId).toBe('human'));
it('refuses a different target environment', () => expect(pending({ kind: 'atomic' })).toBeNull());
it('refuses another run (scope)', () => {
  lease('other', 'run2', 't3'); approval('p', 't3', { status: 'pending', by: null });
  expect(inheritableApproval(db, 'p', 'run2', NOW, ON)).toBeNull();
});
it('refuses a stale approval (TTL 2 h by default)', () => {
  db.prepare("UPDATE approvals SET decided_at = '2026-09-28T15:00:00Z' WHERE id = 'human'").run();
  expect(pending()).toBeNull();
});
it('never treats automated or inherited decisions as the human approval', () => {
  db.prepare("UPDATE approvals SET decided_by = 'autonomy:test-gap-rule-v1' WHERE id = 'human'").run(); expect(pending()).toBeNull();
  db.prepare("DELETE FROM approvals WHERE id = 'p'").run();
  db.prepare("UPDATE approvals SET decided_by = 'inherit:x' WHERE id = 'human'").run(); expect(pending()).toBeNull();
});
