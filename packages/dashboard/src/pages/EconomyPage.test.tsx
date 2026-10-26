import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { EconomyPage } from './EconomyPage';

vi.mock('../lib/api', () => ({
  api: {
    request: vi.fn().mockResolvedValue({
      capabilities: [],
      recent_runs: [
        {
          run_id: 'run-unknown-1', loop_name: 'doc-drift', status: 'completed',
          verified_artifacts: 1, completed_unverified: 0, run_verified: true,
          dollars_spent: null, dollars_lower_bound: false, usage_coverage: { reported: 0, total: 2, ratio: 0 },
          efficiency: null, efficiency_reason: 'no_usage_reported',
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
    expect(screen.getByText('2 run(s) reported no usage')).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(screen.queryByText('$0.0000')).toBeNull();
  });
});
