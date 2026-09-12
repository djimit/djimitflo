import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, type WorkItemRecord } from '../lib/api';
import { SwarmResourcesPage } from './SwarmResourcesPage';

const item = (patch: Partial<WorkItemRecord> = {}): WorkItemRecord => ({
  id: 'fixture', title: 'Disposable backlog item', description: 'No worker execution', source: 'manual',
  source_ref: null, risk_class: 'low', value_score: 50, confidence: 0.5, status: 'candidate',
  recommended_loop: null, assigned_agent_id: null, assigned_runtime: null, parent_goal_id: null,
  metadata: {}, created_at: '', updated_at: '', ...patch,
});

beforeEach(() => {
  vi.spyOn(api, 'getSwarmStatus').mockResolvedValue(null as any);
  vi.spyOn(api, 'getMemoryCandidates').mockResolvedValue({ candidates: [] });
  vi.spyOn(api, 'getSpecialistCatalog').mockResolvedValue({ specialists: [] } as any);
  vi.spyOn(api, 'getSpecialistPanels').mockResolvedValue({ panels: [] });
  vi.spyOn(api, 'getAssuranceSummary').mockResolvedValue(null as any);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(['planned', 'leased'] as const)('does not reconvert linked %s work and shows its actual goal identity', async (status) => {
  vi.spyOn(api, 'getWorkItems').mockResolvedValue({ work_items: [item({ status, parent_goal_id: 'actual-goal' })] });
  const convert = vi.spyOn(api, 'convertWorkItemToGoal');
  render(<SwarmResourcesPage />);
  await screen.findByText('Disposable backlog item');
  expect(screen.getByRole('button', { name: 'Goal' })).toHaveProperty('disabled', true);
  expect(screen.getByText(/actual-goal/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Goal' }));
  expect(convert).not.toHaveBeenCalled();
});

it.each(['blocked', 'planned', 'leased', 'done', 'discarded'] as const)('does not offer a new goal for %s work', async (status) => {
  vi.spyOn(api, 'getWorkItems').mockResolvedValue({ work_items: [item({ status })] });
  render(<SwarmResourcesPage />);
  await screen.findByText('Disposable backlog item');
  expect(screen.getByRole('button', { name: 'Goal' })).toHaveProperty('disabled', true);
});

it('converts eligible work once, reloads the persisted link, and does not execute it', async () => {
  vi.spyOn(api, 'getWorkItems').mockResolvedValueOnce({ work_items: [item()] }).mockResolvedValue({ work_items: [item({ status: 'planned', parent_goal_id: 'actual-goal' })] });
  const convert = vi.spyOn(api, 'convertWorkItemToGoal').mockResolvedValue({ work_item: item({ status: 'planned', parent_goal_id: 'actual-goal' }), goal_id: 'actual-goal' });
  const execute = vi.spyOn(api, 'startNextWorker');
  render(<SwarmResourcesPage />);
  await screen.findByText('Disposable backlog item');
  fireEvent.click(screen.getByRole('button', { name: 'Goal' }));
  await waitFor(() => expect(convert).toHaveBeenCalledExactlyOnceWith('fixture'));
  await screen.findByText(/actual-goal/);
  expect(screen.getByRole('button', { name: 'Goal' })).toHaveProperty('disabled', true);
  expect(execute).not.toHaveBeenCalled();
});

it('shows a rejected conversion without inventing a goal', async () => {
  vi.spyOn(api, 'getWorkItems').mockResolvedValue({ work_items: [item()] });
  vi.spyOn(api, 'convertWorkItemToGoal').mockRejectedValue(new Error('Conversion conflict'));
  render(<SwarmResourcesPage />);
  await screen.findByText('Disposable backlog item');
  fireEvent.click(screen.getByRole('button', { name: 'Goal' }));
  expect(await screen.findByText('Conversion conflict')).toBeTruthy();
  expect(screen.queryByText(/Goal ID:/)).toBeNull();
});
