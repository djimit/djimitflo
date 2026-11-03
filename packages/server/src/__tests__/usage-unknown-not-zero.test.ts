import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { ace001Evidence } from '../services/ace-001';
import { callCost, modelEvidence, recordModelCall } from '../services/model-selector';
import { LoopBudgetService, modelPrice, modelPriceEntry } from '../services/loop-budget-service';

// Forensic audit 2026-10-26: L-F04 (partial/fallback prices), L-F05 (missing usage → 0), CODE-007 (economy dollars without a dated price).
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());

describe('L-F05: missing tokens or duration never improve efficiency or an arm mean', () => {
  it('a 0-token / 0-duration outcome (missing usage coalesced to 0) does not raise skill efficiency; coverage is reported', () => {
    const engine = new SkillEvolutionEngine(db);
    engine.recordOutcome('s', { success: true, tokensUsed: 4000, durationMs: 60_000, domain: 'fleet', evidenceRefs: ['skill_delivery:delivered'] });
    expect(engine.measuredTraits('s').efficiency).toBe(0.25);
    engine.recordOutcome('s', { success: true, tokensUsed: 0, durationMs: 0, domain: 'fleet', evidenceRefs: ['skill_delivery:delivered'] }); // producer sent no usage
    engine.recordOutcome('s', { success: true, tokensUsed: null, durationMs: 0, domain: 'fleet', evidenceRefs: ['skill_delivery:delivered'] });
    const t = engine.measuredTraits('s');
    expect(t.efficiency).toBe(0.25); // was (0.25 + 1) / 2 = 0.625: the missing report scored maximal efficiency
    expect(t.reliability).toBe(1); // the outcomes still count as outcomes
    expect(t.efficiency_coverage).toEqual({ known: 1, total: 3 });
  });

  it('only missing usage gives efficiency null, never 1', () => {
    const engine = new SkillEvolutionEngine(db);
    engine.recordOutcome('s', { success: true, tokensUsed: 0, durationMs: 0, domain: 'fleet', evidenceRefs: ['skill_delivery:delivered'] });
    expect(engine.measuredTraits('s')).toMatchObject({ efficiency: null, efficiency_coverage: { known: 0, total: 1 } });
  });

  it('ACE-001 tokens_mean averages known tokens only and reports tokens_n; an arm with no known tokens is null', () => {
    new SkillEvolutionEngine(db);
    const at = new Date().toISOString();
    const outcome = (arm: string, tokens: number | null) => db.prepare(`INSERT INTO skill_outcomes (id, skill_id, success, tokens_used, duration_ms, domain, task_id, agent_id, evidence_refs_json, created_at)
      VALUES (?, 'loop-maker:test-gap-loop:opencode', 1, ?, 0, 'x', ?, 'a', ?, ?)`).run(randomUUID(), tokens, randomUUID(), JSON.stringify([`ace-001-arm:${arm}`]), at);
    outcome('00', 3000); outcome('00', null); outcome('00', 0);
    outcome('11', null);
    const ev = ace001Evidence(db, '2020-01-01T00:00:00Z', { ACE_001_ANALYSIS_SINCE: '2020-01-01T00:00:00Z' });
    expect(ev.arms['00']).toMatchObject({ n: 3, verified: 3, tokens_mean: 3000, tokens_n: 1 }); // was 1000: unknown runs averaged as 0 tokens
    expect(ev.arms['11']).toMatchObject({ n: 1, tokens_mean: null, tokens_n: 0 }); // was 0
  });
});

describe('L-F04: a partial or fallback price is unknown or an explicit lower bound', () => {
  const env = { LLM_PRICE_PER_MTOK: 'audit-model=2/10', LLM_COST_BASIS: 'audit-metered=metered' };

  it('one side missing: no list or marginal price, a lower bound marked partial (audit probe: was $2 complete)', () => {
    expect(callCost({ model: 'audit-model', provider: 'audit-metered', tokensIn: 1_000_000, tokensOut: null }, env))
      .toEqual({ cost_basis: 'metered', list_price_cost: null, marginal_cost: null, price_completeness: 'partial', list_price_lower_bound: 2 });
    expect(callCost({ model: 'audit-model', provider: 'audit-metered', tokensIn: null, tokensOut: 100_000 }, env))
      .toMatchObject({ list_price_cost: null, price_completeness: 'partial', list_price_lower_bound: 1 });
  });

  it('both sides known is a complete price; a missing side priced at 0 costs 0 and stays complete', () => {
    expect(callCost({ model: 'audit-model', provider: 'audit-metered', tokensIn: 1_000_000, tokensOut: 100_000 }, env))
      .toEqual({ cost_basis: 'metered', list_price_cost: 3, marginal_cost: 3, price_completeness: 'complete', list_price_lower_bound: null });
    expect(callCost({ model: 'jev', provider: 'typesafe', tokensIn: 1_000_000 }, { LLM_PRICE_PER_MTOK: 'jev=0.042/0' }))
      .toMatchObject({ list_price_cost: 0.042, price_completeness: 'complete' });
    expect(callCost({ model: 'audit-model', provider: 'audit-metered' }, env)).toMatchObject({ list_price_cost: null, price_completeness: null, list_price_lower_bound: null });
  });

  it('an unconfigured runtime has no tariff estimate (audit probe: was a fixed $2/Mtok)', () => {
    const budget = new LoopBudgetService(db, {} as never);
    expect(budget.computeDollarCost('never-configured', 1_000_000)).toBeNull();
    expect(budget.computeDollarCost('codex', 1_000_000)).toBe(2); // the tariff baseline itself is kept
  });
});

describe('L-F04: the 7-day usage aggregate keeps missing token sides as coverage, never priced as 0', () => {
  const env = { LLM_PRICE_PER_MTOK: 'audit-model=2/10,free-out=1/0', LLM_COST_BASIS: 'audit-metered=metered' } as NodeJS.ProcessEnv;
  const call = (consumer: string, model: string, tokensIn: number | null, tokensOut: number | null) => recordModelCall(db,
    { consumer, model, provider: 'audit-metered', ok: true, latencyMs: 1, outChars: 1, shadow: 0, agree: null, tokensIn, tokensOut });

  it('a call with unknown output (priced 10/Mtok) leaves the cost unknown with a labelled lower bound (was est_cost_usd 2)', () => {
    call('c', 'audit-model', 1_000_000, null);
    const row = modelEvidence(db, {}, env).usage_7d.find((u) => u.consumer === 'c')!;
    expect(row).toMatchObject({ calls: 1, tokens_in: 1_000_000, tokens_out: 0, calls_tokens_in_unknown: 0, calls_tokens_out_unknown: 1,
      est_cost_usd: null, est_cost_lower_bound_usd: 2, cost_completeness: 'partial' });
  });

  it('complete sides give a complete cost; a missing side priced at 0 stays complete', () => {
    call('full', 'audit-model', 1_000_000, 100_000);
    call('free', 'free-out', 1_000_000, null);
    const ev = modelEvidence(db, {}, env).usage_7d;
    expect(ev.find((u) => u.consumer === 'full')).toMatchObject({ est_cost_usd: 3, est_cost_lower_bound_usd: null, cost_completeness: 'complete' });
    expect(ev.find((u) => u.consumer === 'free')).toMatchObject({ est_cost_usd: 1, cost_completeness: 'complete', calls_tokens_out_unknown: 1 });
  });

  it('one partial call makes the consumer total partial; a model without a price leaves no cost at all', () => {
    call('mix', 'audit-model', 1_000_000, 100_000); call('mix', 'audit-model', null, null);
    call('none', 'no-price-model', 1000, 1000);
    const ev = modelEvidence(db, {}, env).usage_7d;
    expect(ev.find((u) => u.consumer === 'mix')).toMatchObject({ calls: 2, calls_tokens_in_unknown: 1, calls_tokens_out_unknown: 1,
      est_cost_usd: null, est_cost_lower_bound_usd: 3, cost_completeness: 'partial' });
    expect(ev.find((u) => u.consumer === 'none')).toMatchObject({ est_cost_usd: null, est_cost_lower_bound_usd: null, cost_completeness: null });
  });
});

describe('CODE-007: run economy dollars come only from a dated model price', () => {
  const run = (id: string) => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, findings_json, plan_json, gates_json, next_actions_json, metadata)
    VALUES (?, 'test', 'closed', 'completed', '/tmp', '[]', '[]', '[]', '[]', '{}')`).run(id);
  const lease = (id: string, runId: string, runtime: string, meta: Record<string, unknown>, updatedAt = '2026-10-20T10:00:00.000Z') => db.prepare(`INSERT INTO worker_leases
    (id, loop_run_id, role, runtime, status, finding_id, worktree_path, metadata, updated_at) VALUES (?, ?, 'maker', ?, 'completed', 'f1', '/tmp', ?, ?)`)
    .run(id, runId, runtime, JSON.stringify(meta), updatedAt);
  const priced = (usd: number, completeness: 'complete' | 'partial' = 'complete') => ({ version: 1, estimated_cost_usd: usd, cost_completeness: completeness, price_version: 'abcd1234abcd1234',
    price_source: 'LLM_PRICE_PER_MTOK', input_tokens: 1000, output_tokens: 100, total_tokens: 1100 });

  it('runtime total-only usage is no dollar figure: null with a reason, the tariff kept apart as a labelled estimate', () => {
    run('r-total'); lease('m1', 'r-total', 'codex', { runtime_usage: { total_tokens: 1_000_000 } });
    const m = new LoopBudgetService(db, {} as never).computeEfficiencyMetric('r-total');
    expect(m.dollarsSpent).toBeNull(); // was $2: codex tariff × total tokens
    expect(m.dollarsReason).toBe('no_dated_model_price');
    expect(m.efficiency).toBeNull();
    expect(m.efficiencyReason).toBe('no_dated_model_price');
    expect(m.usageCoverage).toEqual({ reported: 1, total: 1, ratio: 1 });
    expect(m.runtimeTariffEstimate).toEqual({ usd: 2, lower_bound: false, basis: 'runtime_tariff_per_mtok_total', unpriced_runtimes: [] });
  });

  it('an unknown runtime adds nothing to the tariff estimate (no $2 fallback) and is named', () => {
    run('r-unk'); lease('m1', 'r-unk', 'mystery', { runtime_usage: { total_tokens: 1_000_000 } });
    const m = new LoopBudgetService(db, {} as never).computeEfficiencyMetric('r-unk');
    expect(m.dollarsSpent).toBeNull();
    expect(m.runtimeTariffEstimate).toEqual({ usd: null, lower_bound: false, basis: 'runtime_tariff_per_mtok_total', unpriced_runtimes: ['mystery'] });
  });

  it('a lease cost with a price_version is dollars, dated by the lease; unpriced or partial leases make it a lower bound', () => {
    run('r-dated');
    lease('m1', 'r-dated', 'opencode', { runtime_usage: { total_tokens: 1100 }, token_accounting: priced(0.5) }, '2026-10-20T10:00:00.000Z');
    lease('m2', 'r-dated', 'opencode', { runtime_usage: { total_tokens: 1100 }, token_accounting: priced(0.25, 'partial') }, '2026-10-21T10:00:00.000Z');
    lease('m3', 'r-dated', 'codex', { runtime_usage: { total_tokens: 1_000_000 } });
    const m = new LoopBudgetService(db, {} as never).computeEfficiencyMetric('r-dated');
    expect(m.dollarsSpent).toBeCloseTo(0.75, 6);
    expect(m.dollarsLowerBound).toBe(true);
    expect(m.dollarsReason).toBeNull();
    expect(m.priceCoverage).toEqual({ priced: 2, partial: 1, total: 3, ratio: 2 / 3 });
    expect(m.priceBasis).toEqual({ source: 'token_accounting', price_versions: ['abcd1234abcd1234'], priced_at: '2026-10-21T10:00:00.000Z' });
  });

  it('a cost without a price_version is not a dated price', () => {
    run('r-undated'); lease('m1', 'r-undated', 'opencode', { runtime_usage: { total_tokens: 1100 }, token_accounting: { ...priced(0.5), price_version: null } });
    expect(new LoopBudgetService(db, {} as never).computeEfficiencyMetric('r-undated').dollarsSpent).toBeNull();
  });
});

// E-assumptions A4/C13 (re-20261030): an LLM_PRICE_PER_MTOK entry without an output price was read as output 0
// (loop-budget-service.ts:127) — a price invented as free. A missing side is no price; an explicit 0 stays 0.
describe('C13: a missing output price is no price, never 0', () => {
  it('model=in (no output) and model=in/ are unpriced; model=in/0 is an explicit free output', () => {
    expect(modelPrice('m', { LLM_PRICE_PER_MTOK: 'm=2' })).toBeNull();
    expect(modelPrice('m', { LLM_PRICE_PER_MTOK: 'm=2/' })).toBeNull();
    expect(modelPriceEntry('m', { LLM_PRICE_PER_MTOK: 'm=2/abc' })).toBeNull();
    expect(modelPrice('m', { LLM_PRICE_PER_MTOK: 'm=2/0' })).toEqual({ input: 2, output: 0 });
    expect(modelPrice('m', { LLM_PRICE_PER_MTOK: 'other=1/1,m=2/10' })).toEqual({ input: 2, output: 10 });
  });
});
