import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { CognitiveRuntimePage } from './CognitiveRuntimePage';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const stats = { totalEpisodes: 10, totalPatterns: 2, totalStrategies: 2, overallSuccessRate: 0.5, bestGoalType: 'fixture' };

it('renders recorded results without claiming strategy application or causal improvement', async () => {
  vi.spyOn(api, 'getCognitiveStats').mockResolvedValue(stats);
  vi.spyOn(api, 'getCognitiveMetaLearning').mockResolvedValue({ records: [] });
  render(<CognitiveRuntimePage />);
  expect(await screen.findByText('50%')).toBeTruthy();
  expect(screen.getByText(/strategy actions are not automatically applied/)).toBeTruthy();
  expect(screen.queryByText(/pre-selected for future loops/)).toBeNull();
});

it('does not turn unavailable evidence into an empty success state and can retry', async () => {
  vi.spyOn(api, 'getCognitiveStats').mockResolvedValue(stats);
  vi.spyOn(api, 'getCognitiveMetaLearning').mockRejectedValueOnce(new Error('Evidence offline')).mockResolvedValue({ records: [] });
  render(<CognitiveRuntimePage />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Evidence offline');
  expect(screen.queryByText(/No strategy evidence yet/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('50%')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});
