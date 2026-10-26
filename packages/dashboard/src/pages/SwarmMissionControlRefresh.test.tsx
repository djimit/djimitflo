import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type SwarmMissionControl } from '../lib/api';
import { SwarmMissionControlPage } from './SwarmMissionControlPage';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mockSources() {
  vi.spyOn(api, 'getSwarmMissionControl').mockRejectedValue(new Error('core read unavailable'));
  vi.spyOn(api, 'getSwarmCapabilities').mockResolvedValue({ capabilities: [], limit: 50 } as any);
  vi.spyOn(api, 'getSwarmClaims').mockResolvedValue({ claims: [] } as any);
  vi.spyOn(api, 'getKnowledgeRuntime').mockResolvedValue(null as any);
  return vi.spyOn(api, 'request').mockImplementation(async (path) => {
    if (path === '/swarms/intelligence/missions/execution?limit=20') return { missions: [], totals: { registered: 0, loaded: 0, by_planning_status: {}, by_goal_status: {} } } as any;
    return { events: [] } as any;
  });
}

function openPage() {
  return render(<MemoryRouter><SwarmMissionControlPage /></MemoryRouter>);
}

const zeroMission = {
  swarm_truth: { registry_agent_count: 0, live_agent_count: 0, prepared_leases: 0, running_leases: 0, active_execution_count: 0 },
  execution_node: {}, capability_health: {}, claim_health: {}, specialist_panels: {},
} as SwarmMissionControl;

it('does not report absent execution or health readings as measured zero', async () => {
  mockSources();
  openPage();
  await waitFor(() => expect((screen.getByTitle('Refresh') as HTMLButtonElement).disabled).toBe(false));
  for (const label of ['Registry', 'Live Agents', 'Prepared', 'Running', 'Active Exec']) {
    const metric = screen.getAllByText(label).find((node) => node.className.includes('mt-2'))!;
    expect(metric.parentElement!.textContent).toContain('unknown');
  }
  expect(screen.getByText(/validated unknown/)).toBeTruthy();
  expect(screen.getByText(/blocked\/evidence unknown/)).toBeTruthy();
});

it('preserves a measured execution count of zero', async () => {
  mockSources();
  vi.mocked(api.getSwarmMissionControl).mockResolvedValue(zeroMission);
  openPage();
  await waitFor(() => expect((screen.getByTitle('Refresh') as HTMLButtonElement).disabled).toBe(false));
  const label = screen.getByText('Active Exec');
  expect(label.parentElement!.textContent).toBe('0Active Exec');
});

it('shows fast core evidence without waiting for a slow optional learning read', async () => {
  const request = mockSources();
  vi.mocked(api.getSwarmMissionControl).mockResolvedValue(zeroMission);
  const ordinaryRead = request.getMockImplementation()!;
  request.mockImplementation((path, options) => path === '/swarms/learning-curve' ? new Promise(() => {}) : ordinaryRead(path, options));
  openPage();
  await waitFor(() => expect(screen.getByText('Active Exec').parentElement!.textContent).toBe('0Active Exec'));
  await waitFor(() => expect((screen.getByTitle('Refresh') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTitle('Refresh'));
  await waitFor(() => expect(vi.mocked(api.getSwarmMissionControl)).toHaveBeenCalledTimes(2));
});

it('reports a failed core source even when optional evidence has not settled', async () => {
  const request = mockSources();
  request.mockImplementation(() => new Promise(() => {}));
  openPage();
  await screen.findByText('mission control: core read unavailable');
  await waitFor(() => expect((screen.getByTitle('Refresh') as HTMLButtonElement).disabled).toBe(false));
});

it('does not let an obsolete request overwrite a newer refresh', async () => {
  mockSources();
  let finishOld!: (value: SwarmMissionControl) => void;
  vi.mocked(api.getSwarmMissionControl)
    .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
    .mockResolvedValue(zeroMission);
  render(<StrictMode><MemoryRouter><SwarmMissionControlPage /></MemoryRouter></StrictMode>);
  await waitFor(() => expect(screen.getByText('Active Exec').parentElement!.textContent).toBe('0Active Exec'));
  await act(async () => { finishOld({ ...zeroMission, swarm_truth: { ...zeroMission.swarm_truth, active_execution_count: 9 } }); });
  expect(screen.getByText('Active Exec').parentElement!.textContent).toBe('0Active Exec');
});

it('refresh retries all seven read sources and clears recovered source errors', async () => {
  const request = mockSources();
  let failed = true;
  request.mockImplementation(async (path) => {
    if (failed) throw new Error(`unavailable ${path}`);
    if (path === '/swarms/learning-curve') return { runs: [], cohorts: [], registered_readouts: [], min_n_per_window: 10, window: { days: 7 } } as any;
    if (path === '/swarms/intelligence/missions/execution?limit=20') return { missions: [], totals: { registered: 0, loaded: 0, by_planning_status: {}, by_goal_status: {} } } as any;
    return { events: [] } as any;
  });
  openPage();
  await screen.findByText(/learning curve: unavailable/);
  await waitFor(() => expect((screen.getByTitle('Refresh') as HTMLButtonElement).disabled).toBe(false));
  failed = false;
  fireEvent.click(screen.getByTitle('Refresh'));
  await waitFor(() => expect(request.mock.calls.filter(([path]) => path === '/swarms/learning-curve')).toHaveLength(2));
  for (const path of ['/knowledge/events?limit=20', '/swarms/intelligence/missions/execution?limit=20']) {
    expect(request.mock.calls.filter(([value]) => value === path)).toHaveLength(2);
  }
  for (const source of [api.getSwarmMissionControl, api.getSwarmCapabilities, api.getSwarmClaims, api.getKnowledgeRuntime]) expect(source).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.queryByText(/learning curve: unavailable/)).toBeNull());
  expect(screen.getByText(/mission control: core read unavailable/)).toBeTruthy();
});
