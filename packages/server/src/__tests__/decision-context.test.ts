import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { resetTypesafeBreaker } from '../services/typesafe-client';
import { buildDecisionContext, prefilterMemories } from '../services/decision-context-service';

let db: Database.Database;
const memory = (id: string, title: string, content: string, sensitivity = 'normal', status = 'promoted') =>
  db.prepare(`INSERT INTO memory_candidates (id, title, content, memory_type, status, promotion_status, sensitivity)
    VALUES (?, ?, ?, 'engineering_rule', ?, 'promoted', ?)`).run(id, title, content, status, sensitivity);
const reply = (answers: Record<string, number>) => vi.fn().mockResolvedValue({ ok: true, status: 200,
  json: async () => ({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(answers).map(([k, p]) => [k, { type: 'noul', noul: p }])) }) });
const decision = { topic: 'Add unit tests for services/secret-patterns.ts', context: { description: 'test-only change to secret-patterns redaction' } };

beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); process.env.TYPESAFE_API_KEY = 'k'; resetTypesafeBreaker();
  memory('m-rel', 'Test-only changes to secret-patterns', 'A new test file for secret-patterns redaction was accepted when it covered every pattern category.');
  memory('m-other', 'Dashboard theme tokens', 'Use theme tokens for colors in the dashboard.');
  memory('m-secret', 'secret-patterns internals', 'secret-patterns redaction keys', 'security_sensitive');
  memory('m-cand', 'secret-patterns test idea', 'secret-patterns redaction test', 'normal', 'candidate');
});
afterEach(() => { delete process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_DECISION_CONTEXT_MODE; vi.unstubAllGlobals(); db.close(); });

it('prefilter keeps only promoted, non-sensitive memories that share words with the decision', () => {
  expect(prefilterMemories(db, JSON.stringify(decision)).map((m) => m.id)).toEqual(['m-rel']);
});

it('off: no TypeSafe call, no context', async () => {
  const f = reply({ m0: 0.9 }); vi.stubGlobal('fetch', f);
  expect(await buildDecisionContext(db, { type: 'specialist_panel', id: 'p1' }, decision)).toBeNull();
  expect(f).not.toHaveBeenCalled();
});

it('shadow: records the selection, injects nothing', async () => {
  process.env.TYPESAFE_DECISION_CONTEXT_MODE = 'shadow'; vi.stubGlobal('fetch', reply({ m0: 0.9 }));
  expect(await buildDecisionContext(db, { type: 'specialist_panel', id: 'p1' }, decision)).toBeNull();
  expect(db.prepare("SELECT decision, reason FROM judgments WHERE judgment = 'decision_context'").get()).toEqual({ decision: 'yes', reason: 'selected=m0' });
});

it('enforce: injects only memories the model judged relevant, with provenance', async () => {
  process.env.TYPESAFE_DECISION_CONTEXT_MODE = 'enforce';
  vi.stubGlobal('fetch', reply({ m0: 0.9 }));
  const ctx = await buildDecisionContext(db, { type: 'specialist_panel', id: 'p1' }, decision);
  expect(ctx?.memoryIds).toEqual(['m-rel']);
  expect(ctx?.text).toContain('[memory:m-rel]');
  vi.stubGlobal('fetch', reply({ m0: 0.2 }));
  expect(await buildDecisionContext(db, { type: 'specialist_panel', id: 'p2' }, decision)).toBeNull();
});

it('fail-open: an API error yields no context', async () => {
  process.env.TYPESAFE_DECISION_CONTEXT_MODE = 'enforce';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
  expect(await buildDecisionContext(db, { type: 'specialist_panel', id: 'p1' }, decision)).toBeNull();
}, 20_000);

it('the specialist panel prompt carries the advisory lessons only in enforce mode', async () => {
  const { SpecialistPanelService } = await import('../services/specialist-panel-service');
  const { SelfImprovementAgentReviewService } = await import('../services/self-improvement-agent-review-service');
  const review = '{"stance":"support","confidence":0.9,"findings":["ok"],"recommendations":[],"evidence_refs":["description"]}';
  const run = async () => {
    const panel = new SpecialistPanelService(db).createPanel({ topic: decision.topic, question: 'Authorize?', risk_class: 'low',
      specialist_ids: ['systems_architect', 'runtime_engineer'], metadata: {}, context: decision.context });
    const prompts: string[] = [];
    await new SelfImprovementAgentReviewService(db, async (p: string) => { prompts.push(p); return review; }).reviewMissingSpecialists(panel.id, 'r');
    return prompts.join('\n');
  };
  vi.stubGlobal('fetch', reply({ m0: 0.9 }));
  expect(await run()).not.toContain('[memory:m-rel]');
  process.env.TYPESAFE_DECISION_CONTEXT_MODE = 'enforce';
  expect(await run()).toContain('[memory:m-rel]');
});
