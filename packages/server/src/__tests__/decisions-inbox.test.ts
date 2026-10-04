import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { decisionsInbox, labelPrescreen, setTelegramIdentity } from '../services/decisions-inbox';
import { requeueImprovement } from '../services/improvement-requeue';

let db: Database.Database;
const NOW = Date.now();
const proposal = (id: string, status: string) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at)
  VALUES (?, 'test', ?, 'd', 'r', 'gap_analysis', ?, '["test-gap:x"]', ?, ?)`).run(id, `title ${id}`, status, new Date(NOW - 86_400_000).toISOString(), new Date(NOW - 3_600_000).toISOString());
const prescreen = (id: string, decision: string, at: string) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
  VALUES (?, 'proposal_prescreen', 'self_improvement', ?, 'h', 'shadow', ?, 'names no concrete file', ?)`).run(`${id}-${at}`, id, decision, at);
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); });
afterEach(() => db.close());

it('lists requeue candidates with their requeue link', () => {
  proposal('r1', 'regressed'); proposal('v1', 'verified');
  expect(decisionsInbox(db, NOW).requeue.map((r) => [r.id, r.requeued_as])).toEqual([['r1', null]]);
  const copy = requeueImprovement(db, 'r1', { actor: 'op', reason: 'deps fixed (#514)' }, { TEST_GAP_MAX_PER_DAY: '9' });
  expect(decisionsInbox(db, NOW).requeue.find((r) => r.id === 'r1')?.requeued_as).toBe(copy.id);
});

it('lists latest pre-screen rejections and computes the false-rejection rate from operator labels', () => {
  proposal('a', 'needs_more_evidence'); proposal('b', 'needs_more_evidence'); proposal('c', 'verified');
  prescreen('a', 'no', '2026-09-27T00:00:00Z'); prescreen('b', 'no', '2026-09-27T00:00:00Z');
  prescreen('c', 'no', '2026-09-26T00:00:00Z'); prescreen('c', 'yes', '2026-09-27T00:00:00Z'); // latest verdict is yes → not listed
  labelPrescreen(db, 'a', 'ok', 'op'); labelPrescreen(db, 'b', 'wrong', 'op');
  const p = decisionsInbox(db, NOW).prescreen;
  expect(p.items.map((i) => [i.id, i.label]).sort()).toEqual([['a', 'ok'], ['b', 'wrong']]);
  expect([p.labelled, p.wrong, p.false_rejection_pct]).toEqual([2, 1, 50]);
  expect(() => labelPrescreen(db, 'nope', 'ok', 'op')).toThrow('LABEL_NO_PRESCREEN_REJECTION');
});

it('manages the Telegram allowlist with validation and an audit trail', () => {
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES ('u1', 'op@x', 'h', 'approver')").run();
  expect(() => setTelegramIdentity(db, 'abc', 'u1', 'op')).toThrow('TELEGRAM_ID_INVALID');
  expect(() => setTelegramIdentity(db, '123', 'ghost', 'op')).toThrow('TELEGRAM_USER_NOT_FOUND');
  setTelegramIdentity(db, '123', 'u1', 'op');
  expect(decisionsInbox(db, NOW).telegram).toEqual([expect.objectContaining({ telegram_user_id: '123', user_id: 'u1', email: 'op@x', role: 'approver', added_by: 'op' })]);
  setTelegramIdentity(db, '123', null, 'op');
  expect(decisionsInbox(db, NOW).telegram).toEqual([]);
  expect(db.prepare("SELECT reason FROM judgments WHERE judgment = 'telegram_access' ORDER BY rowid").all()).toEqual([{ reason: 'allowlist set -> u1 by op' }, { reason: 'allowlist removed by op' }]);
});
