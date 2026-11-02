import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { recordModelCall, setLlmLedger } from '../services/model-selector';
import { recordMakerCall, ledgerTotals } from '../services/model-call-ledger';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { SelfImprovementAgentReviewService } from '../services/self-improvement-agent-review-service';
import { resetLlmBreaker } from '../services/llm-fallback';

let db: Database.Database;
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); setLlmLedger(null); resetLlmBreaker(); db?.close(); });
const fresh = () => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); return db; };
const REVIEW = JSON.stringify({ stance: 'support', confidence: 0.7, findings: ['f'], evidence_refs: ['context:rationale'] });

it('B29: a panel review call records the provider token counts on its own row, counted once (transport row carries none)', async () => {
  fresh(); setLlmLedger(db);
  for (const [k, v] of Object.entries({ MODEL_SELECTOR_MODE: 'shadow', MODEL_SELECTOR_SHADOW_RATE: '0', SELF_IMPROVEMENT_REVIEW_MODEL: 'kimi-k3:cloud', OLLAMA_URL: 'http://ollama.test' })) vi.stubEnv(k, v);
  // Ollama /api/generate reports prompt_eval_count / eval_count
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ response: REVIEW, prompt_eval_count: 812, eval_count: 64 }), { status: 200 })));
  const p = new SpecialistPanelService(db).createPanel({ topic: 'T', question: 'Q?', risk_class: 'high', specialist_ids: ['systems_architect', 'security_reviewer'],
    metadata: { self_improvement_id: 'fx' }, context: { description: 'Add a test', rationale: 'coverage' } });
  await new SelfImprovementAgentReviewService(db, undefined, { random: () => 1 }).reviewMissingSpecialists(p.id, 'run-1');
  const panelRows = db.prepare("SELECT tokens_in, tokens_out, purpose, cost_basis, marginal_cost FROM llm_model_calls WHERE consumer = 'panel_review'").all();
  expect(panelRows).toEqual([
    { tokens_in: 812, tokens_out: 64, purpose: 'panel_review:review', cost_basis: 'flat_subscription', marginal_cost: 0 },
    { tokens_in: 812, tokens_out: 64, purpose: 'panel_review:review', cost_basis: 'flat_subscription', marginal_cost: 0 },
  ]);
  const transport = db.prepare("SELECT tokens_in, tokens_out, purpose FROM llm_model_calls WHERE consumer = 'fallback'").all();
  expect(transport).toEqual([
    { tokens_in: null, tokens_out: null, purpose: 'transport:panel_review:review' },
    { tokens_in: null, tokens_out: null, purpose: 'transport:panel_review:review' },
  ]);
});

it('B29: a maker run inside ACE-001 / STE-001 / F2 records its experiment arms and runtime tokens', () => {
  fresh();
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, created_at, updated_at) VALUES ('g1', 'o', 'low', 'running', ?, datetime('now'), datetime('now'))")
    .run(JSON.stringify({ checker_family_arm: 'cross' }));
  recordMakerCall(db, { runId: 'r1', goalId: 'g1', loopName: 'test-gap-loop', runtime: 'opencode', ok: true, durationMs: 1000,
    meta: { model: 'ollama/glm-5.2:cloud', runtime_usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 } }, ace: { arm: '01' }, ste: { arm: 1 } });
  expect(db.prepare("SELECT consumer, experiment_id, purpose, tokens_in, tokens_out, run_id FROM llm_model_calls").get()).toEqual(
    { consumer: 'maker', experiment_id: 'ACE-001:01,STE-001:1,F2:cross', purpose: 'maker:test-gap-loop', tokens_in: 1000, tokens_out: 200, run_id: 'r1' });
  const totals = ledgerTotals(db, new Date(Date.now() - 86_400_000).toISOString());
  expect(totals.by_experiment[0]).toMatchObject({ key: 'ACE-001:01,STE-001:1,F2:cross', calls: 1, tokens_in: 1000 });
});

it('B29: unknown tokens stay null (UNKNOWN), never 0 — in the row and in the totals', () => {
  fresh();
  recordMakerCall(db, { runId: 'r2', goalId: null, loopName: 'mutation-gap-loop', runtime: 'remote', ok: false, durationMs: 10,
    meta: { runtime_usage: { usage_source: 'unknown' } }, ace: null, ste: null });
  expect(db.prepare('SELECT tokens_in, tokens_out, experiment_id FROM llm_model_calls').get()).toEqual({ tokens_in: null, tokens_out: null, experiment_id: null });
  const row = ledgerTotals(db, new Date(Date.now() - 86_400_000).toISOString()).by_purpose[0];
  expect(row).toMatchObject({ key: 'maker:mutation-gap-loop', calls: 1, calls_tokens_unknown: 1, tokens_in: null, tokens_out: null });
});

it('B29: flat subscription = marginal 0 with its label; unknown provider = null; metered = list price', () => {
  fresh(); vi.stubEnv('LLM_PRICE_PER_MTOK', 'jev-1.13.0=0.042/0');
  recordModelCall(db, { consumer: 'fallback', model: 'kimi-k3:cloud', provider: 'ollama:https://ollama.com', ok: true, latencyMs: 1, outChars: 1, shadow: 0, agree: null, tokensIn: 100, tokensOut: 10 });
  recordModelCall(db, { consumer: 'x', model: 'mystery-model', provider: 'mystery', ok: true, latencyMs: 1, outChars: 1, shadow: 0, agree: null, tokensIn: 100, tokensOut: 10 });
  recordModelCall(db, { consumer: 'jev', model: 'jev-1.13.0', provider: 'typesafe', ok: true, latencyMs: 1, outChars: 1, shadow: 0, agree: null, tokensIn: 1_000_000 });
  expect(db.prepare('SELECT cost_basis, list_price_cost, marginal_cost FROM llm_model_calls ORDER BY id').all()).toEqual([
    { cost_basis: 'flat_subscription', list_price_cost: null, marginal_cost: 0 },
    { cost_basis: 'unknown', list_price_cost: null, marginal_cost: null },
    { cost_basis: 'metered', list_price_cost: 0.042, marginal_cost: 0.042 },
  ]);
});
