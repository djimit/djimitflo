/**
 * Model calls with failover. Until now every call site had one hard-wired host: when the workstation that runs Ollama
 * (100.77.58.72) went offline, the specialist panel, refinement and the Commons residents all stopped (3 outages on
 * 2026-09-21). Endpoints come from the environment; with nothing configured besides the primary, behaviour is unchanged.
 *
 *   primary        OLLAMA_URL                       (caller supplies it)
 *   2nd Ollama     OLLAMA_FALLBACK_URL              (+ OLLAMA_FALLBACK_MODEL if the model name differs)
 *   OpenAI-compat  LLM_FALLBACK_OPENAI_URL          (+ LLM_FALLBACK_OPENAI_KEY, LLM_FALLBACK_MODEL)
 *
 * A host that fails at the connection level is marked down for a minute: healthy endpoints are tried first, down ones
 * last (never skipped, so a total outage still surfaces the primary's own error message).
 */

export interface LlmEndpoint { id: string; kind: 'ollama' | 'openai'; baseUrl: string; apiKey?: string; model?: string }

export interface GenerateOptions { prompt: string; model: string; temperature?: number; maxTokens?: number; timeoutMs: number }

const BREAKER_MS = 60_000;
const downUntil = new Map<string, number>();

export function resetLlmBreaker(): void { downUntil.clear(); }
export function isLlmEndpointDown(id: string, now = Date.now()): boolean { return (downUntil.get(id) ?? 0) > now; }

export function llmEndpoints(primaryOllamaUrl: string, env: NodeJS.ProcessEnv = process.env): LlmEndpoint[] {
  const endpoints: LlmEndpoint[] = [{ id: `ollama:${primaryOllamaUrl}`, kind: 'ollama', baseUrl: primaryOllamaUrl }];
  const second = env.OLLAMA_FALLBACK_URL?.trim();
  if (second && second !== primaryOllamaUrl) endpoints.push({ id: `ollama:${second}`, kind: 'ollama', baseUrl: second, model: env.OLLAMA_FALLBACK_MODEL?.trim() || undefined });
  const compat = env.LLM_FALLBACK_OPENAI_URL?.trim();
  if (compat) endpoints.push({ id: `openai:${compat}`, kind: 'openai', baseUrl: compat.replace(/\/$/, ''), apiKey: env.LLM_FALLBACK_OPENAI_KEY?.trim() || undefined, model: env.LLM_FALLBACK_MODEL?.trim() || undefined });
  return endpoints;
}

/** Connection-level failure (host down, timeout, 5xx): says nothing about the request, so the host is avoided for a while. */
export function isConnectivityFailure(message: string): boolean {
  return /fetch failed|ECONN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|aborted|timed? ?out|socket hang up|HTTP 5\d\d/i.test(message);
}

async function callEndpoint(endpoint: LlmEndpoint, options: GenerateOptions, fetchFn: typeof fetch): Promise<string> {
  const model = endpoint.model || options.model;
  const signal = AbortSignal.timeout(options.timeoutMs);
  if (endpoint.kind === 'ollama') {
    const response = await fetchFn(`${endpoint.baseUrl}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      // think:false — reasoning models otherwise burn num_predict on a hidden trace and return no JSON.
      body: JSON.stringify({ model, prompt: options.prompt, stream: false, format: 'json', think: false, options: { temperature: options.temperature ?? 0.2, num_predict: options.maxTokens ?? 1024 } }),
    });
    if (!response.ok) throw new Error(`Ollama request failed: ${response.status}`);
    return ((await response.json()) as { response?: string }).response || '';
  }
  const response = await fetchFn(`${endpoint.baseUrl}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: options.prompt }], response_format: { type: 'json_object' }, temperature: options.temperature ?? 0.2, max_tokens: options.maxTokens ?? 1024 }),
  });
  if (!response.ok) throw new Error(`OpenAI-compatible request failed: HTTP ${response.status}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content || '';
}

export async function generateText(
  options: GenerateOptions,
  deps: { endpoints: LlmEndpoint[]; fetchFn?: typeof fetch; now?: () => number },
): Promise<string> {
  const now = deps.now ?? Date.now;
  const fetchFn = deps.fetchFn ?? fetch;
  const ordered = [...deps.endpoints].sort((a, b) => Number(isLlmEndpointDown(a.id, now())) - Number(isLlmEndpointDown(b.id, now())));
  const errors: string[] = [];
  for (const endpoint of ordered) {
    try {
      const text = await callEndpoint(endpoint, options, fetchFn);
      downUntil.delete(endpoint.id);
      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(endpoint === deps.endpoints[0] ? message : `${endpoint.id}: ${message}`);
      if (isConnectivityFailure(message)) downUntil.set(endpoint.id, now() + BREAKER_MS);
    }
  }
  // Report the primary's own error first so callers' error classification keeps working.
  const primaryIndex = errors.findIndex((_, i) => ordered[i] === deps.endpoints[0]);
  throw new Error(errors[primaryIndex >= 0 ? primaryIndex : 0] + (errors.length > 1 ? ` (fallbacks also failed: ${errors.filter((_, i) => i !== primaryIndex).join('; ')})` : ''));
}
