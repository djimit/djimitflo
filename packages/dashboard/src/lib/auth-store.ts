import { create } from 'zustand';
import type { User, UserRole } from '@djimitflo/shared';
import { ROLE_PERMISSIONS } from '@djimitflo/shared';

const AUTH_TOKEN_KEY = 'djimitflo_auth_token';

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  restoreSession: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
}

async function apiRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001/api';
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const response = await fetch(`${API_BASE}${endpoint}`, { ...options, headers: { ...headers, ...options?.headers } });
  if (response.status === 401) {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || error.error?.message || `API error: ${response.status}`);
  }
  return response.json();
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: localStorage.getItem(AUTH_TOKEN_KEY),
  isAuthenticated: !!localStorage.getItem(AUTH_TOKEN_KEY),
  isLoading: false,
  error: null,

  login: async (email: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const result = await apiRequest<{ token: string; user: User }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      localStorage.setItem(AUTH_TOKEN_KEY, result.token);
      set({
        user: result.user,
        token: result.token,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Login failed',
      });
      throw error;
    }
  },

  logout: () => {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    set({ user: null, token: null, isAuthenticated: false, error: null });
  },

  restoreSession: async () => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    if (!token) {
      set({ isAuthenticated: false, user: null, token: null });
      return;
    }
    try {
      const result = await apiRequest<{ user: User }>('/auth/me');
      set({ user: result.user, token, isAuthenticated: true, isLoading: false });
    } catch {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      set({ user: null, token: null, isAuthenticated: false });
    }
  },

  hasPermission: (permission: string) => {
    const { user } = get();
    if (!user) return false;
    const permissions = ROLE_PERMISSIONS[user.role as UserRole];
    return permissions ? permissions.includes(permission) : false;
  },
}));

export { apiRequest };