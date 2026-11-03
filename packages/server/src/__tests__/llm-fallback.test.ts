import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { generateText, isConnectivityFailure, isLlmEndpointDown, llmEndpoints, resetLlmBreaker, transportPurpose, type LlmEndpoint } from '../services/llm-fallback';
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
  it('adds a second, non-Ollama compat tier after the first (plan K3)', () => {
    const all = llmEndpoints('http://a', { LLM_FALLBACK_OPENAI_URL: 'https://ollama.com/v1', LLM_FALLBACK_MODEL: 'glm', LLM_FALLBACK2_OPENAI_URL: 'https://nv/v1', LLM_FALLBACK2_OPENAI_KEY: 'k2', LLM_FALLBACK2_MODEL: 'moonshotai/kimi-k3' });
    expect(all.map((e) => [e.baseUrl, e.apiKey, e.model])).toEqual([['http://a', undefined, undefined], ['https://ollama.com/v1', undefined, 'glm'], ['https://nv/v1', 'k2', 'moonshotai/kimi-k3']]);
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
describe('isConnectivityFailure', () => {
  it.each([
    ['fetch failed'],
    ['ECONNREFUSED'],
    ['ETIMEDOUT'],
    ['EHOSTUNREACH'],
    ['ENETUNREACH'],
    ['ENOTFOUND'],
    ['EAI_AGAIN'],
    ['aborted'],
    ['timed out'],
    ['timeout'],
    ['socket hang up'],
    ['HTTP 502'],
    ['HTTP 503'],
    ['HTTP 599'],
  ])('recognises %s as connectivity failure', (msg) => {
    expect(isConnectivityFailure(msg)).toBe(true);
  });
  it.each([
    ['model not found'],
    ['invalid request body'],
    ['Ollama request failed: 404'],
    ['OpenAI-compatible request failed: HTTP 401'],
    ['rate limited'],
    [''],
  ])('does NOT treat %s as connectivity failure', (msg) => {
    expect(isConnectivityFailure(msg)).toBe(false);
  });
});
describe('transportPurpose', () => {
  it('returns untagged:generateText when no purpose is given', () => {
    expect(transportPurpose({})).toBe('untagged:generateText');
  });
  it('prefixes with transport: when onUsage is present', () => {
    expect(transportPurpose({ purpose: 'panel:review', onUsage: () => {} })).toBe('transport:panel:review');
  });
  it('uses the bare purpose when there is no onUsage', () => {
    expect(transportPurpose({ purpose: 'refinement' })).toBe('refinement');
  });
});
describe('token counting in responses', () => {
  it('parses Ollama prompt_eval_count and eval_count into tokensIn/tokensOut via onUsage', async () => {
    const fetchFn = vi.fn(async () => json({ response: 'ok', prompt_eval_count: 42, eval_count: 7 }));
    const fn = vi.fn();
    await generateText({ ...opts, onUsage: fn }, { endpoints: [ollama('http://a')], fetchFn: fetchFn as never });
    expect(fn).toHaveBeenCalledWith({ tokensIn: 42, tokensOut: 7, provider: 'ollama:http://a', model: 'primary-model' });
  });
  it('returns null (not 0) when the provider omits token counts', async () => {
    const fetchFn = vi.fn(async () => json({ response: 'ok' }));
    const fn = vi.fn();
    await generateText({ ...opts, onUsage: fn }, { endpoints: [ollama('http://a')], fetchFn: fetchFn as never });
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ tokensIn: null, tokensOut: null }));
  });
  it('ignores non-numeric or non-finite token values', async () => {
    const fetchFn = vi.fn(async () => json({ response: 'ok', prompt_eval_count: 'many', eval_count: NaN }));
    const fn = vi.fn();
    await generateText({ ...opts, onUsage: fn }, { endpoints: [ollama('http://a')], fetchFn: fetchFn as never });
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ tokensIn: null, tokensOut: null }));
  });
});
describe('callEndpoint defaults', () => {
  it('uses temperature 0.2 and num_predict 1024 when not specified (Ollama)', async () => {
    let body: any;
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return json({ response: 'ok' }); });
    await generateText({ prompt: 'p', model: 'm', timeoutMs: 1000 }, { endpoints: [ollama('http://a')], fetchFn: fetchFn as never });
    expect(body.options.temperature).toBe(0.2);
    expect(body.options.num_predict).toBe(1024);
  });
  it('respects explicit temperature and maxTokens (Ollama)', async () => {
    let body: any;
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return json({ response: 'ok' }); });
    await generateText({ prompt: 'p', model: 'm', timeoutMs: 1000, temperature: 0.9, maxTokens: 512 }, { endpoints: [ollama('http://a')], fetchFn: fetchFn as never });
    expect(body.options.temperature).toBe(0.9);
    expect(body.options.num_predict).toBe(512);
  });
  it('uses temperature 0.2 and max_tokens 1024 when not specified (OpenAI)', async () => {
    let body: any;
    const ep = { id: 'openai:https://c/v1', kind: 'openai' as const, baseUrl: 'https://c/v1' };
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return json({ choices: [{ message: { content: 'ok' } }] }); });
    await generateText({ prompt: 'p', model: 'm', timeoutMs: 1000 }, { endpoints: [ep], fetchFn: fetchFn as never });
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(1024);
  });
});
describe('breaker expiry', () => {
  it('an endpoint marked down is no longer considered down after BREAKER_MS elapses', async () => {
    const t0 = 1_000_000;
    const fetchFn = vi.fn(async (url: string) => { if (String(url).startsWith('http://a')) throw new TypeError('fetch failed'); return json({ response: 'ok' }); });
    const endpoints = [ollama('http://a'), ollama('http://b')];
    await generateText(opts, { endpoints, fetchFn: fetchFn as never, now: () => t0 });
    expect(isLlmEndpointDown('ollama:http://a', t0)).toBe(true);
    expect(isLlmEndpointDown('ollama:http://a', t0 + 59_999)).toBe(true);
    expect(isLlmEndpointDown('ollama:http://a', t0 + 60_000)).toBe(false);
  });
});
describe('generateText ordering with multiple down endpoints', () => {
  it('tries healthy endpoints first, then down ones in original order', async () => {
    resetLlmBreaker();
    const t0 = 2_000_000;
    const failFetch = vi.fn(async (url: string) => { if (String(url).startsWith('http://a') || String(url).startsWith('http://c')) throw new TypeError('fetch failed'); return json({ response: 'ok' }); });
    await generateText(opts, { endpoints: [ollama('http://a'), ollama('http://b'), ollama('http://c')], fetchFn: failFetch as never, now: () => t0 });
    const calls: string[] = [];
    const secondFetch = vi.fn(async (url: string) => { calls.push(String(url)); return json({ response: 'ok' }); });
    await generateText(opts, { endpoints: [ollama('http://a'), ollama('http://b'), ollama('http://c')], fetchFn: secondFetch as never, now: () => t0 + 1 });
    expect(calls[0]).toBe('http://b/api/generate');
  });
});
describe('llmEndpoints edge cases', () => {
  it('trims whitespace from env values', () => {
    const all = llmEndpoints('http://a', { OLLAMA_FALLBACK_URL: '  http://b  ', LLM_FALLBACK_OPENAI_URL: '  https://c/v1  ' });
    expect(all.map((e) => e.baseUrl)).toEqual(['http://a', 'http://b', 'https://c/v1']);
  });
  it('strips trailing slash from OpenAI base URLs but not Ollama', () => {
    const all = llmEndpoints('http://a/', { OLLAMA_FALLBACK_URL: 'http://b/', LLM_FALLBACK_OPENAI_URL: 'https://c/v1/' });
    expect(all.map((e) => e.baseUrl)).toEqual(['http://a/', 'http://b/', 'https://c/v1']);
  });
  it('ignores empty-string fallback URLs after trim', () => {
    expect(llmEndpoints('http://a', { OLLAMA_FALLBACK_URL: '   ', LLM_FALLBACK_OPENAI_URL: '' })).toHaveLength(1);
  });
});
describe('error aggregation in generateText', () => {
  it('includes the endpoint id for non-primary failures but bare message for primary', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).startsWith('http://a')) throw new Error('primary-broken');
      throw new Error('secondary-broken');
    });
    await expect(generateText(opts, { endpoints: [ollama('http://a'), ollama('http://b')], fetchFn: fetchFn as never }))
      .rejects.toThrow('primary-broken (fallbacks also failed: ollama:http://b: secondary-broken)');
  });
  it('reports a single error without the fallback suffix when only one endpoint exists', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('only-one'); });
    await expect(generateText(opts, { endpoints: [ollama('http://a')], fetchFn: fetchFn as never }))
      .rejects.toThrow('only-one');
  });
});
