import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { OperatorCockpitPage } from './OperatorCockpitPage';
import { api } from '../lib/api';

beforeEach(() => vi.restoreAllMocks());

it('shows breached guardrails, stalls and gym species from the cockpit endpoint', async () => {
  vi.spyOn(api, 'getOperatorCockpit').mockResolvedValue({
    at: '2026-09-28T20:00:00Z', build: { commit: 'f9f481ad3eb5', build_time: null },
    scorecard: { verified_7d: 11, regressed_7d: 5 },
    guardrails: [{ name: 'regressions', ok: false, value: 5, limit: '<= verified/5 (2.2)' }],
    stalls: [{ subsystem: 'gym:atomic@llama-router', since: null, detail: 'no outcome for 9 h' }],
    gym: [{ species: 'atomic', outcomes: 27, successes: 24, success_pct: 89, avg_seconds: 588, avg_tokens: 0, last: '2026-09-28T08:53:00Z' }],
    remote_workers: [], maker_usage_7d: [], judgments_7d: [],
  });
  render(<OperatorCockpitPage />);
  expect(await screen.findByText('breached · limit <= verified/5 (2.2)')).toBeTruthy();
  expect(screen.getByText('gym:atomic@llama-router')).toBeTruthy();
  expect(screen.getByText('89%')).toBeTruthy();
  expect(screen.getByText('No remote host has claimed work.')).toBeTruthy();
});

it('shows the error when the endpoint fails', async () => {
  vi.spyOn(api, 'getOperatorCockpit').mockRejectedValue(new Error('Access denied'));
  render(<OperatorCockpitPage />);
  expect((await screen.findByRole('alert')).textContent).toBe('Access denied');
});
