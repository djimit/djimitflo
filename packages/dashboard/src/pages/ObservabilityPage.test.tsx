import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ObservabilityPage } from './ObservabilityPage';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('uses the assessment population rather than task count for risk percentages', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
    total_tasks: 1, completed_tasks: 0, failed_tasks: 0, pending_approvals: 0,
    risk_distribution: { low: 2, medium: 2, high: 0, critical: 0 }, policy_decisions: {}, recent_errors: [],
  }) }));
  render(<ObservabilityPage />);
  expect(await screen.findByText('Risk Assessments')).toBeTruthy();
  expect(screen.getAllByText('2 (50%)')).toHaveLength(2);
  expect(screen.queryByText('2 (200%)')).toBeNull();
});

it('shows failed metrics requests instead of an endless loading skeleton', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Metrics offline')));
  render(<ObservabilityPage />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Metrics offline');
});
