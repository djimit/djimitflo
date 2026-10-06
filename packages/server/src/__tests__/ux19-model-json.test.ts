import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { firstJsonObject, parseModelJson, repairModelJson } from '../services/model-json';
import { firstJsonObject as reexported } from '../services/expert-council-service';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { SelfImprovementAgentReviewService } from '../services/self-improvement-agent-review-service';

let db: Database.Database;
afterEach(() => { vi.unstubAllEnvs(); db?.close(); });
const fresh = () => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); return db; };
const REVIEW = (stance: string) => JSON.stringify({ stance, confidence: 0.7, findings: ['f'], evidence_refs: ['context:rationale'] });
const SHAPE = z.object({ stance: z.string() }).passthrough();
function panel() {
  return new SpecialistPanelService(db).createPanel({ topic: 'Test proposal', question: 'Authorize?', risk_class: 'high', specialist_ids: ['systems_architect', 'security_reviewer'],
    metadata: { self_improvement_id: 'fx' }, context: { description: 'Add a test', rationale: 'coverage' } }).id;
}
const ledger = () => db.prepare("SELECT consumer, status, ok FROM llm_model_calls WHERE task_kind = 'json_repair'").all();

it('UX-19: think tags and code fences are stripped and a JSON object in the middle of narration parses', () => {
  expect(parseModelJson('<think>maybe {"stance":"oppose"}</think>Sure! Here it is: ```json\n{"stance":"support","x":1}\n``` hope that helps', SHAPE))
    .toEqual({ stance: 'support', x: 1 });
  expect(parseModelJson('I reviewed it carefully. {"stance": "uncertain"} That is my view.', SHAPE)).toEqual({ stance: 'uncertain' });
  expect(parseModelJson('no json here', SHAPE)).toBeNull();
  expect(parseModelJson('{"other": 1}', SHAPE)).toBeNull(); // wrong shape
  expect(reexported).toBe(firstJsonObject); // existing importers (dream-evolution) keep working
});

it('UX-19: flag off — no repair call, nothing recorded, the unreadable answer falls back exactly as before', async () => {
  fresh();
  const ask = vi.fn(async () => REVIEW('support'));
  expect(await repairModelJson({ db, consumer: 'panel_review', model: 'm', raw: 'garbled', schema: SHAPE, shape: '{}', ask })).toBeNull();
  expect(ask).not.toHaveBeenCalled();
  const prompts: string[] = [];
  const reviewer = new SelfImprovementAgentReviewService(db, async (p) => { prompts.push(p); return 'I think it is fine.'; });
  for (let i = 0; i < 3; i++) await reviewer.reviewMissingSpecialists(panel(), `run-${i}`); // 3 unreadable attempts on fresh panels
  expect(prompts.every((p) => !p.includes('Your previous answer'))).toBe(true);
  expect(ledger()).toEqual([]);
});

it('UX-19: flag on — a malformed panel answer is repaired by one retry to the same model and recorded as repaired', async () => {
  fresh(); vi.stubEnv('LLM_JSON_REPAIR_ENABLED', 'true'); vi.stubEnv('SELF_IMPROVEMENT_REVIEW_MODEL', 'glm-5.3-flash:cloud');
  const calls: string[] = [];
  const reviewer = new SelfImprovementAgentReviewService(db, async (p) => {
    calls.push(p);
    return p.includes('Your previous answer') ? REVIEW('oppose') : 'Overall this looks reasonable, I would lean towards support.';
  });
  const updated = await reviewer.reviewMissingSpecialists(panel(), 'run-r');
  expect(calls).toHaveLength(4); // per reviewer: the review + one repair, no more
  expect(updated.reviews.map((r) => r.stance)).toEqual(['oppose', 'oppose']);
  expect(ledger()).toEqual([{ consumer: 'panel_review', status: 'repaired', ok: 1 }, { consumer: 'panel_review', status: 'repaired', ok: 1 }]);
});

it('UX-19: flag on — an irreparable answer is recorded as unparseable and the review path is unchanged', async () => {
  fresh(); vi.stubEnv('LLM_JSON_REPAIR_ENABLED', 'true');
  const ask = vi.fn(async () => 'still not JSON');
  expect(await repairModelJson({ db, consumer: 'panel_review', model: 'kimi-k3:cloud', raw: 'garbled', schema: SHAPE, shape: '{"stance":"..."}', ask })).toBeNull();
  expect(ask).toHaveBeenCalledTimes(1);
  expect(ledger()).toEqual([{ consumer: 'panel_review', status: 'unparseable', ok: 0 }]);
  // a throwing model call is recorded too and never escapes
  const boom = vi.fn(async () => { throw new Error('timeout'); });
  expect(await repairModelJson({ db, consumer: 'panel_review', model: 'kimi-k3:cloud', raw: 'x', schema: SHAPE, shape: '{}', ask: boom })).toBeNull();
  expect(ledger()).toHaveLength(2);
});
