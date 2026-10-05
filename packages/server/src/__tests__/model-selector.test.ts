import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { chooseModel, costWeight, recordModelCall } from '../services/model-selector';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { SelfImprovementAgentReviewService } from '../services/self-improvement-agent-review-service';
import { buildEvolutionEvidence } from '../services/evolution-evidence';

const NOW = Date.parse('2026-10-05T20:00:00Z');
const ENV = { MODEL_CANDIDATES_PANEL_REVIEW: 'glm-5.3-flash:cloud,glm-5.3:cloud,kimi-k3:cloud', MODEL_COST_WEIGHTS: 'kimi-k3=4,glm-5.3=2,glm-5.3-flash=1' } as NodeJS.ProcessEnv;
let db: Database.Database;
afterEach(() => { vi.unstubAllEnvs(); db?.close(); });
const fresh = () => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); return db; };
const calls = (model: string, n: number, opts: { ok?: number; shadow?: 0 | 1; agree?: number | null } = {}) => {
  for (let i = 0; i < n; i++) {
    recordModelCall(db, { consumer: 'panel_review', model, ok: i < (opts.ok ?? n), latencyMs: 5000, outChars: 300, shadow: opts.shadow ?? 1,
      agree: opts.agree === null ? null : i < (opts.agree ?? n) ? true : false }, new Date(NOW - 3_600_000));
  }
};
const REVIEW = (stance: string) => JSON.stringify({ stance, confidence: 0.7, findings: ['f'], evidence_refs: ['context:rationale'] });
function panel() {
  const p = new SpecialistPanelService(db).createPanel({ topic: 'Test proposal', question: 'Authorize?', risk_class: 'high', specialist_ids: ['systems_architect', 'security_reviewer'],
    metadata: { self_improvement_id: 'fx' }, context: { description: 'Add a test', rationale: 'coverage' } });
  return p.id;
}

it('MS-1: the cheapest candidate that qualifies is picked; the incumbent otherwise', () => {
  fresh();
  expect(chooseModel(db, 'panel_review', 'kimi-k3:cloud', ENV, NOW)).toBe('kimi-k3:cloud'); // no evidence yet
  calls('glm-5.3-flash:cloud', 40); calls('glm-5.3:cloud', 40);
  expect(chooseModel(db, 'panel_review', 'kimi-k3:cloud', ENV, NOW)).toBe('glm-5.3-flash:cloud');
  expect(costWeight('ollama:glm-5.3-flash:cloud', ENV)).toBe(1); expect(costWeight('unknown-model', ENV)).toBe(2);
});

it('MS-1: below n, ok-rate (Wilson) or shadow agreement the candidate does not qualify', () => {
  fresh(); calls('glm-5.3-flash:cloud', 19);
  expect(chooseModel(db, 'panel_review', 'kimi-k3:cloud', ENV, NOW)).toBe('kimi-k3:cloud'); // n < 20
  fresh(); calls('glm-5.3-flash:cloud', 40, { ok: 36 });
  expect(chooseModel(db, 'panel_review', 'kimi-k3:cloud', ENV, NOW)).toBe('kimi-k3:cloud'); // 90 % ok
  fresh(); calls('glm-5.3-flash:cloud', 40, { agree: 28 });
  expect(chooseModel(db, 'panel_review', 'kimi-k3:cloud', ENV, NOW)).toBe('kimi-k3:cloud'); // 70 % agreement
  fresh(); calls('glm-5.3-flash:cloud', 40, { agree: null, shadow: 0 });
  expect(chooseModel(db, 'panel_review', 'kimi-k3:cloud', ENV, NOW)).toBe('kimi-k3:cloud'); // never compared with the incumbent
  fresh(); calls('glm-5.3-flash:cloud', 40, { agree: 40 }); // a costlier incumbent never wins against a qualified cheaper one,
  expect(chooseModel(db, 'panel_review', 'glm-5.3-flash:cloud', ENV, NOW)).toBe('glm-5.3-flash:cloud'); // and a cheap incumbent stays
});

it('MS-1: mode off — the panel call is unchanged and nothing is recorded', async () => {
  fresh(); vi.stubEnv('SELF_IMPROVEMENT_REVIEW_MODEL', 'kimi-k3:cloud');
  const models: Array<string | undefined> = [];
  const reviewer = new SelfImprovementAgentReviewService(db, async (_p, model) => { models.push(model); return REVIEW('support'); }, { random: () => 0 });
  const updated = await reviewer.reviewMissingSpecialists(panel(), 'run-1');
  expect(updated.consensus.support_count).toBe(2);
  expect(models).toEqual([undefined, undefined]); // the caller's own default model, exactly as before
  expect(db.prepare('SELECT COUNT(*) AS n FROM llm_model_calls').get()).toEqual({ n: 0 });
});

it('MS-1: shadow mode records the incumbent and one candidate, and never uses the candidate answer', async () => {
  fresh(); for (const [k, v] of Object.entries({ ...ENV, MODEL_SELECTOR_MODE: 'shadow', MODEL_SELECTOR_SHADOW_RATE: '1', SELF_IMPROVEMENT_REVIEW_MODEL: 'kimi-k3:cloud' })) vi.stubEnv(k, v as string);
  const reviewer = new SelfImprovementAgentReviewService(db, async (_p, model) => (model === 'glm-5.3-flash:cloud' ? REVIEW('oppose') : REVIEW('support')), { random: () => 0 });
  const updated = await reviewer.reviewMissingSpecialists(panel(), 'run-2');
  expect(updated.consensus.support_count).toBe(2); expect(updated.consensus.oppose_count).toBe(0); // the shadow 'oppose' was discarded
  expect(db.prepare('SELECT model, ok, shadow, agree FROM llm_model_calls ORDER BY id').all()).toEqual([
    { model: 'kimi-k3:cloud', ok: 1, shadow: 0, agree: null },
    { model: 'glm-5.3-flash:cloud', ok: 1, shadow: 1, agree: 0 }, // cheapest first …
    { model: 'kimi-k3:cloud', ok: 1, shadow: 0, agree: null },
    { model: 'glm-5.3:cloud', ok: 1, shadow: 1, agree: 1 }, // … then round-robin
  ]);
});

it('MS-1: enforce uses the qualified cheaper model and falls back to the incumbent when its answer does not parse', async () => {
  fresh(); for (const [k, v] of Object.entries({ ...ENV, MODEL_SELECTOR_MODE: 'enforce', SELF_IMPROVEMENT_REVIEW_MODEL: 'kimi-k3:cloud' })) vi.stubEnv(k, v as string);
  calls('glm-5.3-flash:cloud', 40);
  const models: Array<string | undefined> = [];
  const ok = new SelfImprovementAgentReviewService(db, async (_p, model) => { models.push(model); return REVIEW('support'); }, { random: () => 1 });
  await ok.reviewMissingSpecialists(panel(), 'run-3');
  expect(models).toEqual(['glm-5.3-flash:cloud', 'glm-5.3-flash:cloud']);
  models.length = 0;
  const garbled = new SelfImprovementAgentReviewService(db, async (_p, model) => { models.push(model); return model === 'glm-5.3-flash:cloud' ? 'I think it is fine.' : REVIEW('support'); }, { random: () => 1 });
  const updated = await garbled.reviewMissingSpecialists(panel(), 'run-4');
  // one parse failure drops the candidate below the Wilson bar (41/42 ok): the second specialist goes straight to the incumbent
  expect(models).toEqual(['glm-5.3-flash:cloud', 'kimi-k3:cloud', 'kimi-k3:cloud']);
  expect(updated.consensus.support_count).toBe(2);
});

it('MS-1: the evidence endpoint shows per-model calls, ok and agreement rates, cost and the would-pick', () => {
  fresh(); calls('glm-5.3-flash:cloud', 40); calls('kimi-k3:cloud', 3, { shadow: 0, agree: null });
  const e = buildEvolutionEvidence(db, { ...ENV, SELF_IMPROVEMENT_REVIEW_MODEL: 'kimi-k3:cloud' }, NOW, 30);
  expect(e.models.would_pick).toEqual({ panel_review: 'glm-5.3-flash:cloud' });
  expect(e.models.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ consumer: 'panel_review', model: 'glm-5.3-flash:cloud', n: 40, ok_rate: 1, agree_rate: 1, median_latency_ms: 5000, cost_weight: 1 }),
    expect.objectContaining({ consumer: 'panel_review', model: 'kimi-k3:cloud', n: 3, agree_rate: null, cost_weight: 4 }),
  ]));
});
