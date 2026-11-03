import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { displayEndpoint, resetServiceMapCache, serviceMap, serviceTargets } from '../services/service-map';

beforeEach(() => resetServiceMapCache());

it('builds targets from env only, strips credentials and probes a shared host once', () => {
  const t = serviceTargets({ OLLAMA_URL: 'http://100.77.58.72:11434', LITELLM_BASE_URL: 'http://100.77.58.72:11434', QDRANT_URL: 'http://user:pw@10.0.0.1:6333/' });
  expect(t.find((x) => x.endpoint === 'http://100.77.58.72:11434')?.names).toEqual(['Ollama (primary)', 'LiteLLM']);
  expect(t.find((x) => x.names[0] === 'Qdrant (read)')).toEqual({ names: ['Qdrant (read)'], endpoint: 'http://10.0.0.1:6333', probe: 'http://10.0.0.1:6333/healthz' });
  expect(t.some((x) => x.names.includes('TypeSafe (jev)'))).toBe(true); // default endpoint
  expect(displayEndpoint('not a url')).toBeNull();
});

it('displayEndpoint strips only the trailing slash and keeps internal path segments', () => {
  expect(displayEndpoint('http://h/a/b')).toBe('http://h/a/b');
  expect(displayEndpoint('http://h/a/b/')).toBe('http://h/a/b');
  expect(displayEndpoint('https://x:9/p')).toBe('https://x:9/p');
});

it('trims whitespace from env values before parsing', () => {
  const t = serviceTargets({ OLLAMA_URL: '  http://h:1234  ' });
  expect(t.find((x) => x.names[0] === 'Ollama (primary)')?.endpoint).toBe('http://h:1234');
});

it('uses a bare endpoint (no trailing slash) for "/" probe paths', () => {
  const t = serviceTargets({ UAMS_URL: 'http://u:8000/' });
  expect(t.find((x) => x.names[0] === 'UAMS')?.probe).toBe('http://u:8000');
});

it('honest status: event bus and agent registry are probed on /health; a 404 is "reachable", never "up" (prod 2026-10-08)', async () => {
  const t = serviceTargets({ DJIMIT_EVENT_BUS_URL: 'http://bus:8083', AGENT_REGISTRY_URL: 'http://reg:8088/' });
  expect(t.slice(0, 2).map((x) => x.probe)).toEqual(['http://bus:8083/health', 'http://reg:8088/health']);
  const fetchFn = vi.fn(async (url: string) => new Response('', { status: url.includes('8083') ? 200 : 404 }));
  const r = await serviceMap({ DJIMIT_EVENT_BUS_URL: 'http://bus:8083', UAMS_URL: 'http://u:8000' }, fetchFn as never, 1_000);
  const by = Object.fromEntries(r.map((s) => [s.names[0], s]));
  expect(by['event bus']).toMatchObject({ status: 'up', http: 200 });
  expect(by.UAMS).toMatchObject({ status: 'reachable', http: 404 });
});

it('classifies any HTTP answer as up, 5xx as degraded, errors as down, sends no credentials and caches for a minute', async () => {
  const fetchFn = vi.fn(async (url: string) => {
    if (url.includes('6333')) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return new Response('', { status: url.includes('8083') ? 503 : 401 });
  });
  const env = { DJIMIT_EVENT_BUS_URL: 'http://bus:8083', QDRANT_URL: 'http://q:6333', UAMS_URL: 'http://u:8000', TYPESAFE_BASE_URL: 'http://ts' };
  const r = await serviceMap(env, fetchFn as never, 1_000);
  const by = Object.fromEntries(r.map((s) => [s.names[0], s]));
  expect(by['event bus']).toMatchObject({ status: 'degraded', http: 503 });
  expect(by.UAMS).toMatchObject({ status: 'up', http: 401 });
  expect(by['Qdrant (read)']).toMatchObject({ status: 'down', http: null, error: 'ECONNREFUSED' });
  for (const [, init] of fetchFn.mock.calls as unknown as Array<[string, RequestInit]>) expect(init.headers).toBeUndefined();
  await serviceMap(env, fetchFn as never, 30_000);
  expect(fetchFn).toHaveBeenCalledTimes(4);
});

it('treats status 500 as degraded (boundary)', async () => {
  const fetchFn = vi.fn(async () => new Response('', { status: 500 }));
  const env = { UAMS_URL: 'http://u:8000' };
  const r = await serviceMap(env, fetchFn as never, 1_000);
  expect(r[0]).toMatchObject({ status: 'degraded', http: 500 });
});

it('records a small, non-negative latency', async () => {
  const fetchFn = vi.fn(async () => new Response('', { status: 200 }));
  const env = { UAMS_URL: 'http://u:8000' };
  const r = await serviceMap(env, fetchFn as never, 1_000);
  expect(typeof r[0].ms).toBe('number');
  expect(r[0].ms!).toBeGreaterThanOrEqual(0);
  expect(r[0].ms!).toBeLessThan(10_000);
});

it('reports "timeout" for TimeoutError-named errors', async () => {
  const fetchFn = vi.fn(async () => {
    const e = new Error('timed out'); e.name = 'TimeoutError'; throw e;
  });
  const env = { UAMS_URL: 'http://u:8000' };
  const r = await serviceMap(env, fetchFn as never, 1_000);
  expect(r[0]).toMatchObject({ status: 'down', error: 'timeout' });
});

it('reports "unreachable" when the thrown value is null', async () => {
  const fetchFn = vi.fn(async () => { throw null; });
  const env = { UAMS_URL: 'http://u:8000' };
  const r = await serviceMap(env, fetchFn as never, 1_000);
  expect(r[0]).toMatchObject({ status: 'down', error: 'unreachable' });
});

it('reports "unreachable" when cause is null', async () => {
  const fetchFn = vi.fn(async () => { throw { cause: null }; });
  const env = { UAMS_URL: 'http://u:8000' };
  const r = await serviceMap(env, fetchFn as never, 1_000);
  expect(r[0]).toMatchObject({ status: 'down', error: 'unreachable' });
});

it('resetServiceMapCache clears the cache so the next call re-fetches', async () => {
  const fetchFn = vi.fn(async () => new Response('', { status: 200 }));
  const env = { UAMS_URL: 'http://u:8000', TYPESAFE_BASE_URL: 'http://u:8000' };
  await serviceMap(env, fetchFn as never, 1_000);
  resetServiceMapCache();
  await serviceMap(env, fetchFn as never, 2_000);
  expect(fetchFn).toHaveBeenCalledTimes(2);
});

it('re-fetches when the cache is older than 60s (exclusive boundary)', async () => {
  const fetchFn = vi.fn(async () => new Response('', { status: 200 }));
  const env = { UAMS_URL: 'http://u:8000', TYPESAFE_BASE_URL: 'http://u:8000' };
  await serviceMap(env, fetchFn as never, 1_000);
  await serviceMap(env, fetchFn as never, 61_001);
  expect(fetchFn).toHaveBeenCalledTimes(2);
});

it('serves the cache at exactly 60s minus delta and re-fetches past the boundary', async () => {
  const fetchFn = vi.fn(async () => new Response('', { status: 200 }));
  const env = { UAMS_URL: 'http://u:8000', TYPESAFE_BASE_URL: 'http://u:8000' };
  await serviceMap(env, fetchFn as never, 1_000);
  await serviceMap(env, fetchFn as never, 60_000);
  expect(fetchFn).toHaveBeenCalledTimes(1);
});
// DF-07 (audit 2026-10-23, E-configuration-integration-audit): transport reachability is not health. One state vocabulary
// per integration, justified by durable business evidence (llm_model_calls, event_outbox, registry_agents), never by a probe alone.
describe('DF-07 integration state ladder', () => {
  const NOW = Date.parse('2026-10-23T12:00:00Z');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const H = 3_600_000;
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); });
  afterEach(() => db.close());
  const call = (provider: string, ok: boolean, at: string, consumer = 'fallback', status: string | null = ok ? 'ok' : 'timeout') =>
    db.prepare(`INSERT INTO llm_model_calls (consumer, model, ok, latency_ms, out_chars, shadow, provider, status, created_at) VALUES (?, 'm', ?, 10, 0, 0, ?, ?, ?)`)
      .run(consumer, ok ? 1 : 0, provider, status, at);
  const probe = (codes: Record<string, number>) => vi.fn(async (url: string) => new Response('', { status: Object.entries(codes).find(([k]) => url.includes(k))?.[1] ?? 200 }));
  const map = async (env: NodeJS.ProcessEnv, fetchFn: ReturnType<typeof probe>) =>
    Object.fromEntries((await serviceMap(env, fetchFn as never, NOW, db)).map((s) => [s.names[0], s]));

  it('a 404 probe is never HEALTHY, even with a recent successful business call', async () => {
    call('typesafe', true, ago(60_000), 'jev');
    const by = await map({ TYPESAFE_BASE_URL: 'https://api.typesafe.ai', TYPESAFE_API_KEY: 'k' }, probe({ typesafe: 404 }));
    expect(by['TypeSafe (jev)']).toMatchObject({ status: 'reachable', http: 404, last_success_at: ago(60_000) });
    expect(by['TypeSafe (jev)'].state).not.toBe('HEALTHY');
    expect(by['TypeSafe (jev)'].state).not.toBe('CONNECTED');
    expect(by['TypeSafe (jev)'].state_evidence).toContain('404');
  });

  it('a 200 probe without business success is CONNECTED only, and says why it is not HEALTHY', async () => {
    const by = await map({ QDRANT_URL: 'http://q:6333', OLLAMA_URL: 'http://o:11434' }, probe({}));
    expect(by['Qdrant (read)']).toMatchObject({ http: 200, state: 'CONNECTED', last_success_at: null, last_failure_at: null, evidence_source: null });
    expect(by['Qdrant (read)'].state_evidence).toMatch(/HTTP 200/);
    expect(by['Qdrant (read)'].state_evidence).toMatch(/UNKNOWN/);
    expect(by['Ollama (primary)']).toMatchObject({ state: 'CONNECTED', evidence_source: 'llm_model_calls' });
  });

  it('a 200 probe plus a recent ok call for that endpoint is HEALTHY, with the evidence time', async () => {
    call('ollama:http://o:11434', true, ago(2 * H));
    call('ollama:http://elsewhere:11434', false, ago(H)); // another endpoint's failure is not this one's
    const by = await map({ OLLAMA_URL: 'http://o:11434' }, probe({}));
    expect(by['Ollama (primary)']).toMatchObject({ state: 'HEALTHY', last_success_at: ago(2 * H), last_failure_at: null });
    expect(by['Ollama (primary)'].state_evidence).toContain(ago(2 * H));
  });

  it('a failure after the last success is DEGRADED even when the probe answers 200', async () => {
    call('nvidia', true, ago(5 * H), 'content_safety');
    call('openai:https://integrate.api.nvidia.com/v1', false, ago(H));
    const by = await map({ LLM_FALLBACK2_OPENAI_URL: 'https://integrate.api.nvidia.com/v1' }, probe({}));
    expect(by['NVIDIA API']).toMatchObject({ http: 200, state: 'DEGRADED', last_success_at: ago(5 * H), last_failure_at: ago(H) });
  });

  it('a success after the failure restores HEALTHY; a stale success is only CONNECTED', async () => {
    call('ollama', false, ago(3 * H), 'council'); call('ollama', true, ago(H), 'council');
    call('openai:https://ollama.com/v1', true, ago(30 * H));
    const by = await map({ OLLAMA_URL: 'http://o:11434', LLM_FALLBACK_OPENAI_URL: 'https://ollama.com/v1' }, probe({}));
    expect(by['Ollama (primary)'].state).toBe('HEALTHY');
    expect(by['Ollama Cloud']).toMatchObject({ state: 'CONNECTED', last_success_at: ago(30 * H) });
  });

  it('5xx and transport errors are never HEALTHY; TypeSafe without a key is DISABLED; local throttling is not provider failure', async () => {
    call('ollama:http://o:11434', true, ago(60_000));
    call('typesafe', false, ago(60_000), 'jev', 'breaker_open');
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('6333')) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      return new Response('', { status: url.includes('11434') ? 503 : 200 });
    });
    const by = await map({ OLLAMA_URL: 'http://o:11434', QDRANT_URL: 'http://q:6333' }, fetchFn as never);
    expect(by['Ollama (primary)']).toMatchObject({ http: 503, state: 'DEGRADED' });
    expect(by['Qdrant (read)']).toMatchObject({ state: 'FAILED', http: null });
    expect(by['TypeSafe (jev)']).toMatchObject({ state: 'DISABLED', last_failure_at: null });
  });

  it('event bus and agent registry use their own durable records (outbox publish/ingest cursor, registry sync)', async () => {
    db.prepare(`INSERT INTO event_outbox (event_id, event_type, aggregate_id, correlation_id, status, created_at, published_at) VALUES ('e1', 't', 'a', 'c', 'published', ?, ?)`).run(ago(3 * H), ago(3 * H));
    db.prepare(`INSERT INTO event_outbox (event_id, event_type, aggregate_id, correlation_id, status, last_error, created_at) VALUES ('e2', 't', 'a', 'c', 'failed', 'event bus returned 500', ?)`).run(ago(H));
    db.prepare(`INSERT INTO registry_agents (name, synced_at) VALUES ('a1', ?)`).run(ago(H));
    const by = await map({ DJIMIT_EVENT_BUS_URL: 'http://bus:8083', AGENT_REGISTRY_URL: 'http://reg:8088' }, probe({}));
    expect(by['event bus']).toMatchObject({ state: 'DEGRADED', last_success_at: ago(3 * H), last_failure_at: ago(H), evidence_source: 'event_outbox' });
    expect(by['agent registry']).toMatchObject({ state: 'HEALTHY', last_success_at: ago(H), evidence_source: 'registry_agents' });
  });
});
