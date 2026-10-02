import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { TypeSafeClient, resetTypesafeBreaker } from '../services/typesafe-client';
import { runJudgment } from '../services/judgment-service';
import { riskAtomic, riskAtomicState } from '../services/judgments/risk-atomic';
import { recordAutoApproveShadow } from '../services/autonomy-shadow-service';

let db: Database.Database;
const noul = (vals: Record<string, number>) => Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, { type: 'noul', noul: v }]));
const client = (answers: unknown, sent: unknown[] = []) => new TypeSafeClient(vi.fn().mockImplementation(async (_u, init) => {
  sent.push(JSON.parse(String(init.body)));
  return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers }) };
}) as unknown as typeof fetch);
const low = { changes_auth: 0.05, handles_secrets: 0.05, changes_deploy: 0.05, weakens_controls: 0.05 };

beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); process.env.TYPESAFE_API_KEY = 'k'; process.env.TYPESAFE_RISK_ATOMIC_MODE = 'shadow'; resetTypesafeBreaker(); });
afterEach(() => { delete process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_RISK_ATOMIC_MODE; delete process.env.AUTONOMY_SHADOW_ENABLED; db.close(); vi.restoreAllMocks(); });

it('S1: a test-only task whose file name sounds risky is low for jev while the keyword class says high', async () => {
  const s = riskAtomicState({ title: 'Test untested exports of services/approval-inheritance.ts', description: 'Add a test file. Test-only; no production code edits.', target: 'packages/server/src/services/approval-inheritance.ts' });
  const r = await runJudgment(db, riskAtomic, { type: 'approval', id: 'a1' }, s, client(noul(low)), { testOnly: true, keywordRisk: 'high' });
  expect(r).toMatchObject({ decision: 'no', reason: 'jev=low keyword=high test_only' });
});

it('S1: any control-touching answer makes it high; an unclear one stays uncertain', async () => {
  const s = riskAtomicState({ title: 't', description: 'Rotate the deploy token and change auth middleware.' });
  expect(await runJudgment(db, riskAtomic, { type: 'approval', id: 'a2' }, s, client(noul({ ...low, changes_auth: 0.9, handles_secrets: 0.85 })), { testOnly: false, keywordRisk: 'high' }))
    .toMatchObject({ decision: 'yes', reason: 'jev=high keyword=high yes=changes_auth,handles_secrets' });
  expect(await runJudgment(db, riskAtomic, { type: 'approval', id: 'a3' }, s, client(noul({ ...low, weakens_controls: 0.5 })), { testOnly: false, keywordRisk: 'low' }))
    .toMatchObject({ decision: 'uncertain', reason: 'jev=uncertain keyword=low unsure=weakens_controls' });
});

it('S1: the approval-wait shadow runs it next to rule-v1, with the target and the code-checked test-only fact', async () => {
  process.env.AUTONOMY_SHADOW_ENABLED = 'true';
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, grounding_json, evidence_refs_json, created_at, updated_at)
    VALUES ('p', 'feature', 'Add unit tests for services/x.ts', 'Test-only; no production code edits.', 'r', 'gap_analysis', 'executing', 0.6, ?, '["test-gap:x"]', datetime('now'), datetime('now'))`)
    .run(JSON.stringify({ target: 'packages/server/src/services/x.ts', artifactPath: 'packages/server/src/__tests__/x.test.ts' }));
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id) VALUES ('g', 'o', 'high', 'running', '{}', 'p')").run();
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: noul(low) }) } as unknown as Response);
  recordAutoApproveShadow(db, 'g', 'run', 'appr');
  await vi.waitFor(() => expect(db.prepare("SELECT reason FROM judgments WHERE judgment = 'risk_atomic'").get()).toEqual({ reason: 'jev=low keyword=high test_only' }));
  const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
  expect(body.state.task.target).toBe('packages/server/src/services/x.ts');
  expect(Object.keys(body.questions).sort()).toEqual(['changes_auth', 'changes_deploy', 'handles_secrets', 'weakens_controls']);
});
