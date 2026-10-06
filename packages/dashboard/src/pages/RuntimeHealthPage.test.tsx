import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { RuntimeHealthSection } from './RuntimeHealthPage';
import { api, type RuntimeHealthRow } from '../lib/api';

beforeEach(() => vi.restoreAllMocks());
const row = (over: Partial<RuntimeHealthRow>): RuntimeHealthRow => ({
  runtime: 'opencode', admission: { decision: 'LEGACY_ADMITTED', expires_at: '2026-12-31T00:00:00Z', days_to_expiry: 85, allowed_now: true },
  version: { admitted: '1.18.10', observed: '1.18.10', drift: false }, probe: { status: 'ok', probed_at: new Date(Date.now() - 3_600_000).toISOString(), age_h: 1 },
  leases_30d: { n: 4, completed: 2, failed: 1, cancelled: 1, success_rate: 0.667 }, leases_90d: 5, last_success_at: new Date(Date.now() - 7_200_000).toISOString(),
  gym: { species: [], benched: false }, readiness: 'reassess', ...over,
});

it('UX-16: renders one row per runtime with n, the expiry countdown and honest "no probe"', async () => {
  vi.spyOn(api, 'getRuntimeHealth').mockResolvedValue({ runtimes: [row({}), row({ runtime: 'gemini', probe: { status: 'no probe', probed_at: null, age_h: null }, leases_30d: { n: 0, completed: 0, failed: 0, cancelled: 0, success_rate: null }, leases_90d: 0, last_success_at: null, readiness: 'retire_unused', version: { admitted: null, observed: null, drift: false } })] });
  render(<RuntimeHealthSection />);
  expect(await screen.findByText('opencode')).toBeTruthy();
  expect(screen.getAllByText('in 85 d')).toHaveLength(2);
  expect(screen.getByText('67% (n=3)')).toBeTruthy();
  expect(screen.getByText('no probe')).toBeTruthy();
  expect(screen.getByText('— (n=0)')).toBeTruthy();
  expect(screen.getByText('retire (unused)')).toBeTruthy();
  expect(screen.getByText('needs re-assessment')).toBeTruthy();
});

it('UX-16: an empty registry and a failed call render honest states', async () => {
  vi.spyOn(api, 'getRuntimeHealth').mockResolvedValueOnce({ runtimes: [] });
  const { unmount } = render(<RuntimeHealthSection />);
  expect(await screen.findByText('No runtime is registered or has run.')).toBeTruthy();
  unmount();
  vi.spyOn(api, 'getRuntimeHealth').mockRejectedValueOnce(new Error('boom'));
  render(<RuntimeHealthSection />);
  expect(await screen.findByRole('alert')).toBeTruthy();
});
