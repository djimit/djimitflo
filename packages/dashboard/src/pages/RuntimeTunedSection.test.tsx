import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeTunedSection } from './RuntimeTunedSection';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('handles the real disabled meta contract: says so, disables tuning and never asks for a history', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/meta/stats')) return { ok: true, status: 200, json: async () => ({ enabled: false }) };
    throw new Error('Service unavailable');
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<RuntimeTunedSection />);
  expect(await screen.findByText(/Meta orchestration is disabled on this instance/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Run bounded tuning' }) as HTMLButtonElement).disabled).toBe(true);
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/meta/tuning-history'))).toBe(false);
});

it('lists the tuning history with its value and applied state when meta is enabled', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/meta/stats')) return { ok: true, status: 200, json: async () => ({ enabled: true, totalDecisions: 0, failuresPredicted: 0, costSavingsDollars: 0 }) };
    if (url.includes('/meta/tuning-history')) return { ok: true, status: 200, json: async () => [
      { goalType: 'general', tuningType: 'concurrency', recommendedValue: 3, applied: true, confidence: 0.72, createdAt: '2026-09-14T00:00:00Z' },
    ] };
    throw new Error('Service unavailable');
  }));
  render(<RuntimeTunedSection />);
  expect(await screen.findByText('concurrency')).toBeTruthy();
  expect(screen.getByText('general')).toBeTruthy();
  expect(screen.getByText('applied')).toBeTruthy();
  expect(screen.getByText('72%')).toBeTruthy();
  expect(screen.getByText('2026-09-14')).toBeTruthy();
});

it('a failed meta read is an error, not "disabled" or an empty log', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Service unavailable'); }));
  render(<RuntimeTunedSection />);
  expect((await screen.findByRole('alert')).textContent).toContain('meta stats');
  expect(screen.queryByText(/disabled on this instance/)).toBeNull();
  expect(screen.queryByText('No tuning adjustments yet.')).toBeNull();
});
