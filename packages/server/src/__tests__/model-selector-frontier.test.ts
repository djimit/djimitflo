import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { recordModelCall, selectingRunner } from '../services/model-selector';
import { frontierAgree, frontierUsable } from '../services/expert-council-service';
import { buildEvolutionEvidence } from '../services/evolution-evidence';

const NOW = Date.parse('2026-10-05T20:00:00Z');
const ENV = { MODEL_CANDIDATES_FRONTIER_EXPERTS: 'glm-5.3-flash:cloud,kimi-k3:cloud', MODEL_COST_WEIGHTS: 'kimi-k3=4,glm-5.3-flash=1' } as Record<string, string>;
let db: Database.Database;
afterEach(() => { vi.unstubAllEnvs(); db?.close(); });
const fresh = () => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); return db; };
const review = (...decisions: string[]) => ({ checks: decisions.map((d, i) => ({ capability_id: `c${i}`, decision: d, rationale: 'r', evidence_refs: [], reviewer_evidence_refs: [] })) });
const rows = () => db.prepare('SELECT model, ok, shadow, agree FROM llm_model_calls ORDER BY id').all();

it('MS-2: agreement — expert reviews agree on identical per-capability decisions, technique cards on claim counts within one', () => {
  expect(frontierAgree(review('supported', 'uncertain'), review('supported', 'uncertain'))).toBe(true);
  expect(frontierAgree(review('supported', 'uncertain'), review('supported', 'unsupported'))).toBe(false);
  expect(frontierAgree({ claims: [1, 2, 3] }, { claims: [1, 2] })).toBe(true);
  expect(frontierAgree({ claims: [1, 2, 3] }, { claims: [] })).toBe(false);
  expect(frontierAgree({ perspective: 'x' }, { perspective: 'y' })).toBeNull(); // council perspectives: not comparable
  expect(frontierUsable(review('supported'))).toBe(true);
  expect(frontierUsable({ checks: 'nope' })).toBe(false);
  expect(frontierUsable(null)).toBe(false);
});

it('MS-2: mode off — one incumbent call, nothing recorded (byte-identical path)', async () => {
  fresh();
  const ask = vi.fn(async () => ({ json: review('supported'), chars: 40 }));
  const run = selectingRunner(db, 'frontier_experts', 'kimi-k3:cloud', ask, frontierUsable, frontierAgree, {} as Record<string, string>);
  expect(await run('s', 'u')).toEqual(review('supported'));
  expect(ask).toHaveBeenCalledTimes(1); expect(ask).toHaveBeenCalledWith('kimi-k3:cloud', 's', 'u');
  expect(rows()).toEqual([]);
});

it('MS-2: shadow — records the incumbent and one cheaper candidate with agreement, and returns only the incumbent answer', async () => {
  fresh();
  const ask = vi.fn(async (model: string) => ({ json: model.startsWith('glm') ? review('unsupported') : review('supported'), chars: 40 }));
  const run = selectingRunner(db, 'frontier_experts', 'kimi-k3:cloud', ask, frontierUsable, frontierAgree, { ...ENV, MODEL_SELECTOR_MODE: 'shadow', MODEL_SELECTOR_SHADOW_RATE: '1' });
  expect(await run('s', 'u')).toEqual(review('supported')); // the shadow answer is discarded
  expect(rows()).toEqual([
    { model: 'kimi-k3:cloud', ok: 1, shadow: 0, agree: null },
    { model: 'glm-5.3-flash:cloud', ok: 1, shadow: 1, agree: 0 },
  ]);
});

it('MS-2: enforce — uses the qualified cheaper model and falls back to the incumbent when its answer is unusable', async () => {
  fresh();
  for (let i = 0; i < 40; i++) recordModelCall(db, { consumer: 'frontier_experts', model: 'glm-5.3-flash:cloud', ok: true, latencyMs: 1, outChars: 1, shadow: 1, agree: true }, new Date(NOW - 3_600_000));
  const env = { ...ENV, MODEL_SELECTOR_MODE: 'enforce' };
  const good = vi.fn(async () => ({ json: review('supported'), chars: 40 }));
  await selectingRunner(db, 'frontier_experts', 'kimi-k3:cloud', good, frontierUsable, frontierAgree, env, () => 1, NOW)('s', 'u');
  expect(good).toHaveBeenCalledWith('glm-5.3-flash:cloud', 's', 'u');
  const flaky = vi.fn(async (model: string) => ({ json: model.startsWith('glm') ? { checks: 'garbled' } : review('supported'), chars: 10 }));
  expect(await selectingRunner(db, 'frontier_experts', 'kimi-k3:cloud', flaky, frontierUsable, frontierAgree, env, () => 1, NOW)('s', 'u')).toEqual(review('supported'));
  expect(flaky.mock.calls.map((c) => c[0])).toEqual(['glm-5.3-flash:cloud', 'kimi-k3:cloud']);
});

it('MS-2: the evidence models section covers frontier_experts with what it would pick', () => {
  fresh();
  const e = buildEvolutionEvidence(db, { FRONTIER_EXPERTS_RUNTIME: 'ollama:kimi-k3:cloud', ...ENV }, NOW);
  expect(e.models.would_pick).toMatchObject({ frontier_experts: 'kimi-k3:cloud' });
});
