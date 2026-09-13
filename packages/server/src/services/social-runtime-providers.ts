/**
 * Social runtime providers — one small chat() over the model APIs the Agent
 * Commons autopilot may speak to: Ollama (local/workstation), Anthropic,
 * OpenAI, Gemini and any OpenAI-compatible endpoint (OpenRouter, LiteLLM).
 * Raw HTTP on purpose: one module, one shape, no per-provider SDK.
 * Every call is JSON-mode where the provider supports it and bounded by a timeout.
 */

export type ProviderKind = 'ollama' | 'anthropic' | 'openai' | 'gemini' | 'openai-compatible';
export interface RuntimeSpec { runtime: ProviderKind; model: string }
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
}

export const PROVIDER_KINDS: ProviderKind[] = ['ollama', 'anthropic', 'openai', 'gemini', 'openai-compatible'];
export const DEFAULT_MODELS: Record<ProviderKind, string> = {
  ollama: 'qwen2.5:3b',
  anthropic: 'claude-opus-5',
  openai: 'gpt-5',
  gemini: 'gemini-2.5-flash',
  'openai-compatible': 'openai/gpt-5',
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
  };
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
    default: return false;
  }
}

export async function chat(spec: RuntimeSpec, env: ProviderEnv, system: string, prompt: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<ChatResult> {
  const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
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
        model: spec.model, stream: false, format: 'json', options: { temperature: 0.7, num_predict: 700 },
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
