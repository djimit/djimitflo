/**
 * Social runtime providers — one small chat() over the model APIs the Agent
 * Commons autopilot may speak to: Ollama (local/workstation), Anthropic,
 * OpenAI, Gemini and any OpenAI-compatible endpoint (OpenRouter, LiteLLM).
 * Raw HTTP on purpose: one module, one shape, no per-provider SDK.
 * Every call is JSON-mode where the provider supports it and bounded by a timeout.
 *
 * CLI kinds (claude-cli, codex-cli, gemini-cli) run the locally installed subscription apps headless
 * (`claude -p`, `codex exec --json`, `gemini -p -o json`) so residents can speak through a seat instead of
 * an API key. The child gets no stdin, no tools, an ephemeral session and a bounded lifetime; for claude-cli
 * the Anthropic API key is stripped from the child env so the subscription login is used (SOCIAL_CLI_PREFER_SUBSCRIPTION=0 keeps it).
 */

import { spawn as nodeSpawn, spawnSync } from 'child_process';
import { tmpdir } from 'os';

export type ProviderKind = 'ollama' | 'anthropic' | 'openai' | 'gemini' | 'openai-compatible' | 'claude-cli' | 'codex-cli' | 'gemini-cli';
export type CliKind = Extract<ProviderKind, `${string}-cli`>;
export const CLI_KINDS: CliKind[] = ['claude-cli', 'codex-cli', 'gemini-cli'];
export interface RuntimeSpec { runtime: ProviderKind; model: string; maxOutputTokens?: number; think?: boolean }
export interface ChatResult { content: string; run_id: string; usage: Record<string, unknown> }
export interface ProviderEnv {
  ollamaUrl: string;
  anthropicApiKey: string;
  anthropicBaseUrl: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  geminiApiKey: string;
  geminiBaseUrl: string;
  compatibleApiKey: string;
  compatibleBaseUrl: string;
  /** Binaries for the subscription CLIs (CLAUDE_BIN_PATH, CODEX_BIN_PATH, GEMINI_BIN_PATH) and their working dir. */
  cliBins: Record<CliKind, string>;
  cliCwd: string;
  cliPreferSubscription: boolean;
}

export const PROVIDER_KINDS: ProviderKind[] = ['ollama', 'anthropic', 'openai', 'gemini', 'openai-compatible', ...CLI_KINDS];
export const DEFAULT_MODELS: Record<ProviderKind, string> = {
  ollama: 'qwen2.5:3b',
  anthropic: 'claude-opus-5',
  openai: 'gpt-5',
  gemini: 'gemini-2.5-flash',
  'openai-compatible': 'openai/gpt-5',
  'claude-cli': 'sonnet',
  'codex-cli': '', // empty = the CLI's configured default model
  'gemini-cli': 'gemini-2.5-flash',
};
const TIMEOUT_MS = 180_000;

export function providerEnvFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderEnv {
  const trimUrl = (value: string | undefined, fallback: string) => (value || fallback).replace(/\/+$/, '');
  return {
    ollamaUrl: trimUrl(env.OLLAMA_URL, 'http://127.0.0.1:11434'),
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    anthropicBaseUrl: trimUrl(env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com'),
    openaiApiKey: env.OPENAI_API_KEY || '',
    openaiBaseUrl: trimUrl(env.OPENAI_BASE_URL, 'https://api.openai.com/v1'),
    geminiApiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '',
    geminiBaseUrl: trimUrl(env.GEMINI_BASE_URL, 'https://generativelanguage.googleapis.com/v1beta'),
    // OpenRouter / LiteLLM / any OpenAI-compatible proxy.
    compatibleApiKey: env.SOCIAL_COMPAT_API_KEY || env.OPENROUTER_API_KEY || env.LITELLM_API_KEY || '',
    compatibleBaseUrl: trimUrl(env.SOCIAL_COMPAT_BASE_URL || (env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : env.LITELLM_URL), 'http://127.0.0.1:4000/v1'),
    cliBins: { 'claude-cli': env.CLAUDE_BIN_PATH || 'claude', 'codex-cli': env.CODEX_BIN_PATH || 'codex', 'gemini-cli': env.GEMINI_BIN_PATH || 'gemini' },
    cliCwd: env.SOCIAL_CLI_CWD || tmpdir(),
    cliPreferSubscription: (env.SOCIAL_CLI_PREFER_SUBSCRIPTION ?? '1') !== '0',
  };
}

const cliAvailability = new Map<string, boolean>();
/** A CLI counts as configured when its binary answers --version (cached per binary for the process lifetime). */
export function cliAvailable(bin: string, probe: typeof spawnSync = spawnSync): boolean {
  const cached = cliAvailability.get(bin);
  if (cached !== undefined) return cached;
  const result = probe(bin, ['--version'], { encoding: 'utf8', timeout: 3_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const ok = !result.error && result.status === 0;
  cliAvailability.set(bin, ok);
  return ok;
}

/** "anthropic:claude-opus-5" -> spec; a bare model name keeps the fallback runtime. */
export function parseRuntimeSpec(text: string | undefined, fallback: RuntimeSpec): RuntimeSpec {
  const value = (text || '').trim();
  if (!value) return fallback;
  const [head, ...rest] = value.split(':');
  const kind = head.trim().toLowerCase() as ProviderKind;
  if (rest.length && PROVIDER_KINDS.includes(kind)) return { runtime: kind, model: rest.join(':').trim() || DEFAULT_MODELS[kind] };
  return { runtime: fallback.runtime, model: value };
}

/** "commons-scout=anthropic:claude-opus-5,commons-muse=gemini:gemini-2.5-flash" -> per-agent specs. */
export function parseResidentRuntimes(text: string | undefined, fallback: RuntimeSpec): Map<string, RuntimeSpec> {
  const map = new Map<string, RuntimeSpec>();
  for (const entry of (text || '').split(',')) {
    const [id, spec] = entry.split('=');
    if (id?.trim() && spec?.trim()) map.set(id.trim(), parseRuntimeSpec(spec, fallback));
  }
  return map;
}

export function isRuntimeConfigured(spec: RuntimeSpec, env: ProviderEnv): boolean {
  switch (spec.runtime) {
    case 'ollama': return !!env.ollamaUrl;
    case 'anthropic': return !!env.anthropicApiKey;
    case 'openai': return !!env.openaiApiKey;
    case 'gemini': return !!env.geminiApiKey;
    case 'openai-compatible': return !!env.compatibleBaseUrl;
    case 'claude-cli': case 'codex-cli': case 'gemini-cli': return cliAvailable(env.cliBins[spec.runtime]);
    default: return false;
  }
}

export async function chat(spec: RuntimeSpec, env: ProviderEnv, system: string, prompt: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch, spawnImpl: typeof nodeSpawn = nodeSpawn): Promise<ChatResult> {
  const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  if (spec.runtime === 'claude-cli' || spec.runtime === 'codex-cli' || spec.runtime === 'gemini-cli') return chatCli(spec.runtime, spec.model, env, system, prompt, abort, spawnImpl);
  const post = async (url: string, headers: Record<string, string>, body: unknown) => {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: abort });
    if (!response.ok) {
      // Keep the provider's own reason (quota, invalid model, ...) but bounded; bodies never contain our credentials.
      let reason = '';
      try { const parsed = await response.json() as { error?: { message?: string } | string }; reason = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message || ''; } catch { /* non-JSON error body */ }
      throw new Error(`SOCIAL_RUNTIME_${spec.runtime.toUpperCase().replace('-', '_')}_HTTP_${response.status}${reason ? `: ${reason.slice(0, 160)}` : ''}`);
    }
    return response.json() as Promise<Record<string, any>>;
  };
  const numbers = (value: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(value || {}).filter(([, item]) => typeof item === 'number'));

  switch (spec.runtime) {
    case 'ollama': {
      const data = await post(`${env.ollamaUrl}/api/chat`, {}, {
        model: spec.model, stream: false, format: 'json', think: spec.think, options: { temperature: 0.7, num_predict: spec.maxOutputTokens ?? 700 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      });
      return { content: data.message?.content || '', run_id: data.created_at || '', usage: numbers({ prompt_eval_count: data.prompt_eval_count, eval_count: data.eval_count, total_duration: data.total_duration }) };
    }
    case 'anthropic': {
      // Messages API; thinking stays adaptive by default and the server-side fallback covers policy declines.
      const data = await post(`${env.anthropicBaseUrl}/v1/messages`, {
        'x-api-key': env.anthropicApiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01',
      }, {
        model: spec.model, max_tokens: 4096, fallbacks: 'default', system,
        messages: [{ role: 'user', content: prompt }],
      });
      if (data.stop_reason === 'refusal') throw new Error('SOCIAL_RUNTIME_ANTHROPIC_REFUSAL');
      const content = (data.content || []).filter((block: { type: string }) => block.type === 'text').map((block: { text: string }) => block.text).join('\n');
      return { content, run_id: data.id || '', usage: numbers(data.usage) };
    }
    case 'openai':
    case 'openai-compatible': {
      const base = spec.runtime === 'openai' ? env.openaiBaseUrl : env.compatibleBaseUrl;
      const key = spec.runtime === 'openai' ? env.openaiApiKey : env.compatibleApiKey;
      const data = await post(`${base}/chat/completions`, key ? { Authorization: `Bearer ${key}` } : {}, {
        model: spec.model, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      });
      const message = data.choices?.[0]?.message;
      const content = typeof message?.content === 'string' ? message.content : Array.isArray(message?.content) ? message.content.map((part: { text?: string }) => part.text || '').join('') : '';
      return { content, run_id: data.id || '', usage: numbers(data.usage) };
    }
    case 'gemini': {
      const data = await post(`${env.geminiBaseUrl}/models/${encodeURIComponent(spec.model)}:generateContent`, { 'x-goog-api-key': env.geminiApiKey }, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
      });
      const content = (data.candidates?.[0]?.content?.parts || []).map((part: { text?: string }) => part.text || '').join('');
      return { content, run_id: data.responseId || '', usage: numbers(data.usageMetadata) };
    }
    default:
      throw new Error('SOCIAL_RUNTIME_UNKNOWN');
  }
}

/** Headless argv per CLI. Codex and Gemini take no system flag, so the system text leads the prompt. */
export function cliArgs(kind: CliKind, model: string, system: string, prompt: string, cwd: string): string[] {
  const combined = `SYSTEM INSTRUCTIONS:\n${system}\n\nTASK:\n${prompt}`;
  switch (kind) {
    case 'claude-cli': return ['-p', prompt, '--output-format', 'json', '--bare', '--no-session-persistence', '--tools', '', '--system-prompt', system, ...(model ? ['--model', model] : [])];
    case 'codex-cli': return ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', cwd, ...(model ? ['-m', model] : []), combined];
    case 'gemini-cli': return ['-p', combined, '-o', 'json', ...(model ? ['-m', model] : [])];
  }
}

/** Parse what each CLI prints in JSON mode into one ChatResult; errors carry the CLI's own reason, bounded. */
export function parseCliOutput(kind: CliKind, stdout: string): ChatResult {
  const fail = (reason: string) => new Error(`SOCIAL_RUNTIME_${kind.toUpperCase().replace('-', '_')}_ERROR: ${reason.slice(0, 160)}`);
  const numbers = (value: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(value || {}).filter(([, item]) => typeof item === 'number'));
  if (kind === 'codex-cli') {
    // JSONL events: thread.started {thread_id}, item.completed {item:{type:'agent_message',text}}, turn.completed {usage}, error {message}.
    let content = '';
    let runId = '';
    let usage: Record<string, unknown> = {};
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim().startsWith('{')) continue;
      let event: Record<string, any>;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'thread.started' && event.thread_id) runId = String(event.thread_id);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') content = event.item.text;
      if (event.type === 'turn.completed' && event.usage) usage = numbers(event.usage);
      if (event.type === 'error' || event.type === 'turn.failed') throw fail(String(event.message || event.error?.message || 'turn failed'));
    }
    if (!content) throw fail('no agent_message in output');
    return { content, run_id: runId, usage };
  }
  const start = stdout.indexOf('{');
  if (start < 0) throw fail(stdout.trim() || 'empty output');
  let data: Record<string, any>;
  try { data = JSON.parse(stdout.slice(start)); } catch { throw fail('non-JSON output'); }
  if (kind === 'claude-cli') {
    // {type:'result', result, is_error, session_id, usage, total_cost_usd}
    if (data.is_error) throw fail(String(data.result || data.error || 'is_error'));
    return { content: typeof data.result === 'string' ? data.result : '', run_id: data.session_id || '', usage: { ...numbers(data.usage), total_cost_usd: Number(data.total_cost_usd) || 0 } };
  }
  // gemini -o json: {response, stats:{models:{<model>:{tokens:{...}}}}} or {error:{message}}
  if (data.error) throw fail(String(data.error.message || data.error));
  const model = Object.values((data.stats?.models || {}) as Record<string, { tokens?: Record<string, unknown> }>)[0];
  return { content: typeof data.response === 'string' ? data.response : '', run_id: data.session_id || '', usage: numbers(model?.tokens) };
}

async function chatCli(kind: CliKind, model: string, env: ProviderEnv, system: string, prompt: string, abort: AbortSignal, spawnImpl: typeof nodeSpawn): Promise<ChatResult> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (kind === 'claude-cli' && env.cliPreferSubscription) { delete childEnv.ANTHROPIC_API_KEY; delete childEnv.ANTHROPIC_AUTH_TOKEN; }
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawnImpl(env.cliBins[kind], cliArgs(kind, model, system, prompt, env.cliCwd), { cwd: env.cliCwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], signal: abort });
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { if (err.length < 4_000) err += chunk.toString(); });
    child.on('error', (error) => reject(new Error(`SOCIAL_RUNTIME_${kind.toUpperCase().replace('-', '_')}_SPAWN: ${error.message.slice(0, 160)}`)));
    child.on('close', (code) => {
      if (code === 0 || (kind === 'codex-cli' && out.includes('agent_message'))) return resolve(out);
      // A non-zero exit with JSON on stdout (claude prints {is_error, result}) carries the real reason; use it.
      try { parseCliOutput(kind, out); } catch (parsed) { if (out.trim().startsWith('{')) return reject(parsed); }
      reject(new Error(`SOCIAL_RUNTIME_${kind.toUpperCase().replace('-', '_')}_EXIT_${code}: ${(err.trim().split(/\r?\n/).find((line) => /error/i.test(line)) || err.trim() || out.trim()).slice(0, 160)}`));
    });
  });
  return parseCliOutput(kind, stdout);
}
