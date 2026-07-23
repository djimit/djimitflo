/**
 * Core HTTP API client for Djimitflo backend.
 * Provides authentication, request handling, and base URL configuration.
 * 
 * Extracted from api.ts (Task 5.3: ApiClient domain split)
 */
export const API_BASE = import.meta.env.PROD ? '/api' : import.meta.env.VITE_API_BASE || '/api';
const AUTH_SESSION_KEY = 'djimitflo_auth_session';

export async function getToken(): Promise<string | null> {
  return localStorage.getItem(AUTH_SESSION_KEY);
}

export async function request<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers as Record<string, string>,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    localStorage.removeItem(AUTH_SESSION_KEY);
    window.location.href = '/login';
    throw new Error('Authentication required');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  return response.json();
}
