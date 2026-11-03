import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ScorecardsSection } from './ScorecardsSection';
import { api, type AgentScorecard, type RuntimeScorecard } from '../lib/api';

beforeEach(() => vi.restoreAllMocks());
const runtime: RuntimeScorecard = {
  runtime: 'opencode', outcomes: { n: 10, ok: 7, success_rate: 0.7, ci: [0.3968, 0.8922] }, duration_ms: { p50: 50_000, p95: 100_000 },
  tokens: 10_000_000, cost: { usd: null, reason: 'no price for kimi-k3:cloud' }, failure_classes: { infra_failed: 1, regressed: 1 }, benched: false,
};
const agent: AgentScorecard = {
  agent: 'hermes-eve-v', task_kinds: [{ task_kind: 'dream-scout', n: 2, ok: 1, success_rate: 0.5 }], n: 3, ok: 2, success_rate: 0.667, ci: [0.2, 0.94],
  last_outcome_at: new Date(Date.now() - 3_600_000).toISOString(), connection_state: 'lapsed', connection_reason: 'no heartbeat in 24 h (last 30 h ago)',
};

it('UX-17: every rate shows its n; an unpriced runtime says why its cost is unknown', async () => {
  vi.spyOn(api, 'getScorecards').mockResolvedValue({ runtimes: [runtime], agents: [agent] });
  render(<ScorecardsSection />);
  expect(await screen.findByText('opencode')).toBeTruthy();
  expect(screen.getByText('70% (n=10)')).toBeTruthy();
  expect(screen.getByText('40%–89%')).toBeTruthy();
  expect(screen.getByText('50 s / 100 s')).toBeTruthy();
  expect(screen.getByText('unknown (no price for kimi-k3:cloud)')).toBeTruthy();
  expect(screen.getByText('infra_failed 1, regressed 1')).toBeTruthy();
  expect(screen.getByText('67% (n=3)')).toBeTruthy();
  expect(screen.getByText('dream-scout 50% (n=2)')).toBeTruthy();
  expect(screen.getByText('lapsed — no heartbeat in 24 h (last 30 h ago)')).toBeTruthy();
});

it('UX-17: no outcomes and a failed call render honest states', async () => {
  vi.spyOn(api, 'getScorecards').mockResolvedValueOnce({ runtimes: [], agents: [] });
  const { unmount } = render(<ScorecardsSection />);
  expect(await screen.findByText('No runtime or agent outcome in the last 30 days.')).toBeTruthy();
  unmount();
  vi.spyOn(api, 'getScorecards').mockRejectedValueOnce(new Error('Access denied'));
  render(<ScorecardsSection />);
  expect(await screen.findByRole('alert')).toBeTruthy();
});
