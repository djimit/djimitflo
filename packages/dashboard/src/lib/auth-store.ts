import { create } from 'zustand';
import type { User, UserRole } from '@djimitflo/shared';
import { ROLE_PERMISSIONS } from '@djimitflo/shared';

export const AUTH_SESSION_KEY = 'djimitflo_auth_session';
export const API_BASE = import.meta.env.PROD ? '/api' : import.meta.env.VITE_API_BASE || '/api';
const SESSION_LOCK = 'djimitflo-browser-session';

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  restoreSession: () => Promise<void>;
  replaceToken: (token: string) => void;
  hasPermission: (permission: string) => boolean;
}

type SessionResult = { token: string; user: User; expires_in?: number };
let sessionEpoch = 0;
let loggedOut = false;
let refreshFlight: Promise<string> | null = null;
let logoutFlight: Promise<void> | null = null;
let loginFlight: Promise<void> | null = null;

function claims(token: string | null): { organization_id?: string; exp?: number; sub?: string; sid?: string } {
  try {
    return JSON.parse(atob((token?.split('.')[1] || '').replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return {}; }
}

export function sameSessionScope(previous: string | null, current: string | null): boolean {
  if (!previous || !current) return false;
  if (previous === current) return true;
  const before = claims(previous);
  const after = claims(current);
  return typeof before.sub === 'string' && before.sub === after.sub
    && typeof before.sid === 'string' && before.sid.length > 0
    && before.sid === after.sid && before.organization_id === after.organization_id;
}

function withSessionLock<T>(work: () => Promise<T>): Promise<T> {
  // ponytail: without Web Locks only in-tab singleflight is guaranteed; require a supporting browser for cross-tab renewal.
  return typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request(SESSION_LOCK, work)
    : work();
}

async function responseError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => ({}));
  return new Error(body.message || body.error?.message || `API error: ${response.status}`);
}

function clearSession(error: string | null = null) {
  sessionEpoch++;
  loggedOut = true;
  localStorage.removeItem(AUTH_SESSION_KEY);
  useAuthStore.setState({ token: null, user: null, isAuthenticated: false, isLoading: false, error });
}

function applySession(result: SessionResult) {
  if (typeof result.token !== 'string' || !result.token.trim() || !result.user) throw new Error('Invalid session response');
  localStorage.setItem(AUTH_SESSION_KEY, result.token);
  useAuthStore.setState({ token: result.token, user: result.user, isAuthenticated: true, isLoading: false, error: null });
}

function browserAuthRequest(endpoint: string, body?: unknown, token?: string | null): Promise<Response> {
  return fetch(`${API_BASE}/auth/${endpoint}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Djimitflo-Session': 'browser', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** One rotation per tab, serialized across supporting tabs. Refresh cookies are never read by JS. */
export function refreshSession(expectedToken = localStorage.getItem(AUTH_SESSION_KEY)): Promise<string> {
  if (loggedOut) return Promise.reject(new Error('Session expired'));
  if (refreshFlight) return refreshFlight;
  const epoch = sessionEpoch;
  const run = withSessionLock(async () => {
    if (epoch !== sessionEpoch || loggedOut) throw new Error('Session changed');
    // Another tab may already have rotated while this tab waited for the native lock.
    const current = localStorage.getItem(AUTH_SESSION_KEY);
    if (expectedToken && !current) throw new Error('Session changed');
    if (current && current !== expectedToken) {
      const currentClaims = claims(current);
      if (expectedToken && !sameSessionScope(expectedToken, current)) throw new Error('Session scope changed');
      if (typeof currentClaims.exp === 'number' && currentClaims.exp * 1000 > Date.now()) {
        useAuthStore.setState({ token: current, isAuthenticated: true });
        return current;
      }
    }
    const organization_id = claims(current || expectedToken).organization_id;
    const response = await browserAuthRequest('refresh', organization_id ? { organization_id } : {});
    if (epoch !== sessionEpoch || loggedOut || localStorage.getItem(AUTH_SESSION_KEY) !== current) throw new Error('Session changed');
    if (!response.ok) {
      const error = await responseError(response);
      // With no access token there is no client session to clear; keep the
      // anonymous login state intact so restoreSession can fail quietly.
      if ((response.status === 401 || response.status === 403) && expectedToken) clearSession(error.message);
      throw error;
    }
    const result = await response.json() as SessionResult;
    if (epoch !== sessionEpoch || loggedOut || localStorage.getItem(AUTH_SESSION_KEY) !== current) throw new Error('Session changed');
    applySession(result);
    return result.token;
  });
  refreshFlight = run;
  void run.finally(() => { if (refreshFlight === run) refreshFlight = null; }).catch(() => {});
  return run;
}

/** Shared JSON/download/stream boundary: retry only a rejected bearer, at most once. */
export async function authenticatedFetch(endpoint: string, options?: RequestInit): Promise<Response> {
  const epoch = sessionEpoch;
  const token = localStorage.getItem(AUTH_SESSION_KEY);
  const send = (accessToken: string | null) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    new Headers(options?.headers).forEach((value, name) => { headers[name] = value; });
    delete headers.authorization;
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    return fetch(`${API_BASE}${endpoint}`, { ...options, credentials: 'include', headers });
  };
  const first = await send(token);
  if (first.status !== 401) return first;
  if (epoch !== sessionEpoch || loggedOut || options?.signal?.aborted) throw new Error('Session changed');
  const refreshed = await refreshSession(token);
  if (epoch !== sessionEpoch || loggedOut || options?.signal?.aborted) throw new Error('Session changed');
  const retried = await send(refreshed);
  if (retried.status === 401) {
    if (epoch === sessionEpoch && localStorage.getItem(AUTH_SESSION_KEY) === refreshed) clearSession('Session expired');
    throw new Error('Session expired');
  }
  return retried;
}

export async function apiRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(endpoint, options);
  if (!response.ok) throw await responseError(response);
  return response.json();
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: localStorage.getItem(AUTH_SESSION_KEY),
  isAuthenticated: !!localStorage.getItem(AUTH_SESSION_KEY),
  isLoading: true,
  error: null,

  login: (email: string, password: string) => {
    if (loginFlight) return loginFlight;
    const epoch = ++sessionEpoch;
    const run = (async () => {
      set({ isLoading: true, error: null });
      try {
        await logoutFlight;
        await refreshFlight?.catch(() => {});
        await withSessionLock(async () => {
          if (epoch !== sessionEpoch) throw new Error('Session changed');
          const response = await browserAuthRequest('login', { email, password });
          if (epoch !== sessionEpoch) throw new Error('Session changed');
          if (!response.ok) throw await responseError(response);
          const result = await response.json() as SessionResult;
          if (epoch !== sessionEpoch) throw new Error('Session changed');
          loggedOut = false;
          applySession(result);
        });
      } catch (error) {
        if (epoch === sessionEpoch) set({ isLoading: false, error: error instanceof Error ? error.message : 'Login failed' });
        throw error;
      }
    })();
    loginFlight = run;
    void run.finally(() => { if (loginFlight === run) loginFlight = null; }).catch(() => {});
    return run;
  },

  logout: () => {
    const token = localStorage.getItem(AUTH_SESSION_KEY);
    const pendingRefresh = refreshFlight;
    const pendingLogin = loginFlight;
    clearSession();
    if (logoutFlight) return logoutFlight;
    const epoch = sessionEpoch;
    const run = (async () => {
      // Wait for a cookie-bearing response before revocation, including the no-Web-Locks fallback.
      await Promise.allSettled([pendingRefresh, pendingLogin]);
      try {
        const response = await withSessionLock(() => browserAuthRequest('logout', undefined, token));
        if (!response.ok) throw await responseError(response);
      } catch (error) {
        if (epoch === sessionEpoch) set({ error: error instanceof Error ? error.message : 'Server logout failed' });
      }
    })();
    logoutFlight = run;
    void run.finally(() => { if (logoutFlight === run) logoutFlight = null; }).catch(() => {});
    return run;
  },

  replaceToken: (token: string) => {
    if (typeof token !== 'string' || !token.trim()) throw new Error('Organization switch returned no session token');
    localStorage.setItem(AUTH_SESSION_KEY, token);
    sessionEpoch++;
    loggedOut = false;
    set({ token, isAuthenticated: true, error: null });
  },

  restoreSession: async () => {
    const epoch = sessionEpoch;
    const hadAccessToken = Boolean(localStorage.getItem(AUTH_SESSION_KEY));
    set({ isLoading: true });
    try {
      if (loggedOut) return;
      if (!localStorage.getItem(AUTH_SESSION_KEY)) await refreshSession(null);
      const result = await apiRequest<{ user: User }>('/auth/me');
      if (epoch === sessionEpoch && !loggedOut) {
        set({ user: result.user, token: localStorage.getItem(AUTH_SESSION_KEY), isAuthenticated: true, error: null });
      }
    } catch (error) {
      if (epoch === sessionEpoch) {
        const message = error instanceof Error ? error.message : 'Session unavailable';
        // An anonymous browser has no refresh cookie by design; keep the login
        // screen clean while still surfacing failures for an existing session.
        set({ error: !hadAccessToken && message === 'Invalid or expired browser session' ? null : message });
      }
    } finally {
      if (epoch === sessionEpoch) set({ isLoading: false });
    }
  },

  hasPermission: (permission: string) => {
    const { user } = get();
    if (!user) return false;
    const permissions = ROLE_PERMISSIONS[user.role as UserRole];
    return permissions ? permissions.includes(permission) : false;
  },
}));

// Native storage events coordinate token changes/logout from other tabs without exposing refresh cookies.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== AUTH_SESSION_KEY) return;
    const scopeChanged = claims(event.oldValue).organization_id !== claims(event.newValue).organization_id
      || claims(event.oldValue).sub !== claims(event.newValue).sub
      || claims(event.oldValue).sid !== claims(event.newValue).sid;
    if (!event.newValue || scopeChanged) sessionEpoch++;
    loggedOut = !event.newValue;
    useAuthStore.setState({
      token: event.newValue, isAuthenticated: !!event.newValue,
      ...(event.newValue ? {} : { user: null, isLoading: false }),
    });
    if (event.newValue && scopeChanged) window.location.reload();
  });
}
