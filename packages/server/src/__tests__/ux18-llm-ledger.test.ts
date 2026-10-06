import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { modelEvidence, setLlmLedger } from '../services/model-selector';
import { generateText } from '../services/llm-fallback';
import { TypeSafeClient, resetTypesafeBreaker } from '../services/typesafe-client';
import { embed } from '../services/proposal-dedupe';
import { OllamaEmbeddingProvider } from '../services/embedding-provider';
import { checkContentSafety, resetContentSafetyPause } from '../services/content-safety';
import { CouncilOrchestrator } from '../services/council-orchestrator';
import { modelPrice } from '../services/loop-budget-service';

const SECRET_PROMPT = 'UX18-PROMPT-MARKER do not store me';
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON'); setLlmLedger(db); });
afterEach(() => { setLlmLedger(null); vi.unstubAllEnvs(); vi.unstubAllGlobals(); db.close(); });
const rows = () => db.prepare('SELECT consumer, model, ok, provider, task_kind, status, tokens_in, tokens_out FROM llm_model_calls ORDER BY id').all() as Array<Record<string, unknown>>;
const json = (body: unknown, ok = true, status = 200) => ({ ok, status, headers: { get: () => null }, json: async () => body }) as unknown as Response;

it('UX-18: llm-fallback records one row per endpoint attempt (failed primary + healthy fallback)', async () => {
  const f = vi.fn()
    .mockResolvedValueOnce(json({}, false, 503))
    .mockResolvedValueOnce(json({ choices: [{ message: { content: '{"ok":true}' } }] }));
  const text = await generateText({ prompt: SECRET_PROMPT, model: 'kimi-k3:cloud', timeoutMs: 5_000 }, {
    endpoints: [{ id: 'primary', kind: 'ollama', baseUrl: 'http://a' }, { id: 'nvidia', kind: 'openai', baseUrl: 'http://b', model: 'moonshotai/kimi-k3' }], fetchFn: f as unknown as typeof fetch,
  });
  expect(text).toBe('{"ok":true}');
  expect(rows()).toEqual([
    expect.objectContaining({ consumer: 'fallback', model: 'kimi-k3:cloud', ok: 0, provider: 'primary', task_kind: 'generate' }),
    expect.objectContaining({ consumer: 'fallback', model: 'moonshotai/kimi-k3', ok: 1, provider: 'nvidia', status: 'ok' }),
  ]);
});

it('UX-18: jev (TypeSafe) calls are recorded per attempt', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'k'); resetTypesafeBreaker();
  const f = vi.fn().mockResolvedValue(json({ answers: {} }));
  await new TypeSafeClient(f as unknown as typeof fetch).systemOne({ text: SECRET_PROMPT }, { q: { type: 'noul', question: 'x?' } } as never, { retries: 0 });
  expect(rows()).toEqual([expect.objectContaining({ consumer: 'jev', ok: 1, provider: 'typesafe', task_kind: 'systemone' })]);
});

it('UX-18: both embedding paths are recorded (NVIDIA dedupe embed + embedding provider)', async () => {
  vi.stubEnv('NVIDIA_API_KEY', 'k');
  const f = vi.fn().mockResolvedValue(json({ data: [{ embedding: [0.1, 0.2] }] }));
  expect(await embed(SECRET_PROMPT, f as unknown as typeof fetch)).not.toBeNull();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ embedding: [0.3, 0.4] })));
  expect(await new OllamaEmbeddingProvider('http://o', 'nomic-embed-text').embed(SECRET_PROMPT)).toEqual([0.3, 0.4]);
  expect(rows()).toEqual([
    expect.objectContaining({ consumer: 'embeddings', model: 'nvidia/nemotron-3-embed-1b', ok: 1, provider: 'nvidia', task_kind: 'passage' }),
    expect.objectContaining({ consumer: 'embeddings', model: 'nomic-embed-text', ok: 1, task_kind: 'embed' }),
  ]);
});

it('UX-18: content safety records one ledger row per verdict, with the db it already has', async () => {
  vi.stubEnv('CONTENT_SAFETY_MODE', 'shadow'); vi.stubEnv('NVIDIA_API_KEY', 'k'); resetContentSafetyPause();
  setLlmLedger(null); // content safety does not depend on the process-wide ledger
  const f = vi.fn().mockResolvedValue(json({ choices: [{ message: { content: 'User Safety: safe' } }] }));
  expect(await checkContentSafety(db, { type: 'external_event', id: 'e1' }, SECRET_PROMPT, f as unknown as typeof fetch)).toBe('safe');
  expect(rows()).toEqual([expect.objectContaining({ consumer: 'content_safety', ok: 1, provider: 'nvidia', task_kind: 'safety', status: 'verdict=safe' })]);
});

it('UX-18: council model calls and resident calls are recorded with their consumer and tokens', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ response: 'perspective', eval_count: 42 })));
  const council = new CouncilOrchestrator(db) as unknown as { callModel: (m: unknown, p: string) => Promise<{ content: string }> };
  expect((await council.callModel({ provider: 'ollama', model_name: 'glm-5.3:cloud' }, SECRET_PROMPT)).content).toBe('perspective');
  const { AgentSocialAutopilotService } = await import('../services/agent-social-autopilot-service');
  const svc = new AgentSocialAutopilotService(db, { enabled: false } as never, { chat: async () => ({ content: 'hi', run_id: 'r', usage: {} }) }) as unknown as {
    residentCall: (a: string, k: string, s: { runtime: string; model: string }, c: () => Promise<{ content: string; usage: Record<string, unknown> }>) => Promise<unknown>;
  };
  await svc.residentCall('commons-scout', 'reply', { runtime: 'openai-compatible', model: 'glm-5.3' }, async () => ({ content: 'hello', usage: { prompt_tokens: 120, completion_tokens: 30 } }));
  expect(rows()).toEqual([
    expect.objectContaining({ consumer: 'council', model: 'glm-5.3:cloud', ok: 1, provider: 'ollama', tokens_out: 42 }),
    expect.objectContaining({ consumer: 'resident:commons-scout', model: 'glm-5.3', ok: 1, provider: 'openai-compatible', task_kind: 'reply', tokens_in: 120, tokens_out: 30 }),
  ]);
});

it('UX-18: a broken ledger never fails the call; prompt text is never stored', async () => {
  const f = vi.fn().mockResolvedValue(json({ response: '{"x":1}' }));
  const broken = new Database(':memory:'); broken.close(); setLlmLedger(broken);
  expect(await generateText({ prompt: SECRET_PROMPT, model: 'm', timeoutMs: 5_000 }, { endpoints: [{ id: 'p', kind: 'ollama', baseUrl: 'http://a' }], fetchFn: f as unknown as typeof fetch })).toBe('{"x":1}');
  setLlmLedger(db);
  await generateText({ prompt: SECRET_PROMPT, model: 'm', timeoutMs: 5_000 }, { endpoints: [{ id: 'p', kind: 'ollama', baseUrl: 'http://a' }], fetchFn: f as unknown as typeof fetch });
  const dump = JSON.stringify(db.prepare('SELECT * FROM llm_model_calls').all());
  expect(dump).not.toContain('UX18-PROMPT-MARKER');
  expect(rows()).toHaveLength(1);
});

it('UX-18: the evidence shows calls and tokens per consumer over 7 d; cost only with configured prices (never invented)', async () => {
  const f = vi.fn().mockResolvedValue(json({ response: '{"x":1}' }));
  await generateText({ prompt: 'p', model: 'kimi-k3:cloud', timeoutMs: 5_000 }, { endpoints: [{ id: 'p', kind: 'ollama', baseUrl: 'http://a' }], fetchFn: f as unknown as typeof fetch });
  db.prepare("INSERT INTO llm_model_calls (consumer, model, ok, latency_ms, out_chars, shadow, tokens_in, tokens_out, created_at) VALUES ('jev', 'jev-1.13.0', 1, 900, 0, 0, 1000000, 0, ?)").run(new Date().toISOString());
  const ev = modelEvidence(db, {}, { LLM_PRICE_PER_MTOK: 'jev-1.13.0=0.042/0' } as NodeJS.ProcessEnv);
  expect(ev.usage_7d).toEqual(expect.arrayContaining([
    { consumer: 'jev', calls: 1, ok: 1, tokens_in: 1000000, tokens_out: 0, est_cost_usd: 0.042 },
    { consumer: 'fallback', calls: 1, ok: 1, tokens_in: 0, tokens_out: 0, est_cost_usd: null },
  ]));
  expect(modelPrice('unknown-model', {})).toBeNull();
});

it('UX-18: every known server-side LLM call site records to the ledger', () => {
  const sites = ['services/llm-fallback.ts', 'services/typesafe-client.ts', 'services/content-safety.ts', 'services/proposal-dedupe.ts',
    'services/embedding-provider.ts', 'services/agent-social-autopilot-service.ts', 'services/council-orchestrator.ts', 'services/self-improvement-agent-review-service.ts', 'services/expert-council-service.ts'];
  for (const s of sites) {
    const src = fs.readFileSync(path.join(__dirname, '..', s), 'utf8');
    expect({ s, ok: /from '\.\/model-selector'/.test(src) && /(recordModelCall|recordLlmCall|measured|selectingRunner|chooseModel)\(/.test(src) }).toEqual({ s, ok: true });
  }
});
