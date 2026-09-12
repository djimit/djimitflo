import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AUTH_SESSION_KEY, apiRequest, refreshSession, sameSessionScope, useAuthStore } from './auth-store';
import { api } from './api';

const user = { id: 'fixture', role: 'admin', email: 'fixture@example.test' } as any;
const token = (exp: number, organization_id = 'tenant', sid = 'family') => `header.${btoa(JSON.stringify({ sub: 'fixture', sid, exp, organization_id }))}.signature`;
const expired = token(1);
const fresh = () => token(4_102_444_800);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const session = () => json({ token: fresh(), user, expires_in: 900 });
const denied = () => json({ error: { message: 'Session revoked' } }, 401);
const anonymousRefreshDenied = () => json({ error: { message: 'Invalid or expired browser session' } }, 401);
const defer = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const bearer = (options?: RequestInit) => new Headers(options?.headers).get('Authorization');

beforeEach(() => {
  useAuthStore.getState().replaceToken(expired);
  useAuthStore.setState({ user, isLoading: false });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fixture request'); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); useAuthStore.setState({ token: null, user: null, isAuthenticated: false, isLoading: false }); });

it('logs in through the explicit cookie session contract without exposing a refresh token', async () => {
  const fetch = vi.fn().mockImplementation(async () => session()); vi.stubGlobal('fetch', fetch);
  await useAuthStore.getState().login('fixture@example.test', 'synthetic');
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/login', expect.objectContaining({
    credentials: 'include', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Djimitflo-Session': 'browser' },
  }));
  expect(localStorage.getItem(AUTH_SESSION_KEY)).toBe(fresh());
  expect(localStorage.length).toBe(1);
});

it('keeps login response decoding and token adoption inside the cross-tab lock', async () => {
  const body = defer<{ token: string; user: typeof user }>();
  let released = false;
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, callback: () => Promise<void>) => {
    await callback();
    expect(useAuthStore.getState().token).toBe(fresh());
    expect(localStorage.getItem(AUTH_SESSION_KEY)).toBe(fresh());
    released = true;
  } } });
  const fetch = vi.fn(async () => ({ ok: true, status: 200, json: () => body.promise })); vi.stubGlobal('fetch', fetch);
  const login = useAuthStore.getState().login('fixture@example.test', 'synthetic');
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(released).toBe(false);
  body.resolve({ token: fresh(), user });
  await login;
  expect(released).toBe(true);
});

it('does not overwrite a new tab identity during delayed refresh response decoding', async () => {
  const body = defer<{ token: string; user: typeof user }>();
  let decoding = false;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: () => { decoding = true; return body.promise; } })));
  const pending = refreshSession().catch(error => error.message);
  await vi.waitFor(() => expect(decoding).toBe(true));
  const other = token(Math.floor(Date.now() / 1000) + 900, 'other-tenant', 'other-family');
  localStorage.setItem(AUTH_SESSION_KEY, other);
  body.resolve({ token: fresh(), user });
  expect(await pending).toBe('Session changed');
  expect(localStorage.getItem(AUTH_SESSION_KEY)).toBe(other);
});

it('coalesces concurrent API and auth-store 401s into one rotation and retries each once', async () => {
  const rotation = defer<Response>();
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/auth/refresh') return rotation.promise;
    return bearer(options) === `Bearer ${expired}` ? denied() : json({ ok: true });
  }); vi.stubGlobal('fetch', fetch);
  const a = api.request('/fixture/a'); const b = apiRequest('/fixture/b');
  await vi.waitFor(() => expect(fetch.mock.calls.filter(([url]) => url === '/api/auth/refresh')).toHaveLength(1));
  rotation.resolve(session());
  expect(await Promise.all([a, b])).toEqual([{ ok: true }, { ok: true }]);
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(useAuthStore.getState().token).toBe(fresh());
});

it('preserves selected organization in refresh and never supplies a JS refresh credential', async () => {
  const fetch = vi.fn().mockImplementation(async () => session()); vi.stubGlobal('fetch', fetch);
  await refreshSession();
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/refresh', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Djimitflo-Session': 'browser' },
    body: JSON.stringify({ organization_id: 'tenant' }),
  });
});

it('bounds retry when the replacement token is also rejected', async () => {
  const fetch = vi.fn(async (url: string) => url === '/api/auth/refresh' ? session() : denied()); vi.stubGlobal('fetch', fetch);
  await expect(api.request('/fixture')).rejects.toThrow('Session expired');
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(useAuthStore.getState().isAuthenticated).toBe(false);
  expect(localStorage.getItem(AUTH_SESSION_KEY)).toBeNull();
  await expect(api.request('/fixture')).rejects.toThrow();
  expect(fetch.mock.calls.filter(([url]) => url === '/api/auth/refresh')).toHaveLength(1);
});

it('clears an invalid refresh and does not loop', async () => {
  const fetch = vi.fn(async () => denied()); vi.stubGlobal('fetch', fetch);
  await expect(api.request('/fixture')).rejects.toThrow('Session revoked');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(localStorage.getItem(AUTH_SESSION_KEY)).toBeNull();
});

it('re-reads a same-family token after acquiring a cross-tab lock instead of replaying a rotation', async () => {
  const lock = defer<void>();
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name: string, callback: () => Promise<string>) => { await lock.promise; return callback(); }) } });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const pending = refreshSession(expired);
  const replacement = fresh();
  localStorage.setItem(AUTH_SESSION_KEY, replacement);
  window.dispatchEvent(new StorageEvent('storage', { key: AUTH_SESSION_KEY, oldValue: expired, newValue: replacement }));
  lock.resolve();
  expect(await pending).toBe(replacement);
  expect(fetch).not.toHaveBeenCalled();
  expect(useAuthStore.getState().token).toBe(replacement);
});

it('does not skip rotation merely because a different token in storage is also expired', async () => {
  const lock = defer<void>();
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, callback: () => Promise<string>) => { await lock.promise; return callback(); } } });
  const fetch = vi.fn(async () => session()); vi.stubGlobal('fetch', fetch);
  const pending = refreshSession(expired);
  localStorage.setItem(AUTH_SESSION_KEY, token(2));
  lock.resolve();
  expect(await pending).toBe(fresh());
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(['sub', 'sid'])('rejects a different %s before the asynchronous storage event is delivered', async (field) => {
  const nextClaims = { sub: 'fixture', sid: 'family', organization_id: 'tenant', exp: Math.floor(Date.now() / 1000) + 900, [field]: 'other' };
  localStorage.setItem(AUTH_SESSION_KEY, `header.${btoa(JSON.stringify(nextClaims))}.signature`);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(refreshSession(expired)).rejects.toThrow('Session scope changed');
  expect(fetch).not.toHaveBeenCalled();
});

it('requires exact equality for legacy tokens without a session family', () => {
  const legacy = (exp: number) => `header.${btoa(JSON.stringify({ sub: 'fixture', organization_id: 'tenant', exp }))}.signature`;
  expect(sameSessionScope(legacy(1), legacy(1))).toBe(true);
  expect(sameSessionScope(legacy(1), legacy(2))).toBe(false);
});

it('does not restore a pending login after logout and revokes its newly received cookie', async () => {
  const loginResponse = defer<Response>();
  const fetch = vi.fn(async (url: string) => url === '/api/auth/login' ? loginResponse.promise : json({ ok: true })); vi.stubGlobal('fetch', fetch);
  const login = useAuthStore.getState().login('fixture@example.test', 'synthetic').catch(error => error.message);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  const logout = useAuthStore.getState().logout();
  loginResponse.resolve(session());
  expect(await login).toBe('Session changed');
  await logout;
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/login', '/api/auth/logout']);
  expect(useAuthStore.getState().isAuthenticated).toBe(false);
});

it('does not overwrite logout with an in-flight rotation and revokes after that response settles', async () => {
  const rotation = defer<Response>();
  const fetch = vi.fn(async (url: string) => url === '/api/auth/refresh' ? rotation.promise : json({ ok: true })); vi.stubGlobal('fetch', fetch);
  const refreshing = refreshSession().catch(error => error.message);
  const logout = useAuthStore.getState().logout();
  expect(useAuthStore.getState().isAuthenticated).toBe(false);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/refresh']);
  rotation.resolve(session());
  expect(await refreshing).toBe('Session changed');
  await logout;
  expect(fetch).toHaveBeenLastCalledWith('/api/auth/logout', expect.objectContaining({ credentials: 'include', headers: expect.objectContaining({ Authorization: `Bearer ${expired}`, 'X-Djimitflo-Session': 'browser' }) }));
  expect(localStorage.getItem(AUTH_SESSION_KEY)).toBeNull();
  expect(useAuthStore.getState().token).toBeNull();
});

it('invalidates pending refresh on a logout storage event from another tab', async () => {
  const rotation = defer<Response>(); vi.stubGlobal('fetch', vi.fn(() => rotation.promise));
  const pending = refreshSession().catch(error => error.message);
  localStorage.removeItem(AUTH_SESSION_KEY);
  window.dispatchEvent(new StorageEvent('storage', { key: AUTH_SESSION_KEY, oldValue: expired, newValue: null }));
  rotation.resolve(session());
  expect(await pending).toBe('Session changed');
  expect(useAuthStore.getState().token).toBeNull();
});

it('restores an expired session with the refreshed token rather than the captured old token', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => url === '/api/auth/refresh' ? session() : bearer(options) === `Bearer ${expired}` ? denied() : json({ user })));
  await useAuthStore.getState().restoreSession();
  expect(useAuthStore.getState()).toMatchObject({ token: fresh(), user, isAuthenticated: true, isLoading: false });
});

it('restores from the HttpOnly cookie when no access token remains in storage', async () => {
  localStorage.removeItem(AUTH_SESSION_KEY);
  const fetch = vi.fn(async (url: string) => url === '/api/auth/refresh' ? session() : json({ user })); vi.stubGlobal('fetch', fetch);
  await useAuthStore.getState().restoreSession();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/refresh', '/api/auth/me']);
  expect(useAuthStore.getState().token).toBe(fresh());
});

it('keeps an anonymous login screen clean when no refresh cookie exists', async () => {
  localStorage.removeItem(AUTH_SESSION_KEY);
  useAuthStore.setState({ token: null, user: null, isAuthenticated: false });
  vi.stubGlobal('fetch', vi.fn(async () => anonymousRefreshDenied()));
  await useAuthStore.getState().restoreSession();
  expect(useAuthStore.getState()).toMatchObject({ token: null, user: null, isAuthenticated: false, isLoading: false, error: null });
});

it('serializes a new login after server logout and exposes logout failure honestly', async () => {
  const revocation = defer<Response>();
  const fetch = vi.fn(async (url: string) => url === '/api/auth/logout' ? revocation.promise : session()); vi.stubGlobal('fetch', fetch);
  const logout = useAuthStore.getState().logout();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  revocation.resolve(json({ error: { message: 'Revocation unavailable' } }, 503));
  await logout;
  expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, error: 'Revocation unavailable' });
  await useAuthStore.getState().login('fixture@example.test', 'synthetic');
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/logout', '/api/auth/login']);
});

it('downloads through the same refresh path and revokes the temporary blob URL', async () => {
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const create = vi.fn(() => 'blob:fixture'); const revoke = vi.fn();
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
  const fetch = vi.fn(async (url: string, options?: RequestInit) => url === '/api/auth/refresh' ? session() : bearer(options) === `Bearer ${expired}` ? denied() : new Response('fixture export')); vi.stubGlobal('fetch', fetch);
  await api.exportCompliance('json');
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(create).toHaveBeenCalledOnce(); expect(revoke).toHaveBeenCalledWith('blob:fixture');
});
