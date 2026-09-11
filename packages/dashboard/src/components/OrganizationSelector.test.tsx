import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OrganizationSelector } from './OrganizationSelector';
import { useAuthStore } from '../lib/auth-store';

const key = 'djimitflo_auth_session';
const tokenFor = (organization_id: string) => `header.${btoa(JSON.stringify({ organization_id }))}.signature`;
const original = tokenFor('tenant');
const replacement = tokenFor('default');
const organizations = [{ id: 'default', name: 'Default' }, { id: 'tenant', name: 'Tenant' }];
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useAuthStore.getState().replaceToken(original);
  useAuthStore.setState({ token: original, isAuthenticated: true, user: { id: 'fixture', role: 'admin' } as any });
  reload = vi.fn();
  const location = { reload };
  vi.stubGlobal('window', new Proxy(window, { get: (target, property) => property === 'location' ? location : Reflect.get(target, property) }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); useAuthStore.setState({ user: null, token: null, isAuthenticated: false }); });

it('shows the active token organization rather than the first returned row', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(organizations)));
  render(<OrganizationSelector />);
  await screen.findByRole('option', { name: 'Tenant' });
  expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveProperty('value', 'tenant');
});

it('adopts the returned token in both stores before reloading scoped data', async () => {
  let resolveSwitch!: (value: unknown) => void;
  const fetch = vi.fn(async (_url: string, options?: RequestInit) => options?.method === 'POST'
    ? new Promise(resolve => { resolveSwitch = resolve; }) : response(organizations));
  vi.stubGlobal('fetch', fetch);
  reload.mockImplementation(() => {
    expect(localStorage.getItem(key)).toBe(replacement);
    expect(useAuthStore.getState().token).toBe(replacement);
  });
  render(<OrganizationSelector />);
  await screen.findByRole('option', { name: 'Tenant' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'default' } });
  expect(screen.getByRole('combobox')).toHaveProperty('disabled', true);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'default' } });
  expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  expect(fetch.mock.calls.find(([, options]) => options?.method === 'POST')?.[1]).toMatchObject({
    headers: { Authorization: `Bearer ${original}` }, body: JSON.stringify({ organization_id: 'default' }),
  });
  expect(useAuthStore.getState().token).toBe(original);
  resolveSwitch(response({ token: replacement }));
  await waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(useAuthStore.getState().isAuthenticated).toBe(true);
});

it.each([
  [response({ error: { message: 'Organization mismatch' } }, 403), 'Organization mismatch'],
  [response({}), 'Organization switch returned no session token'],
])('retains the actual organization and token when switching fails', async (switchResponse, message) => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => options?.method === 'POST' ? switchResponse : response(organizations)));
  render(<OrganizationSelector />);
  await screen.findByRole('option', { name: 'Tenant' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'default' } });
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', message);
  expect(screen.getByRole('combobox')).toHaveProperty('value', 'tenant');
  expect(useAuthStore.getState().token).toBe(original);
  expect(localStorage.getItem(key)).toBe(original);
  expect(reload).not.toHaveBeenCalled();
});

it('shows list errors and retries without an optimistic organization', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('List unavailable')).mockResolvedValue(response(organizations)));
  render(<OrganizationSelector />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'List unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry organizations' }));
  await screen.findByRole('option', { name: 'Tenant' });
  expect(screen.getByRole('combobox')).toHaveProperty('value', 'tenant');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('does not resurrect a logged-out session from a late switch response', async () => {
  let resolveSwitch!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => url === '/api/auth/logout' ? response({ ok: true }) : options?.method === 'POST'
    ? new Promise(resolve => { resolveSwitch = resolve; }) : response(organizations)));
  render(<OrganizationSelector />);
  await screen.findByRole('option', { name: 'Tenant' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'default' } });
  await act(async () => { await useAuthStore.getState().logout(); });
  resolveSwitch(response({ token: replacement }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Session changed; organization switch was not applied');
  expect(screen.getByRole('combobox')).toHaveProperty('disabled', true);
  expect(useAuthStore.getState().token).toBeNull();
  expect(localStorage.getItem(key)).toBeNull();
  expect(reload).not.toHaveBeenCalled();
});

it('accepts the switch response after the same session refreshes an expired bearer', async () => {
  const sessionToken = (org: string, exp: number) => `header.${btoa(JSON.stringify({ organization_id: org, sub: 'fixture', sid: 'family', exp }))}.signature`;
  const old = sessionToken('tenant', 1);
  const refreshed = sessionToken('tenant', Math.floor(Date.now() / 1000) + 900);
  const switched = sessionToken('default', Math.floor(Date.now() / 1000) + 900);
  useAuthStore.getState().replaceToken(old);
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/auth/refresh') return response({ token: refreshed, user: { id: 'fixture', role: 'admin' } });
    if (url === '/api/organizations/switch') return new Headers(options?.headers).get('Authorization') === `Bearer ${old}`
      ? response({ error: { message: 'Expired' } }, 401) : response({ token: switched });
    return response(organizations);
  }); vi.stubGlobal('fetch', fetch);
  render(<OrganizationSelector />);
  await screen.findByRole('option', { name: 'Tenant' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'default' } });
  await waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(useAuthStore.getState().token).toBe(switched);
  expect(localStorage.getItem(key)).toBe(switched);
  expect(screen.queryByRole('alert')).toBeNull();
});
