/**
 * Service map (operator 2026-09-28, replaces the /workstation-urls port scan that saw only the container's own namespace):
 * probes the endpoints this server is configured to use. URLs come only from the server's env — never from a request —
 * and no credentials are sent. 2xx/3xx/401/403 = up (the service answered; auth is its business); 404 = 'reachable' only —
 * something listens, but not the path we probed, so it says nothing about health (prod 08-10: the event bus and agent
 * registry read 'up' on a 404 from '/'; both serve /health); 5xx = degraded; timeout or connection error = down.
 * Endpoints sharing a host:port are probed once. Cached for a minute.
 */
import type { Database } from 'better-sqlite3';
import { providerEnvFromEnv } from './social-runtime-providers';

/**
 * DF-07 (audit 2026-10-23): `status` is transport only. `state` is the integration ladder, each with the evidence that justified it:
 * CONFIGURED (endpoint set, the probe proved nothing: 3xx/4xx — a 404 is never more) → CONNECTED (probe 2xx) → HEALTHY (2xx and a
 * successful business operation in the last 24 h with no failure after it). DEGRADED = 5xx probe, or a business failure in the last
 * 24 h with no later success; FAILED = the probe got no HTTP answer; DISABLED = configured off (TypeSafe without a key). UNKNOWN is
 * what a reader shows for a row that carries no state (an older server). Business evidence is read from durable records only —
 * no extra probes, no tokens spent; `evidence_source` null means this integration has no such record, so its health is unknown.
 */
export type IntegrationState = 'CONFIGURED' | 'CONNECTED' | 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'DISABLED' | 'UNKNOWN';
export interface ServiceStatus {
  names: string[]; endpoint: string; status: 'up' | 'reachable' | 'degraded' | 'down'; http: number | null; ms: number | null; error: string | null;
  state: IntegrationState; state_evidence: string; last_success_at: string | null; last_failure_at: string | null; evidence_source: string | null;
}

const CANDIDATES: Array<[string, string, string]> = [ // [name, env var(s) '|'-separated, probe path]
  ['event bus', 'DJIMIT_EVENT_BUS_URL', '/health'],
  ['agent registry', 'AGENT_REGISTRY_URL', '/health'],
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

type Evidence = { url: string | undefined; source: string; ok_at: string | null; fail_at: string | null };
const origin = (url: string | undefined): string | null => { try { return url ? new URL(url).origin : null; } catch { return null; } };
const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v.includes('T') ? v : `${v.replace(' ', 'T')}Z`); // SQLite datetime('now') is UTC without a zone
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const later = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : a > b ? a : b);

/** Where a llm_model_calls row went, from its provider/consumer and this server's env; undefined = not attributable to an endpoint. */
function ledgerUrl(provider: string, consumer: string, env: NodeJS.ProcessEnv): string | undefined {
  if (/^(ollama|openai):/.test(provider)) return provider.slice(provider.indexOf(':') + 1); // llm-fallback endpoint ids carry the URL
  if (provider === 'ollama') return env.OLLAMA_URL; // council + resident 'ollama' runtime
  if (provider === 'typesafe') return env.TYPESAFE_BASE_URL || DEFAULTS.TYPESAFE_BASE_URL; // jev
  if (provider === 'nvidia') return env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'; // content_safety, proposal embeddings
  if (provider === 'openai-compatible') return providerEnvFromEnv(env).compatibleBaseUrl; // resident runtime
  if (consumer === 'council') return env.LITELLM_URL || 'http://192.168.1.28:4000'; // council: every non-ollama model goes via LiteLLM
  return undefined;
}

/** Last business success/failure per endpoint from the records the server already keeps (7-day lookback; never throws). */
function businessEvidence(db: Database, env: NodeJS.ProcessEnv, now: number): Evidence[] {
  const out: Evidence[] = [];
  const read = (fn: () => void) => { try { fn(); } catch { /* table absent on an old schema: no evidence, not an error */ } };
  const since = new Date(now - 7 * 86_400_000).toISOString();
  read(() => {
    // local throttling (breaker/queue) is the client refusing to call, not the provider failing
    const rows = db.prepare(`SELECT provider, consumer, MAX(CASE WHEN ok = 1 THEN created_at END) AS ok_at, MAX(CASE WHEN ok = 0 THEN created_at END) AS fail_at
      FROM llm_model_calls WHERE created_at >= ? AND provider IS NOT NULL AND COALESCE(status, '') NOT IN ('breaker_open', 'dropped_busy', 'queue_full')
      GROUP BY provider, consumer`).all(since) as Array<{ provider: string; consumer: string; ok_at: string | null; fail_at: string | null }>;
    for (const r of rows) out.push({ url: ledgerUrl(r.provider, r.consumer, env), source: 'llm_model_calls', ok_at: iso(r.ok_at), fail_at: iso(r.fail_at) });
  });
  const bus = env.DJIMIT_EVENT_BUS_URL;
  read(() => {
    // a failed row is still failed now, and its attempt came after its creation: created_at is a lower bound on the failure time
    const o = db.prepare(`SELECT MAX(CASE WHEN status = 'published' THEN published_at END) AS ok_at, MAX(CASE WHEN status = 'failed' THEN created_at END) AS fail_at
      FROM event_outbox`).get() as { ok_at: string | null; fail_at: string | null };
    out.push({ url: bus, source: 'event_outbox', ok_at: iso(o.ok_at), fail_at: iso(o.fail_at) });
  });
  read(() => {
    const c = db.prepare("SELECT MAX(updated_at) AS at FROM system_state WHERE key LIKE 'external_event_ingest_cursor:%'").get() as { at: string | null };
    out.push({ url: bus, source: 'event_outbox', ok_at: iso(c.at), fail_at: null }); // ingest cursor advanced = a successful consume
  });
  read(() => {
    const r = db.prepare('SELECT MAX(synced_at) AS at FROM registry_agents').get() as { at: string | null };
    out.push({ url: env.AGENT_REGISTRY_URL, source: 'registry_agents', ok_at: iso(r.at), fail_at: null });
  });
  return out;
}

const WINDOW_MS = 24 * 3_600_000;
/** The ladder: transport rung from the probe, then business evidence can lower it (DEGRADED) or, on a 2xx only, raise it (HEALTHY). */
export function integrationState(probe: { http: number | null; error: string | null }, ev: { source: string | null; ok_at: string | null; fail_at: string | null },
  now: number, disabled: string | null = null): { state: IntegrationState; state_evidence: string } {
  if (disabled) return { state: 'DISABLED', state_evidence: disabled };
  const recent = (at: string | null) => at !== null && now - Date.parse(at) <= WINDOW_MS;
  const failedLast = ev.fail_at !== null && (ev.ok_at === null || ev.fail_at > ev.ok_at);
  const transport = probe.http === null ? `probe failed (${probe.error ?? 'unreachable'})` : `probe HTTP ${probe.http}`;
  const business = !ev.source ? 'no durable business evidence: business health UNKNOWN'
    : failedLast ? `last business failure ${ev.fail_at}${ev.ok_at ? `, last success ${ev.ok_at}` : ', no success in 7 d'} (${ev.source})`
      : ev.ok_at ? `last business success ${ev.ok_at} (${ev.source})` : `no business operation in 7 d (${ev.source})`;
  const evidence = `${transport}; ${business}`;
  if (probe.http === null) return { state: 'FAILED', state_evidence: evidence };
  if (probe.http >= 500 || (failedLast && recent(ev.fail_at))) return { state: 'DEGRADED', state_evidence: evidence };
  if (probe.http < 200 || probe.http >= 300) return { state: 'CONFIGURED', state_evidence: evidence };
  return { state: !failedLast && recent(ev.ok_at) ? 'HEALTHY' : 'CONNECTED', state_evidence: evidence };
}

export async function serviceMap(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch, now = Date.now(), db: Database | null = null): Promise<ServiceStatus[]> {
  if (cache && now - cache.at < 60_000) return cache.result;
  const evidence = db ? businessEvidence(db, env, now) : [];
  // which integrations have an evidence source at all (even with no rows yet), by the names that feed them
  const sourceFor = (names: string[]): string | null => (names.includes('event bus') ? 'event_outbox' : names.includes('agent registry') ? 'registry_agents'
    : names.some((n) => /Ollama|LiteLLM|NVIDIA|TypeSafe/.test(n)) ? 'llm_model_calls' : null);
  const result = await Promise.all(serviceTargets(env).map(async (t): Promise<ServiceStatus> => {
    const at = origin(t.endpoint);
    const mine = evidence.filter((e) => at !== null && origin(e.url) === at);
    const ev = { source: db ? sourceFor(t.names) : null, ok_at: mine.reduce<string | null>((m, e) => later(m, e.ok_at), null), fail_at: mine.reduce<string | null>((m, e) => later(m, e.fail_at), null) };
    const disabled = t.names.includes('TypeSafe (jev)') && t.names.length === 1 && !env.TYPESAFE_API_KEY?.trim() ? 'TYPESAFE_API_KEY not set: jev is off' : null;
    const started = Date.now();
    let probe: Pick<ServiceStatus, 'status' | 'http' | 'ms' | 'error'>;
    try {
      const res = await fetchFn(t.probe, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(3_000) });
      probe = { status: res.status >= 500 ? 'degraded' : res.status === 404 ? 'reachable' : 'up', http: res.status, ms: Date.now() - started, error: null };
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string } };
      probe = { status: 'down', http: null, ms: null, error: e?.name === 'TimeoutError' ? 'timeout' : e?.cause?.code ?? 'unreachable' };
    }
    return { names: t.names, endpoint: t.endpoint, ...probe, ...integrationState(probe, ev, now, disabled), last_success_at: ev.ok_at, last_failure_at: ev.fail_at, evidence_source: ev.source };
  }));
  cache = { at: now, result };
  return result;
}
