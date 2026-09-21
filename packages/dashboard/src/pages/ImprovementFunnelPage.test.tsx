import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ImprovementFunnelPage } from './ImprovementFunnelPage';
import { api } from '../lib/api';

const funnel = {
  generatedAt: '2026-09-20T00:00:00Z',
  proposals: { total: 12, byStatus: { needs_more_evidence: 10, verified: 2 } },
  bySource: [{ source: 'reflection', total: 12, parked: 10, archived: 0, needsGrounding: 0, reachedGoal: 2, verified: 2, failed: 0 }],
  panel: { decisions: { goal: 2, needs_more_evidence: 8 }, goalRate: 0.2 },
  refinement: { originals: 1, children: 1, childOutcomes: { needs_more_evidence: 1 } },
  goals: { fromSelfImprovement: { completed: 2 } },
  learning: { cognitiveEpisodes: 5, cognitivePatterns: 0, cognitiveStrategies: 1, learningClosures: 2, memoryCandidates: {} },
  kpi: { windowDays: 7, verified: 2, regressed: 1, regressionRate: 1 / 3, panels24h: 40, panels7d: 200, panelsPerVerified: 100, medianHoursToVerified: 3.5, approvalsPerRun: 1 },
  hygiene: { zombieGoals: 4, staleRuns: 5, blockedBoardItems: 6 },
  queues: { openWorkItems: 3, workItemsByLoop: [{ loop: 'agent-board-review-loop', status: 'blocked', n: 3 }], commonsReviews: { completed: 4 } },
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ImprovementFunnelPage', () => {
  it('renders the funnel with conversion rates', async () => {
    vi.spyOn(api, 'getImprovementFunnel').mockResolvedValue(funnel);
    vi.spyOn(api, 'getPanelCalibration').mockResolvedValue({ specialists: [] });
    render(<ImprovementFunnelPage />);
    await waitFor(() => expect(screen.getByText('Panel goal rate')).toBeTruthy());
    expect(screen.getByText('20%')).toBeTruthy();
    expect(screen.getByText(/No proposal with an outcome yet/)).toBeTruthy();
  });

  it('shows the failure reason instead of an empty page', async () => {
    vi.spyOn(api, 'getImprovementFunnel').mockRejectedValue(new Error('boom-503'));
    vi.spyOn(api, 'getPanelCalibration').mockResolvedValue({ specialists: [] });
    render(<ImprovementFunnelPage />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('boom-503'));
  });
});
