import { afterEach, expect, it, vi } from 'vitest';
import { useAuthStore } from './auth-store';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); useAuthStore.setState({ token: null, user: null, isAuthenticated: false }); });

it('replaces the short-lived session token in memory and existing storage without losing the user', () => {
  const user = { id: 'fixture', role: 'admin' } as any;
  useAuthStore.setState({ user, token: 'old', isAuthenticated: true });
  useAuthStore.getState().replaceToken('replacement');
  expect(localStorage.getItem('djimitflo_auth_session')).toBe('replacement');
  expect(useAuthStore.getState()).toMatchObject({ user, token: 'replacement', isAuthenticated: true });
});

it('does not replace an existing token with an empty value', () => {
  localStorage.setItem('djimitflo_auth_session', 'old');
  useAuthStore.setState({ token: 'old', isAuthenticated: true });
  expect(() => useAuthStore.getState().replaceToken('')).toThrow('Organization switch returned no session token');
  expect(localStorage.getItem('djimitflo_auth_session')).toBe('old');
  expect(useAuthStore.getState().token).toBe('old');
});

it('keeps the in-memory token unchanged when existing storage rejects the replacement', () => {
  localStorage.setItem('djimitflo_auth_session', 'old');
  useAuthStore.setState({ token: 'old', isAuthenticated: true });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
  expect(() => useAuthStore.getState().replaceToken('replacement')).toThrow('Storage unavailable');
  expect(localStorage.getItem('djimitflo_auth_session')).toBe('old');
  expect(useAuthStore.getState().token).toBe('old');
});
