// ponytail: vitest node-environment heeft geen localStorage; auth-store import
// ervan is eager. Dynamic import nadat localStorage is gestubbd.
const store: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = String(value); },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { for (const key of Object.keys(store)) delete store[key]; },
};
const { api } = await import('./api');

import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); });

it('getMetaTuningHistory requests the bounded endpoint and passes enabled:false through', async () => {
  const request = vi.spyOn(api as any, 'request').mockResolvedValue({ enabled: false });
  const result = await api.getMetaTuningHistory();
  expect(request).toHaveBeenCalledWith('/meta/tuning-history');
  expect(result).toEqual({ enabled: false });
});

it('getMetaTuningHistory encodes optional goalType and limit as query params', async () => {
  const request = vi.spyOn(api as any, 'request').mockResolvedValue([]);
  await api.getMetaTuningHistory({ goalType: 'general', limit: 10 });
  expect(request).toHaveBeenCalledWith('/meta/tuning-history?goalType=general&limit=10');
});
const { ApiError } = await import('./api');
const { permissionError } = await import('./permissions');

const respond = (status: number, body: string, headers: Record<string, string> = {}, statusText = '') =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status, statusText, headers }));
const failure = (call: Promise<unknown>) => call.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e as InstanceType<typeof ApiError>);

it('UXE-08: a 403 keeps its status, code, request id and the existing message', async () => {
  respond(403, JSON.stringify({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN', status: 403 } }), { 'X-Request-ID': 'req-403' });
  const error = await failure(api.getMetaTuningHistory());
  expect(error).toBeInstanceOf(ApiError);
  expect([error.message, error.status, error.code, error.request_id]).toEqual(['Access denied', 403, 'FORBIDDEN', 'req-403']);
});

it('UXE-08: a 404 keeps its status and the existing message', async () => {
  respond(404, 'not json');
  const error = await failure(api.getMetaTuningHistory());
  expect([error.message, error.status, error.code, error.request_id]).toEqual(['Not found', 404, undefined, undefined]);
});

it('UXE-08: a string error body surfaces the string, not API error: N', async () => {
  respond(409, JSON.stringify({ error: 'Lease already held' }));
  const error = await failure(api.getMetaTuningHistory());
  expect([error.message, error.status]).toEqual(['Lease already held', 409]);
});

it('UXE-08: the server error shape keeps its message byte-identical and carries the code', async () => {
  respond(503, JSON.stringify({ error: { message: 'Explainer not configured', code: 'NOT_CONFIGURED', status: 503 } }), { 'X-Request-ID': 'req-503' });
  const error = await failure(api.getMetaTuningHistory());
  expect([error.message, error.status, error.code, error.request_id]).toEqual(['Explainer not configured', 503, 'NOT_CONFIGURED', 'req-503']);
});

it('UXE-08: a non-JSON body still reads as the status text, and an empty one as API error: N', async () => {
  respond(502, '<html>bad gateway</html>', {}, 'Bad Gateway');
  expect((await failure(api.getMetaTuningHistory())).message).toBe('Bad Gateway');
  respond(500, JSON.stringify({}));
  const error = await failure(api.getMetaTuningHistory());
  expect([error.message, error.status]).toEqual(['API error: 500', 500]);
});

it('UXE-08: an export failure keeps its status and message prefix', async () => {
  respond(500, JSON.stringify({}));
  const error = await failure(api.exportCompliance('json'));
  expect(error).toBeInstanceOf(ApiError);
  expect([error.message, error.status]).toEqual(['Export failed: 500', 500]);
});

it('UXE-08: permissionError prefers status 403 over message matching', () => {
  const forbidden = new ApiError('Lease held by operator', { status: 403 });
  expect(permissionError(forbidden, 'manage:config', 'fallback')).toBe('Not allowed: this action needs manage:config (Lease held by operator).');
  expect(permissionError(new ApiError('Lease held by operator', { status: 409 }), 'manage:config', 'fallback')).toBe('Lease held by operator');
});
