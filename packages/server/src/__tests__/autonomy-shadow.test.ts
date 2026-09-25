import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { recordAutoApproveShadow } from '../services/autonomy-shadow-service';
import { ImprovementFunnelService } from '../services/improvement-funnel-service';

let db: Database.Database;
const si = (id: string, status: string, source = 'gap_analysis', type = 'feature', grounding = '{"artifactPath":"packages/server/src/__tests__/x.test.ts"}') =>
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, grounding_json, created_at, updated_at)
    VALUES (?, ?, 't', 'Add a test. Test-only; no production code edits.', 'r', ?, ?, 0.6, ?, datetime('now'), datetime('now'))`).run(id, type, source, status, grounding);
const goal = (id: string, imp: string, risk = 'low') => db.prepare(`INSERT INTO goals (id, objective, status, risk_class, acceptance_criteria_json, budget_json, improvement_id, metadata, created_at, updated_at)
  VALUES (?, 'o', 'blocked', ?, '[]', '{}', ?, '{}', datetime('now'), datetime('now'))`).run(id, risk, imp);
const run = (id: string) => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, created_at, updated_at) VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', 'running', datetime('now'), datetime('now'))`).run(id);
const approval = (id: string, status: string) => db.prepare(`INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data) VALUES (?, 't', ?, 'medium', 'high_risk_action', 'm', '{}')`).run(id, status);

beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); process.env.AUTONOMY_SHADOW_ENABLED = 'true'; run('r1'); });
afterEach(() => { delete process.env.AUTONOMY_SHADOW_ENABLED; db.close(); });

it('says no until a test-only class has 3 verified outcomes and no regression; then yes; records once per approval', () => {
  si('cur', 'executing'); goal('g1', 'cur');
  expect(recordAutoApproveShadow(db, 'g1', 'r1', 'a1')).toMatchObject({ decision: 'no' });
  expect(recordAutoApproveShadow(db, 'g1', 'r1', 'a1')).toBeNull(); // once per approval
  for (const id of ['v1', 'v2', 'v3']) si(id, 'verified');
  expect(recordAutoApproveShadow(db, 'g1', 'r1', 'a2')?.decision).toBe('yes');
  si('reg', 'regressed');
  expect(recordAutoApproveShadow(db, 'g1', 'r1', 'a3')?.reason).toContain('1 regression(s) in class');
});

it('never yes for high risk, security or non-test changes; off by default', () => {
  for (const id of ['v1', 'v2', 'v3']) si(id, 'verified');
  si('hi', 'executing'); goal('g-hi', 'hi', 'high');
  expect(recordAutoApproveShadow(db, 'g-hi', 'r1', 'b1')?.reason).toContain('high risk');
  si('code', 'executing', 'gap_analysis', 'feature', '{"target":"packages/server/src/services/x.ts"}');
  db.prepare("UPDATE self_improvements SET description = 'Change production code.' WHERE id = 'code'").run(); goal('g-code', 'code');
  expect(recordAutoApproveShadow(db, 'g-code', 'r1', 'b2')?.reason).toContain('not test-only');
  delete process.env.AUTONOMY_SHADOW_ENABLED;
  expect(recordAutoApproveShadow(db, 'g-hi', 'r1', 'b3')).toBeNull();
});

it('the funnel measures agreement with the operator decision', () => {
  si('cur', 'executing'); goal('g1', 'cur');
  db.pragma('foreign_keys = OFF'); // the approval's task is irrelevant here
  approval('a1', 'approved'); recordAutoApproveShadow(db, 'g1', 'r1', 'a1'); // rule said no, operator approved
  const j = new ImprovementFunnelService(db).compute().judgments.find((x) => x.judgment === 'auto_approve_shadow');
  expect(j).toMatchObject({ total: 1, withOutcome: 1, agreement: 0 });
});
