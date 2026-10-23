import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GovernanceScorecardPage } from './GovernanceScorecardPage';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    getOpenMythosLeaderboard: vi.fn().mockResolvedValue({
      leaderboard: [
        {
          agentId: 'agent-a',
          overallScore: 3.5,
          categoryScores: { injection: 4.0, hallucination: 2.1 },
          totalCases: 78,
          lastEvalAt: '2026-07-15T10:05:00.000Z',
          trend: 'improving',
        },
      ],
    }),
    getOpenMythosRuns: vi.fn().mockResolvedValue({
      runs: [
        {
          id: 'run-12345678',
          agentId: 'agent-a',
          status: 'completed',
          totalCases: 78,
          completedCases: 78,
          overallScore: 3.5,
          subjectModel: 'llama3.1:8b',
          oracleCases: 78,
          judgeCases: 0,
          startedAt: '2026-07-15T10:00:00.000Z',
          finishedAt: '2026-07-15T10:05:00.000Z',
        },
      ],
    }),
  },
}));

describe('GovernanceScorecardPage', () => {
  it('renders the leaderboard with scores, trend, and category chips', async () => {
    render(<GovernanceScorecardPage />);

    expect(screen.getByText('Governance Scorecard')).toBeTruthy();
    expect((await screen.findAllByText('agent-a')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('3.50').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('improving')).toBeTruthy();
    expect(screen.getByText('injection 4.0')).toBeTruthy();
    expect(screen.getByText('hallucination 2.1')).toBeTruthy();
  });

  it('renders the recent runs with model and oracle provenance', async () => {
    render(<GovernanceScorecardPage />);

    expect(await screen.findByText('llama3.1:8b')).toBeTruthy();
    expect(screen.getByText('completed')).toBeTruthy();
    expect(screen.getByText(/78 oracle/)).toBeTruthy();
  });

  it('DF-01: never ranks a 0-100 critic score together with 0-5 model scores', async () => {
    vi.mocked(api.getOpenMythosLeaderboard).mockResolvedValueOnce({
      // An older server returned the critic row inside the 0-5 leaderboard.
      leaderboard: [
        { agentId: 'explainer-critic', overallScore: 93, categoryScores: {}, totalCases: 6, lastEvalAt: '2026-07-16T10:00:00.000Z', trend: 'stable' },
        { agentId: 'agent-model', overallScore: 4.2, categoryScores: {}, totalCases: 78, lastEvalAt: '2026-07-15T10:05:00.000Z', trend: 'stable', scale: '0-5', benchmark: 'openmythos-governance', cohort: 'openmythos-governance:0-5' },
      ],
    } as any);
    render(<GovernanceScorecardPage />);

    const ranking = await screen.findByRole('list', { name: 'Governance ranking (0–5)' });
    expect(ranking.textContent).toContain('#1');
    expect(ranking.textContent).toContain('agent-model');
    expect(ranking.textContent).not.toContain('explainer-critic');
    expect(ranking.textContent).not.toContain('93');
    const other = screen.getByRole('list', { name: 'Other score scales' });
    expect(other.textContent).toContain('explainer-critic');
    expect(other.textContent).not.toContain('#');
    expect(screen.queryByText('93.00')).toBeNull();
  });
});
