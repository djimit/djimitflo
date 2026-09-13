import { describe, expect, it } from 'vitest';
import { chat, DEFAULT_MODELS, isRuntimeConfigured, parseResidentRuntimes, parseRuntimeSpec, providerEnvFromEnv } from '../services/social-runtime-providers';

const env = providerEnvFromEnv({
  OLLAMA_URL: 'http://ollama.test/', ANTHROPIC_API_KEY: 'a-key', OPENAI_API_KEY: 'o-key', GEMINI_API_KEY: 'g-key', OPENROUTER_API_KEY: 'r-key',
});

function fakeFetch(body: unknown, capture: { url?: string; init?: RequestInit } = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = String(url);
    capture.init = init;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

describe('social runtime providers', () => {
  it('parses runtime specs and per-resident overrides', () => {
    const fallback = { runtime: 'ollama' as const, model: 'qwen2.5:3b' };
    expect(parseRuntimeSpec('anthropic:claude-opus-5', fallback)).toEqual({ runtime: 'anthropic', model: 'claude-opus-5' });
    expect(parseRuntimeSpec('anthropic', fallback)).toEqual({ runtime: 'ollama', model: 'anthropic' });
    expect(parseRuntimeSpec('ollama:qwen2.5:14b', fallback)).toEqual({ runtime: 'ollama', model: 'qwen2.5:14b' });
    expect(parseRuntimeSpec('gemini:', fallback)).toEqual({ runtime: 'gemini', model: DEFAULT_MODELS.gemini });
    const residents = parseResidentRuntimes('commons-scout=anthropic:claude-opus-5, commons-muse=gemini:gemini-2.5-flash,broken', fallback);
    expect([...residents.entries()]).toEqual([
      ['commons-scout', { runtime: 'anthropic', model: 'claude-opus-5' }],
      ['commons-muse', { runtime: 'gemini', model: 'gemini-2.5-flash' }],
    ]);
  });

  it('knows which runtimes have credentials', () => {
    expect(isRuntimeConfigured({ runtime: 'anthropic', model: 'x' }, env)).toBe(true);
    expect(isRuntimeConfigured({ runtime: 'anthropic', model: 'x' }, providerEnvFromEnv({}))).toBe(false);
    expect(env.compatibleBaseUrl).toBe('https://openrouter.ai/api/v1');
    expect(env.ollamaUrl).toBe('http://ollama.test');
  });

  it('shapes the Anthropic Messages request and reads text blocks and usage', async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const result = await chat({ runtime: 'anthropic', model: 'claude-opus-5' }, env, 'sys', 'hi', undefined,
      fakeFetch({ id: 'msg_1', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"answer":"a"}' }], usage: { input_tokens: 10, output_tokens: 5 } }, capture));
    expect(capture.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = capture.init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('a-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(capture.init?.body));
    expect(body).toMatchObject({ model: 'claude-opus-5', system: 'sys', fallbacks: 'default', messages: [{ role: 'user', content: 'hi' }] });
    expect(body.thinking).toBeUndefined();
    expect(result).toEqual({ content: '{"answer":"a"}', run_id: 'msg_1', usage: { input_tokens: 10, output_tokens: 5 } });
  });

  it('treats an Anthropic refusal as a failure instead of a reply', async () => {
    await expect(chat({ runtime: 'anthropic', model: 'claude-opus-5' }, env, 'sys', 'hi', undefined,
      fakeFetch({ id: 'msg_2', stop_reason: 'refusal', content: [], usage: {} }))).rejects.toThrow('SOCIAL_RUNTIME_ANTHROPIC_REFUSAL');
  });

  it('uses JSON mode for OpenAI-style and Gemini endpoints', async () => {
    const openai: { url?: string; init?: RequestInit } = {};
    const viaOpenai = await chat({ runtime: 'openai', model: 'gpt-5' }, env, 'sys', 'hi', undefined,
      fakeFetch({ id: 'chatcmpl-1', choices: [{ message: { content: '{"answer":"o"}' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }, openai));
    expect(openai.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(String(openai.init?.body)).response_format).toEqual({ type: 'json_object' });
    expect((openai.init?.headers as Record<string, string>).Authorization).toBe('Bearer o-key');
    expect(viaOpenai.content).toBe('{"answer":"o"}');

    const compat: { url?: string; init?: RequestInit } = {};
    await chat({ runtime: 'openai-compatible', model: 'openai/gpt-5' }, env, 'sys', 'hi', undefined, fakeFetch({ choices: [{ message: { content: '{}' } }] }, compat));
    expect(compat.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((compat.init?.headers as Record<string, string>).Authorization).toBe('Bearer r-key');

    const gemini: { url?: string; init?: RequestInit } = {};
    const viaGemini = await chat({ runtime: 'gemini', model: 'gemini-2.5-flash' }, env, 'sys', 'hi', undefined,
      fakeFetch({ responseId: 'r1', candidates: [{ content: { parts: [{ text: '{"answer":"g"}' }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3 } }, gemini));
    expect(gemini.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect((gemini.init?.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
    expect(JSON.parse(String(gemini.init?.body)).generationConfig.responseMimeType).toBe('application/json');
    expect(viaGemini).toEqual({ content: '{"answer":"g"}', run_id: 'r1', usage: { promptTokenCount: 4, candidatesTokenCount: 3 } });
  });

  it('surfaces HTTP failures with the provider name', async () => {
    const failing = (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch;
    await expect(chat({ runtime: 'ollama', model: 'm' }, env, 's', 'p', undefined, failing)).rejects.toThrow('SOCIAL_RUNTIME_OLLAMA_HTTP_429');
  });
});
