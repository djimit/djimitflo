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
  kpi: { windowDays: 7, verified: 2, regressed: 1, regressionRate: 1 / 3, panels24h: 40, panels7d: 200, reviews24h: 120, reviews7d: 600, panelsPerVerified: 100, medianHoursToVerified: 3.5, approvalsPerRun: 1, runs: 10, runSuccessRate: 0.6, tokensPerVerified: 25000 },
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
    expect(screen.getByText('Run cost')).toBeTruthy();
    expect(screen.getByText('60%')).toBeTruthy();
    expect(screen.getByText('25,000')).toBeTruthy();
    expect(screen.getByText(/Data generated/)).toBeTruthy();
  });

  it('names the leaks first and shows the Commons inflow and investigation arms; an older server reports the inflow as unknown', async () => {
    vi.spyOn(api, 'getPanelCalibration').mockResolvedValue({ specialists: [] });
    vi.spyOn(api, 'getImprovementFunnel').mockResolvedValue(funnel);
    const { unmount } = render(<ImprovementFunnelPage />);
    await waitFor(() => expect(screen.getByText('Commons inflow')).toBeTruthy());
    expect(screen.getByText('not reported by this server')).toBeTruthy();
    expect(screen.getByText('80%')).toBeTruthy(); // 8 of 10 linked panel decisions asked for more evidence
    expect(screen.getByText('33%')).toBeTruthy();
    unmount();
    vi.spyOn(api, 'getImprovementFunnel').mockResolvedValue({ ...funnel, commons: { inflow: { cap: 0, state: 'disabled' }, proposals: 737, verified: 0, effectMinN: 30,
      evidenceEffect: [{ arm: 'commons_review', stuck: 68, refined: 66, decided: 6, verified: 0, regressed: 0, decidedRate: 6 / 68 }, { arm: 'investigated', stuck: 24, refined: 18, decided: 5, verified: 0, regressed: 0, decidedRate: null }, { arm: 'not_investigated', stuck: 1100, refined: 289, decided: 110, verified: 0, regressed: 1, decidedRate: 0.1 }] } });
    render(<ImprovementFunnelPage />);
    await waitFor(() => expect(screen.getByText('disabled')).toBeTruthy());
    expect(screen.getByText('0 verified of 737 proposals from Commons learnings, all time · reflection cap 0 per 24 h')).toBeTruthy();
    expect(screen.getByText('5 (insufficient, n < 30)')).toBeTruthy(); // 24 investigated: no rate
    expect(screen.getByText('110 (10%)')).toBeTruthy();
    expect(screen.getByText('Commons review fed the refinement')).toBeTruthy();
    expect(screen.getByText('6 (9%)')).toBeTruthy();
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
    expect(screen.getByText(/^18 of 307 refinements · 14 goals completed · 4 failed · 0 verified/)).toBeTruthy();
    expect(screen.getByText('30%')).toBeTruthy(); // 30 / 100 linked panels, not 30 / 605
    expect(screen.getByText('30 of 100 proposal-linked panel decisions (605 panels in total)')).toBeTruthy();
    expect(screen.getByText('Panels created')).toBeTruthy();
    expect(screen.getByText('Specialist reviews')).toBeTruthy();
    expect(screen.getByText('120')).toBeTruthy();
    expect(screen.queryByText('Panel reviews')).toBeNull();
  });

  it('truth audit 2026-11-12: a completed refinement goal is not a verified change — verified is shown explicitly', async () => {
    vi.spyOn(api, 'getImprovementFunnel').mockResolvedValue({ ...funnel,
      refinement: { originals: 307, children: 307, childOutcomes: { archived: 292, no_change: 14, regressed: 1 }, childGoals: { reachedGoal: 18, completed: 14, failed: 4, other: 0 } } });
    vi.spyOn(api, 'getPanelCalibration').mockResolvedValue({ specialists: [] });
    render(<ImprovementFunnelPage />);
    expect(await screen.findByText('18 of 307 refinements · 14 goals completed · 4 failed · 0 verified (14 ended no_change)')).toBeTruthy();
  });

  it('truth audit 2026-11-12: hygiene shows in-flight work items untouched for more than 14 days', async () => {
    vi.spyOn(api, 'getImprovementFunnel').mockResolvedValue({ ...funnel,
      hygiene: { zombieGoals: 0, staleRuns: 0, blockedBoardItems: 0, agedWorkItems: 16, agedWorkItemsByStatus: { blocked: 8, leased: 3, planned: 3, triaged: 2 }, agedWorkItemsOldest: '2026-09-08T20:30:04Z', agedWorkItemsDays: 14 } });
    vi.spyOn(api, 'getPanelCalibration').mockResolvedValue({ specialists: [] });
    render(<ImprovementFunnelPage />);
    expect(await screen.findByText('Aged work items')).toBeTruthy();
    expect(screen.getByText('16')).toBeTruthy();
    expect(screen.getByText('triaged/planned/leased/blocked, not updated for >14 d · 8 blocked, 3 leased, 3 planned, 2 triaged · oldest since 2026-09-08')).toBeTruthy();
  });

  it('truth audit 2026-11-12: a Brier score above 0.25 is flagged as worse than chance', async () => {
    vi.spyOn(api, 'getImprovementFunnel').mockResolvedValue(funnel);
    vi.spyOn(api, 'getPanelCalibration').mockResolvedValue({ specialists: [
      { specialistId: 'panel-a', n: 32, brier: 0.42, meanPredicted: 0.7, observedSuccessRate: 0.2, bins: [] },
      { specialistId: 'panel-b', n: 30, brier: 0.2, meanPredicted: 0.5, observedSuccessRate: 0.5, bins: [] },
    ] });
    render(<ImprovementFunnelPage />);
    expect(await screen.findByText('panel-a')).toBeTruthy();
    expect(screen.getAllByText(/worse than chance/)).toHaveLength(1);
    expect(screen.getByText(/worse than chance/).closest('tr')?.textContent).toContain('panel-a');
  });

  it('shows the failure reason instead of an empty page', async () => {
    vi.spyOn(api, 'getImprovementFunnel').mockRejectedValue(new Error('boom-503'));
    vi.spyOn(api, 'getPanelCalibration').mockResolvedValue({ specialists: [] });
    render(<ImprovementFunnelPage />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('boom-503'));
  });
});
