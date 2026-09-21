import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { generateText, isLlmEndpointDown, llmEndpoints, resetLlmBreaker, type LlmEndpoint } from '../services/llm-fallback';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { SelfImprovementAgentReviewService } from '../services/self-improvement-agent-review-service';
import { autopilotFallbackSpec } from '../services/agent-social-autopilot-service';

const ollama = (url: string, model?: string): LlmEndpoint => ({ id: `ollama:${url}`, kind: 'ollama', baseUrl: url, model });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const opts = { prompt: 'p', model: 'primary-model', timeoutMs: 1000 };

beforeEach(() => resetLlmBreaker());
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('llmEndpoints', () => {
  it('is just the primary unless fallbacks are configured', () => {
    expect(llmEndpoints('http://a:11434', {})).toHaveLength(1);
    const all = llmEndpoints('http://a:11434', { OLLAMA_FALLBACK_URL: 'http://b:11434', OLLAMA_FALLBACK_MODEL: 'small', LLM_FALLBACK_OPENAI_URL: 'https://c/v1/', LLM_FALLBACK_OPENAI_KEY: 'k', LLM_FALLBACK_MODEL: 'cloud' });
    expect(all.map((e) => [e.kind, e.baseUrl, e.model])).toEqual([['ollama', 'http://a:11434', undefined], ['ollama', 'http://b:11434', 'small'], ['openai', 'https://c/v1', 'cloud']]);
    expect(llmEndpoints('http://a', { OLLAMA_FALLBACK_URL: 'http://a' })).toHaveLength(1); // same host is not a fallback
  });
});

describe('generateText', () => {
  it('uses the primary when it works and never touches the fallback', async () => {
    const fetchFn = vi.fn(async () => json({ response: '{"ok":1}' }));
    const out = await generateText(opts, { endpoints: [ollama('http://a'), ollama('http://b')], fetchFn: fetchFn as never });
    expect(out).toBe('{"ok":1}');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('fails over when the primary host is unreachable, remembers it is down, and tries the healthy host first next time', async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => { calls.push(url); if (url.startsWith('http://a')) throw new TypeError('fetch failed'); return json({ response: 'from-b' }); });
    const endpoints = [ollama('http://a'), ollama('http://b', 'fallback-model')];
    expect(await generateText(opts, { endpoints, fetchFn: fetchFn as never })).toBe('from-b');
    expect(isLlmEndpointDown('ollama:http://a')).toBe(true);
    calls.length = 0;
    await generateText(opts, { endpoints, fetchFn: fetchFn as never });
    expect(calls).toEqual(['http://b/api/generate']); // the dead host is not asked first any more
  });

  it('calls an OpenAI-compatible fallback with its own key and model', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith('http://a')) throw new TypeError('fetch failed');
      seen = { url, init }; return json({ choices: [{ message: { content: '{"stance":"support"}' } }] });
    });
    const endpoints: LlmEndpoint[] = [ollama('http://a'), { id: 'openai:https://c/v1', kind: 'openai', baseUrl: 'https://c/v1', apiKey: 'sekret', model: 'cloud-model' }];
    expect(await generateText(opts, { endpoints, fetchFn: fetchFn as never })).toBe('{"stance":"support"}');
    expect(seen!.url).toBe('https://c/v1/chat/completions');
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer sekret');
    expect(JSON.parse(String(seen!.init.body)).model).toBe('cloud-model');
  });

  it('a missing model (404) fails over but does not mark the host down', async () => {
    const fetchFn = vi.fn(async (url: string) => (url.startsWith('http://a') ? json({}, 404) : json({ response: 'ok' })));
    expect(await generateText(opts, { endpoints: [ollama('http://a'), ollama('http://b')], fetchFn: fetchFn as never })).toBe('ok');
    expect(isLlmEndpointDown('ollama:http://a')).toBe(false);
  });

  it("when everything fails it reports the primary's own error (callers classify on it)", async () => {
    const fetchFn = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(generateText(opts, { endpoints: [ollama('http://a'), ollama('http://b')], fetchFn: fetchFn as never })).rejects.toThrow(/^fetch failed \(fallbacks also failed: ollama:http:\/\/b: fetch failed\)$/);
  });
});

describe('panel review survives an outage of the primary host', () => {
  it('completes both specialist reviews in one call through the fallback host', async () => {
    const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
    const panel = new SpecialistPanelService(db).createPanel({
      topic: 't', question: 'q', risk_class: 'low', specialist_ids: ['systems_architect', 'runtime_engineer'], metadata: {}, context: { description: 'd', rationale: 'r' },
    });
    vi.stubEnv('OLLAMA_URL', 'http://primary-down:11434');
    vi.stubEnv('OLLAMA_FALLBACK_URL', 'http://fallback:11434');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).startsWith('http://primary-down')) throw new TypeError('fetch failed');
      return json({ response: JSON.stringify({ stance: 'support', confidence: 0.9, findings: ['sound'], evidence_refs: ['context:rationale'] }) });
    }));
    const updated = await new SelfImprovementAgentReviewService(db).reviewMissingSpecialists(panel.id, 'run-1');
    expect(updated.consensus.support_count).toBe(2);
    db.close();
  });
});

describe('autopilotFallbackSpec', () => {
  it('needs both a valid provider kind and a model', () => {
    expect(autopilotFallbackSpec({ SOCIAL_AUTOPILOT_FALLBACK_RUNTIME: 'openai-compatible', SOCIAL_AUTOPILOT_FALLBACK_MODEL: 'kimi-k2.6' })).toEqual({ runtime: 'openai-compatible', model: 'kimi-k2.6' });
    expect(autopilotFallbackSpec({ SOCIAL_AUTOPILOT_FALLBACK_RUNTIME: 'openai-compatible' })).toBeNull();
    expect(autopilotFallbackSpec({ SOCIAL_AUTOPILOT_FALLBACK_RUNTIME: 'nope', SOCIAL_AUTOPILOT_FALLBACK_MODEL: 'x' })).toBeNull();
    expect(autopilotFallbackSpec({})).toBeNull();
  });
});
