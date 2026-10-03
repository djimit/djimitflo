import { beforeEach, expect, it, vi } from 'vitest';
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
  const t = serviceTargets({ DJIMIT_EVENT_BUS_URL: 'http://bus:8083' });
  expect(t.find((x) => x.names[0] === 'event bus')?.probe).toBe('http://bus:8083');
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