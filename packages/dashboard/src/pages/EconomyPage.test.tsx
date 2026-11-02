import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { EconomyPage } from './EconomyPage';

vi.mock('../lib/api', () => ({
  api: {
    request: vi.fn().mockResolvedValue({
      capabilities: [
        { capability_id: 'cap-tariff-estimate', capability_kind: 'skill', status: 'validated', n_runs: 1, n_completed: 1, success_rate: 1,
          p50_tokens: 1000, p95_tokens: 2000, p50_dollars: null, p95_dollars: null, verified_artifacts_per_dollar: null,
          p50_dollars_estimate: 0.002, p95_dollars_estimate: null },
      ],
      recent_runs: [
        {
          run_id: 'run-unknown-1', loop_name: 'doc-drift', status: 'completed',
          verified_artifacts: 1, completed_unverified: 0, run_verified: true,
          dollars_spent: null, dollars_lower_bound: false, usage_coverage: { reported: 0, total: 2, ratio: 0 },
          efficiency: null, efficiency_reason: 'no_usage_reported',
        },
        {
          run_id: 'run-tariff-3', loop_name: 'doc-drift', status: 'completed',
          verified_artifacts: 1, completed_unverified: 0, run_verified: true,
          dollars_spent: null, dollars_lower_bound: false, dollars_reason: 'no_dated_model_price', usage_coverage: { reported: 1, total: 1, ratio: 1 },
          price_coverage: { priced: 0, partial: 0, total: 1, ratio: 0 }, efficiency: null, efficiency_reason: 'no_dated_model_price',
          runtime_tariff_estimate: { usd: 2, lower_bound: false },
        },
        {
          run_id: 'run-partial-2', loop_name: 'doc-drift', status: 'blocked',
          verified_artifacts: 0, completed_unverified: 3, run_verified: false,
          dollars_spent: 1.5, dollars_lower_bound: true, usage_coverage: { reported: 1, total: 2, ratio: 0.5 },
          efficiency: 0, efficiency_reason: 'partial_usage_upper_bound',
        },
      ],
      summary: {
        total_capabilities: 0, total_verified_artifacts: 1, total_completed_unverified: 3,
        total_dollars_spent: null, total_dollars_lower_bound: false, runs_with_unknown_dollars: 2,
      },
    }),
  },
}));

describe('EconomyPage', () => {
  it('renders unknown dollars and efficiency as "unknown", never $0, and shows completed_unverified separately', async () => {
    render(<EconomyPage />);
    const unknownRow = (await screen.findByText('run-unkn')).closest('tr')!;
    const cells = within(unknownRow).getAllByRole('cell').map((c) => c.textContent);
    // run, status, verified, completed-unverified, $ spent, efficiency
    expect(cells).toEqual(['run-unkn', 'completed', '1', '0', 'unknown', 'unknown']);

    const partialRow = screen.getByText('run-part').closest('tr')!;
    const partial = within(partialRow).getAllByRole('cell').map((c) => c.textContent);
    expect(partial).toEqual(['run-part', 'blocked', '0', '3', '≥ $1.5000', '≤ 0.00']);

    expect(screen.getByText('Completed, Unverified', { selector: 'div' })).toBeTruthy();
    expect(screen.getByText('2 run(s) without a dated model price')).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(screen.queryByText('$0.0000')).toBeNull();
  });

  it('CODE-007: a run priced only by the runtime tariff shows unknown dollars (estimate in the tooltip); a capability shows ~estimate', async () => {
    render(<EconomyPage />);
    const row = (await screen.findByText('run-tari')).closest('tr')!;
    const cells = within(row).getAllByRole('cell');
    expect(cells[4].textContent).toBe('unknown');
    expect(cells[4].getAttribute('title')).toContain('no dated model price');
    expect(cells[4].getAttribute('title')).toContain('runtime tariff estimate ~$2.0000');
    expect(cells[5].textContent).toBe('unknown');
    const cap = screen.getByText('cap-tariff-e').closest('tr')!;
    const capCells = within(cap).getAllByRole('cell').map((c) => c.textContent);
    expect(capCells.slice(4)).toEqual(['~$0.0020', 'unknown', '—']);
    expect(screen.queryByText('$2.0000')).toBeNull();
  });
});
