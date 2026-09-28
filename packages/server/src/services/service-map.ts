/**
 * Service map (operator 2026-09-28, replaces the /workstation-urls port scan that saw only the container's own namespace):
 * probes the endpoints this server is configured to use. URLs come only from the server's env — never from a request —
 * and no credentials are sent. Any HTTP answer = reachable (401/404 still means the service is there); 5xx = degraded;
 * timeout or connection error = down. Endpoints sharing a host:port are probed once. Cached for a minute.
 */
export interface ServiceStatus { names: string[]; endpoint: string; status: 'up' | 'degraded' | 'down'; http: number | null; ms: number | null; error: string | null }

const CANDIDATES: Array<[string, string, string]> = [ // [name, env var(s) '|'-separated, probe path]
  ['event bus', 'DJIMIT_EVENT_BUS_URL', '/'],
  ['agent registry', 'AGENT_REGISTRY_URL', '/'],
  ['Ollama (primary)', 'OLLAMA_URL', '/api/tags'],
  ['LiteLLM', 'LITELLM_BASE_URL|LITELLM_URL', '/'],
  ['Qdrant (read)', 'QDRANT_URL', '/healthz'],
  ['Qdrant (write)', 'QDRANT_WRITE_URL', '/healthz'],
  ['UAMS', 'UAMS_URL', '/'],
  ['Ollama Cloud', 'SOCIAL_COMPAT_BASE_URL|LLM_FALLBACK_OPENAI_URL', '/models'],
  ['NVIDIA API', 'LLM_FALLBACK2_OPENAI_URL', '/models'],
  ['TypeSafe (jev)', 'TYPESAFE_BASE_URL', '/'],
];
const DEFAULTS: Record<string, string> = { TYPESAFE_BASE_URL: 'https://api.typesafe.ai' };

/** host:port (+ path prefix) without credentials, for display and dedupe. */
export function displayEndpoint(url: string): string | null {
  try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}`; } catch { return null; }
}

export function serviceTargets(env: NodeJS.ProcessEnv = process.env): Array<{ names: string[]; endpoint: string; probe: string }> {
  const byEndpoint = new Map<string, { names: string[]; endpoint: string; probe: string }>();
  for (const [name, vars, path] of CANDIDATES) {
    const raw = vars.split('|').map((v) => env[v]?.trim() || DEFAULTS[v]).find(Boolean);
    const endpoint = raw ? displayEndpoint(raw) : null;
    if (!endpoint) continue;
    const existing = byEndpoint.get(endpoint);
    if (existing) { existing.names.push(name); continue; }
    byEndpoint.set(endpoint, { names: [name], endpoint, probe: `${endpoint}${path === '/' ? '' : path}` });
  }
  return [...byEndpoint.values()];
}

let cache: { at: number; result: ServiceStatus[] } | null = null;
export function resetServiceMapCache(): void { cache = null; }

export async function serviceMap(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<ServiceStatus[]> {
  if (cache && now - cache.at < 60_000) return cache.result;
  const result = await Promise.all(serviceTargets(env).map(async (t): Promise<ServiceStatus> => {
    const started = Date.now();
    try {
      const res = await fetchFn(t.probe, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(3_000) });
      return { names: t.names, endpoint: t.endpoint, status: res.status >= 500 ? 'degraded' : 'up', http: res.status, ms: Date.now() - started, error: null };
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string } };
      return { names: t.names, endpoint: t.endpoint, status: 'down', http: null, ms: null, error: e?.name === 'TimeoutError' ? 'timeout' : e?.cause?.code ?? 'unreachable' };
    }
  }));
  cache = { at: now, result };
  return result;
}
