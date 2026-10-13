import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { setLlmLedger } from '../services/model-selector';
import { generateText, resetLlmBreaker, transportPurpose } from '../services/llm-fallback';
import { SelfImprovementRefinementService } from '../services/self-improvement-refinement-service';
import { defaultCaller as dreamCaller } from '../services/dream-evolution';
import { createModelPerspectiveRunner } from '../services/expert-council-service';

/** Token-spend step 2: every llm_model_calls row says which caller spent it — no NULL, no anonymous 'fallback:generate'. */
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); setLlmLedger(db); resetLlmBreaker(); });
afterEach(() => { setLlmLedger(null); vi.unstubAllEnvs(); vi.unstubAllGlobals(); db.close(); });
const purposes = () => (db.prepare('SELECT purpose FROM llm_model_calls ORDER BY id').all() as Array<{ purpose: string | null }>).map((r) => r.purpose);
const reply = (body: Record<string, unknown>) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
const ENDPOINTS = [{ id: 'primary', kind: 'ollama' as const, baseUrl: 'http://a' }];

it('a generateText call without a caller identity is visible as untagged, never NULL', async () => {
  await generateText({ prompt: 'p', model: 'm', timeoutMs: 5_000 }, { endpoints: ENDPOINTS, fetchFn: reply({ response: '{}' }) as unknown as typeof fetch });
  expect(purposes()).toEqual(['untagged:generateText']);
});

it('the transport row carries the caller purpose; a caller with its own row (onUsage) keeps transport:<purpose>', () => {
  expect(transportPurpose({ purpose: 'dream_evolution' })).toBe('dream_evolution');
  expect(transportPurpose({ purpose: 'panel_review:review', onUsage: () => undefined })).toBe('transport:panel_review:review');
  expect(transportPurpose({})).toBe('untagged:generateText');
});

it('refinement and dream evolution — the callers behind the anonymous fallback rows — tag their calls', async () => {
  vi.stubEnv('OLLAMA_URL', 'http://ollama.test');
  vi.stubGlobal('fetch', reply({ response: '{"title":"t","description":"d","rationale":"r"}' }));
  await new SelfImprovementRefinementService().refine({ id: 'p', title: 't', description: 'd', rationale: 'r' } as never, []);
  await dreamCaller('dream prompt');
  expect(purposes()).toEqual(['self_improvement:refinement', 'dream_evolution']);
});

it('Frontier Experts selector rows name the caller: review, technique card, perspective, adversary', async () => {
  const env = { FRONTIER_EXPERTS_RUNTIME: 'ollama:kimi-k3:cloud', OLLAMA_URL: 'http://ollama.test', MODEL_SELECTOR_MODE: 'shadow', MODEL_SELECTOR_SHADOW_RATE: '0' } as NodeJS.ProcessEnv;
  vi.stubGlobal('fetch', reply({ message: { content: '{"checks":[]}' } }));
  const model = await createModelPerspectiveRunner(env, db);
  expect(model).not.toBeNull();
  await model!.runner('perspective', 's', 'u', 'frontier_experts:review');
  await model!.runner('perspective', 's', 'u', 'technique_card');
  await model!.runner('perspective', 's', 'u');
  await model!.runner('adversary', 's', 'u');
  expect(purposes()).toEqual(['frontier_experts:review', 'technique_card', 'frontier_experts:perspective', 'frontier_experts:adversary']);
});

it('every generateText call site in the server passes a literal purpose', () => {
  const root = path.join(__dirname, '..');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === '__tests__' || e.name === 'node_modules' ? [] : files(path.join(dir, e.name)))
      : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [path.join(dir, e.name)] : []);
  const sites: Array<{ file: string; tagged: boolean }> = [];
  for (const file of files(root)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?<!function )\bgenerateText\(/g)) {
      const end = src.indexOf('{ endpoints', m.index!); // the options object precedes the deps object
      sites.push({ file: path.relative(root, file), tagged: end > 0 && /purpose: '[a-z_:]+'/.test(src.slice(m.index!, end)) });
    }
  }
  expect(sites.length).toBeGreaterThanOrEqual(3);
  expect(sites.filter((s) => !s.tagged)).toEqual([]);
  // Frontier Experts and residents name themselves explicitly (the role default covers council perspectives / adversary)
  expect(fs.readFileSync(path.join(root, 'services/technique-card-service.ts'), 'utf8')).toContain("'technique_card')");
  expect(fs.readFileSync(path.join(root, 'services/expert-council-service.ts'), 'utf8')).toContain("'frontier_experts:review')");
  expect(fs.readFileSync(path.join(root, 'services/agent-social-autopilot-service.ts'), 'utf8')).toContain('purpose: `resident:${agentId}:${taskKind}`');
});
