import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SelfDrivingDashboard } from './SelfDrivingDashboard';

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
});
