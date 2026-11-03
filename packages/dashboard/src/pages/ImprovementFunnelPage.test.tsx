import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ImprovementFunnelPage } from './ImprovementFunnelPage';
import { api } from '../lib/api';

const funnel = {
  generatedAt: '2026-09-20T00:00:00Z',
  proposals: { total: 12, byStatus: { needs_more_evidence: 10, verified: 2 } },
  bySource: [{ source: 'reflection', total: 12, parked: 10, archived: 0, needsGrounding: 0, reachedGoal: 2, verified: 2, failed: 0 }],
  panel: { decisions: { goal: 2, needs_more_evidence: 8 }, goalRate: 0.2, linkedPanels: 10, linkedDecided: 10, linkedDecisions: { goal: 2, needs_more_evidence: 8 } },
  refinement: { originals: 1, children: 1, childOutcomes: { needs_more_evidence: 1 }, childGoals: { reachedGoal: 0, completed: 0, failed: 0, other: 0 } },
  goals: { fromSelfImprovement: { completed: 2 } },
  learning: { cognitiveEpisodes: 5, cognitivePatterns: 0, cognitiveStrategies: 1, learningClosures: 2, memoryCandidates: {} },
  kpi: { windowDays: 7, verified: 2, regressed: 1, regressionRate: 1 / 3, panels24h: 40, panels7d: 200, reviews24h: 120, reviews7d: 600, panelsPerVerified: 100, medianHoursToVerified: 3.5, approvalsPerRun: 1 },
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

  it('DF-01/02/03: refinement conversion comes from linked goals, goal rate from linked panels, panels and reviews are labelled apart', async () => {
    // prod 2026-10-23: 307 refined children, statuses 292 archived / 14 no_change / 1 regressed, 18 with a goal (14 completed, 4 failed);
    // 505 panels no proposal points at
    vi.spyOn(api, 'getImprovementFunnel').mockResolvedValue({ ...funnel,
      panel: { decisions: { goal: 30, needs_more_evidence: 575 }, goalRate: 0.3, linkedPanels: 100, linkedDecided: 100, linkedDecisions: { goal: 30, needs_more_evidence: 70 } },
      refinement: { originals: 307, children: 307, childOutcomes: { archived: 292, no_change: 14, regressed: 1 }, childGoals: { reachedGoal: 18, completed: 14, failed: 4, other: 0 } },
    });
    vi.spyOn(api, 'getPanelCalibration').mockResolvedValue({ specialists: [] });
    render(<ImprovementFunnelPage />);
    await waitFor(() => expect(screen.getByText('Refinement reached goal')).toBeTruthy());
    expect(screen.getByText('6%')).toBeTruthy(); // 18 / 307, not the status-derived 0 %
    expect(screen.getByText('18 of 307 refinements · 14 completed · 4 failed')).toBeTruthy();
    expect(screen.getByText('30%')).toBeTruthy(); // 30 / 100 linked panels, not 30 / 605
    expect(screen.getByText('30 of 100 proposal-linked panel decisions (605 panels in total)')).toBeTruthy();
    expect(screen.getByText('Panels created')).toBeTruthy();
    expect(screen.getByText('Specialist reviews')).toBeTruthy();
    expect(screen.getByText('120')).toBeTruthy();
    expect(screen.queryByText('Panel reviews')).toBeNull();
  });

  it('shows the failure reason instead of an empty page', async () => {
    vi.spyOn(api, 'getImprovementFunnel').mockRejectedValue(new Error('boom-503'));
    vi.spyOn(api, 'getPanelCalibration').mockResolvedValue({ specialists: [] });
    render(<ImprovementFunnelPage />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('boom-503'));
  });
});
