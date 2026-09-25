const store: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = String(value); },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { for (const key of Object.keys(store)) delete store[key]; },
};
const { SelfDrivingDashboard } = await import('./SelfDrivingDashboard');

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('handles the real disabled meta contract and unavailable services without fake success metrics', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/meta/stats')) return { ok: true, status: 200, json: async () => ({ enabled: false }) };
    throw new Error('Service unavailable');
  }));
  render(<SelfDrivingDashboard />);
  expect(await screen.findByText('Meta orchestration is disabled on this instance.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Run bounded tuning' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Compliance metrics unavailable.')).toBeTruthy();
  expect(screen.queryByText('✓ Valid')).toBeNull();
  expect(screen.queryByText('$0.00')).toBeNull();
  expect(screen.getByText('Meta-orchestration uitgeschakeld (runtime-profiel)')).toBeTruthy();
});

it('fetches tuning history only when meta is enabled, otherwise shows the disabled readout', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/meta/stats')) return { ok: true, status: 200, json: async () => ({ enabled: true, totalDecisions: 0, failuresPredicted: 0, costSavingsDollars: 0 }) };
    if (url.includes('/meta/tuning-history')) return { ok: true, status: 200, json: async () => [
      { goalType: 'general', tuningType: 'concurrency', applied: true, confidence: 0.72, createdAt: '2026-09-14T00:00:00Z' },
    ] };
    if (url.endsWith('/cognitive/stats')) return { ok: true, status: 200, json: async () => ({ totalEpisodes: 0, totalPatterns: 0, totalStrategies: 0, overallSuccessRate: 0, bestGoalType: null }) };
    throw new Error('Service unavailable');
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<SelfDrivingDashboard />);
  expect(await screen.findByText('concurrency')).toBeTruthy();
  expect(screen.getAllByText(/general/).length).toBeGreaterThan(0);
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/meta/tuning-history'))).toBe(true);
});
