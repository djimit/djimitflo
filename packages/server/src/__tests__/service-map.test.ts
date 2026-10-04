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
