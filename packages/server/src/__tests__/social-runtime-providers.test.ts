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

  it('disables hidden thinking on Ollama and honours a caller-supplied output budget', async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    await chat({ runtime: 'ollama', model: 'qwen3.5:cloud' }, env, 'sys', 'ask', undefined, fakeFetch({ message: { content: '{}' } }, capture), undefined, { maxTokens: 4096 });
    const body = JSON.parse(String(capture.init?.body));
    expect(body.think).toBe(false);
    expect(body.options.num_predict).toBe(4096);
    await chat({ runtime: 'ollama', model: 'qwen2.5:3b' }, env, 'sys', 'ask', undefined, fakeFetch({ message: { content: '{}' } }, capture));
    expect(JSON.parse(String(capture.init?.body)).options.num_predict).toBe(700);
  });

  it('surfaces HTTP failures with the provider name', async () => {
    const failing = (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch;
    await expect(chat({ runtime: 'ollama', model: 'm' }, env, 's', 'p', undefined, failing)).rejects.toThrow('SOCIAL_RUNTIME_OLLAMA_HTTP_429');
  });
});

describe('subscription CLI runtimes (claude-cli, codex-cli, gemini-cli)', async () => {
  const { CLI_KINDS, PROVIDER_KINDS, cliArgs, cliAvailable, parseCliOutput } = await import('../services/social-runtime-providers');
  const { EventEmitter } = await import('events');

  function fakeSpawn(stdout: string, code = 0, capture: { bin?: string; args?: string[]; env?: NodeJS.ProcessEnv } = {}) {
    return ((bin: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      capture.bin = bin; capture.args = args; capture.env = options.env;
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      setImmediate(() => { child.stdout.emit('data', Buffer.from(stdout)); child.emit('close', code); });
      return child;
    }) as unknown as typeof import('child_process').spawn;
  }

  it('is a provider kind with headless, tool-free, ephemeral argv per CLI', () => {
    expect(PROVIDER_KINDS).toEqual(expect.arrayContaining(CLI_KINDS));
    expect(parseRuntimeSpec('codex-cli:', { runtime: 'ollama', model: 'x' })).toEqual({ runtime: 'codex-cli', model: '' });
    expect(cliArgs('claude-cli', 'sonnet', 'SYS', 'ASK', '/w')).toEqual(['-p', 'ASK', '--output-format', 'json', '--bare', '--no-session-persistence', '--tools', '', '--system-prompt', 'SYS', '--model', 'sonnet']);
    expect(cliArgs('codex-cli', '', 'SYS', 'ASK', '/w')).toEqual(['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', '/w', 'SYSTEM INSTRUCTIONS:\nSYS\n\nTASK:\nASK']);
    expect(cliArgs('gemini-cli', 'gemini-2.5-flash', 'SYS', 'ASK', '/w')).toEqual(['-p', 'SYSTEM INSTRUCTIONS:\nSYS\n\nTASK:\nASK', '-o', 'json', '-m', 'gemini-2.5-flash']);
    const probe = ((bin: string) => ({ status: bin === 'present' ? 0 : 1, error: bin === 'missing' ? new Error('ENOENT') : undefined })) as unknown as typeof import('child_process').spawnSync;
    expect(cliAvailable('present', probe)).toBe(true);
    expect(cliAvailable('missing', probe)).toBe(false);
  });

  it('parses the real output shapes of each CLI and surfaces their errors', () => {
    const codex = ['{"type":"thread.started","thread_id":"t-1"}', '{"type":"item.completed","item":{"type":"error","message":"mcp auth"}}', '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}', '{"type":"turn.completed","usage":{"input_tokens":25,"output_tokens":14}}'].join('\n');
    expect(parseCliOutput('codex-cli', codex)).toEqual({ content: '{"ok":true}', run_id: 't-1', usage: { input_tokens: 25, output_tokens: 14 } });
    expect(() => parseCliOutput('codex-cli', '{"type":"turn.started"}')).toThrow('SOCIAL_RUNTIME_CODEX_CLI_ERROR: no agent_message');
    const claude = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"ok":true}', session_id: 's-1', total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 5, iterations: [] } });
    expect(parseCliOutput('claude-cli', claude)).toEqual({ content: '{"ok":true}', run_id: 's-1', usage: { input_tokens: 3, output_tokens: 5, total_cost_usd: 0.01 } });
    expect(() => parseCliOutput('claude-cli', JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }))).toThrow('SOCIAL_RUNTIME_CLAUDE_CLI_ERROR: Not logged in');
    expect(() => parseCliOutput('claude-cli', JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 400 You have reached your specified API usage limits.' }))).toThrow('usage limits');
    const gemini = JSON.stringify({ response: '{"ok":true}', stats: { models: { 'gemini-2.5-flash': { tokens: { prompt: 10, candidates: 4, total: 14 } } } } });
    expect(parseCliOutput('gemini-cli', gemini)).toEqual({ content: '{"ok":true}', run_id: '', usage: { prompt: 10, candidates: 4, total: 14 } });
    expect(() => parseCliOutput('gemini-cli', JSON.stringify({ error: { message: 'IneligibleTierError' } }))).toThrow('IneligibleTierError');
  });

  it('runs the CLI without stdin or the Anthropic API key so the subscription seat answers', async () => {
    const capture: { bin?: string; args?: string[]; env?: NodeJS.ProcessEnv } = {};
    const cliEnv = providerEnvFromEnv({ CLAUDE_BIN_PATH: '/opt/claude', SOCIAL_CLI_CWD: '/tmp/commons' });
    process.env.ANTHROPIC_API_KEY = 'must-not-leak';
    const stdout = JSON.stringify({ type: 'result', is_error: false, result: '{"reply":"hi"}', session_id: 's-9', usage: { output_tokens: 2 } });
    const result = await chat({ runtime: 'claude-cli', model: 'sonnet' }, cliEnv, 'SYS', 'ASK', undefined, fetch, fakeSpawn(stdout, 0, capture));
    expect(result).toEqual({ content: '{"reply":"hi"}', run_id: 's-9', usage: { output_tokens: 2, total_cost_usd: 0 } });
    expect(capture.bin).toBe('/opt/claude');
    expect(capture.args).toContain('--no-session-persistence');
    expect(capture.env?.ANTHROPIC_API_KEY).toBeUndefined();
    delete process.env.ANTHROPIC_API_KEY;
    await expect(chat({ runtime: 'codex-cli', model: '' }, cliEnv, 'SYS', 'ASK', undefined, fetch, fakeSpawn('', 2))).rejects.toThrow('SOCIAL_RUNTIME_CODEX_CLI_EXIT_2');
  });
});
