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