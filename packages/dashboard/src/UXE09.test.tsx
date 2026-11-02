import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from './lib/api';
import { useAuthStore } from './lib/auth-store';
import { visibleText } from './test/visible-text';
import { PolicyCenterPage } from './pages/PolicyCenterPage';
import { FederationPage } from './pages/FederationPage';
import { MCPPermissionsPage } from './pages/MCPPermissionsPage';
import { TasksPage } from './pages/TasksPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { SwarmMissionControlPage } from './pages/SwarmMissionControlPage';
import { ProofRunDetailPage } from './pages/ProofRunDetailPage';
import { FleetCockpitPage } from './pages/FleetCockpitPage';

// UXE-09: failures are visible text, never console-only or a native alert(); destructive swarm actions ask first.
beforeEach(() => {
  useAuthStore.setState({ token: 't', user: { id: 'admin-fixture', email: 'admin@example.test', role: 'admin' } as never, isAuthenticated: true } as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const alertText = async () => visibleText(await screen.findByRole('alert'));
const nativeAlert = () => vi.spyOn(window, 'alert').mockImplementation(() => {});

const POLICY = { id: 'p1', name: 'Block force push', description: 'Force pushes need approval', action_type: 'git_push', risk_level: 'high', decision: 'require_approval', enabled: true };

it('UXE-09: Policy Center shows a failed load as text, not an empty list', async () => {
  vi.spyOn(api, 'getPolicies').mockRejectedValue(new Error('Policy store unavailable'));
  render(<PolicyCenterPage />);
  expect(await alertText()).toContain('Could not load policies: Policy store unavailable');
});

it('UXE-09: a failed policy toggle shows the error and keeps the shown state', async () => {
  vi.spyOn(api, 'getPolicies').mockResolvedValue({ policies: [POLICY] as never });
  const update = vi.spyOn(api, 'updatePolicy').mockRejectedValue(new Error('Policy is locked'));
  render(<PolicyCenterPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Enabled' }));
  expect(await alertText()).toContain('Could not update policy Block force push: Policy is locked');
  expect(update).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Enabled' })).not.toBeNull();
});

it('UXE-09: Federation shows failed loads and a failed registration as text', async () => {
  const request = vi.spyOn(api, 'request').mockImplementation(async (path: string) => {
    if (path === '/federation/peers') throw new Error('Peer table unavailable');
    if (path === '/federation/capabilities') return { capabilities: [] } as never;
    throw new Error('Peer URL rejected');
  });
  render(<FederationPage />);
  expect(await alertText()).toContain('peers: Peer table unavailable');
  fireEvent.click(screen.getByRole('button', { name: /Register Peer/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Register' }));
  await waitFor(() => expect(screen.getAllByRole('alert').map(visibleText).join(' ')).toContain('Could not register peer: Peer URL rejected'));
  expect(request.mock.calls.filter(([path]) => path === '/federation/register')).toHaveLength(1);
});

it('UXE-09: MCP Permissions shows failed loads as text, not as "none registered"', async () => {
  vi.spyOn(api, 'getMCPServers').mockRejectedValue(new Error('Server registry offline'));
  vi.spyOn(api, 'getMCPPermissions').mockRejectedValue(new Error('Permission catalog offline'));
  render(<MCPPermissionsPage />);
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
  const text = screen.getAllByRole('alert').map(visibleText).join(' ');
  expect(text).toContain('Could not load MCP servers: Server registry offline');
  expect(text).toContain('Could not load MCP permissions: Permission catalog offline');
  expect(screen.queryByText('No MCP servers registered.')).toBeNull();
  expect(screen.queryByText('No tool-level permissions configured yet.')).toBeNull();
});

it('UXE-09: a failed task creation shows an inline notice, not a native alert', async () => {
  const native = nativeAlert();
  vi.spyOn(api, 'getRuntimeContracts').mockResolvedValue({ runtimes: {} } as never);
  vi.spyOn(api, 'getRepositories').mockResolvedValue({ repositories: [] });
  vi.spyOn(api, 'createTask').mockRejectedValue(new Error('Task queue full'));
  render(<MemoryRouter><TasksPage /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'New Task' }));
  fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Fixture task' } });
  fireEvent.change(screen.getByLabelText('Task description'), { target: { value: 'Fixture description' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
  expect(await alertText()).toContain('Could not create task: Task queue full');
  expect(native).not.toHaveBeenCalled();
});

const TASK = (status: string) => ({ id: 'task-fixture', title: 'Fixture task', description: '', status, priority: 'medium', risk_level: 'low', execution_mode: 'review_only', tags: [], metadata: { executor: 'codex' }, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' });
const openTask = (status: string) => {
  vi.spyOn(api, 'getTask').mockResolvedValue(TASK(status) as never);
  vi.spyOn(api, 'getExecutionEvents').mockResolvedValue({ events: [] } as never);
  vi.spyOn(api, 'getApprovals').mockResolvedValue({ approvals: [] });
  vi.spyOn(api, 'getRuntimeContracts').mockResolvedValue({ runtimes: { codex: { available: true } } } as never);
  render(<MemoryRouter initialEntries={['/tasks/task-fixture']}><Routes><Route path="/tasks/:taskId" element={<TaskDetailPage />} /></Routes></MemoryRouter>);
};

it('UXE-09: a failed task execution shows an inline notice, not a native alert', async () => {
  const native = nativeAlert();
  vi.spyOn(api, 'executeTask').mockRejectedValue(new Error('Runtime busy'));
  openTask('pending');
  const execute = await screen.findByRole('button', { name: 'Execute' });
  await waitFor(() => expect((execute as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(execute);
  expect(await alertText()).toContain('Could not execute task: Runtime busy');
  expect(native).not.toHaveBeenCalled();
});

it('UXE-09: a failed task cancel shows an inline notice, not a native alert', async () => {
  const native = nativeAlert();
  const cancel = vi.spyOn(api, 'cancelTask').mockRejectedValue(new Error('Worker already gone'));
  openTask('running');
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel task' }));
  expect(await alertText()).toContain('Could not cancel task: Worker already gone');
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(native).not.toHaveBeenCalled();
});

const PROOF_RUN = {
  id: 'proof-fixture', status: 'completed', runtime: 'opencode', created_at: '2026-10-01T00:00:00Z', completed_at: '2026-10-01T00:01:00Z',
  rollback_safe: true, counts: { goals: 1 }, artifact_refs: { goal: 'goal-fixture', loop_run: 'loop-fixture', worker_leases: [], panel: null, memory_candidate: null },
  minimums: { goals: 1 }, passed: true, proof_class: 'demo', production_passed: false, production_missing: [], missing: {}, narrative: ['Plan persisted'],
};

/** Opens the confirm dialog with `open`, then cancels or confirms it. */
async function decide(open: () => unknown, choice: 'cancel' | 'confirm', confirmLabel: string) {
  await open();
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: choice === 'cancel' ? 'Cancel' : confirmLabel }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  return dialog;
}

function openMissionControl() {
  const zero = { total: 0, loaded: 0, registry_total: 0, validated: 0, routable: 0, blocked: 0, contradicted: 0, proposed: 0, supported: 0, consensus_ready: 0, blocked_or_needs_evidence: 0 };
  vi.spyOn(api, 'getSwarmMissionControl').mockResolvedValue({
    swarm_truth: { registry_agent_count: 0, live_agent_count: 0, prepared_leases: 0, running_leases: 0, active_execution_count: 0, current_executions: [], registry_is_not_execution: true },
    capability_health: zero, claim_health: zero, specialist_panels: zero, execution_node: { cockpit: 'host-a', workers_run_on: 'host-b' },
    capacity: null, next_safe_actions: [], skill_evolution: [], latest_proof_run: PROOF_RUN,
  } as never);
  vi.spyOn(api, 'getSwarmCapabilities').mockResolvedValue({ capabilities: [] });
  vi.spyOn(api, 'getSwarmClaims').mockResolvedValue({ claims: [] } as never);
  vi.spyOn(api, 'getKnowledgeRuntime').mockRejectedValue(new Error('not in fixture'));
  vi.spyOn(api, 'request').mockRejectedValue(new Error('not in fixture'));
  const rollback = vi.spyOn(api, 'rollbackProofRun').mockResolvedValue({ ...PROOF_RUN, status: 'rolled_back' } as never);
  render(<MemoryRouter><SwarmMissionControlPage /></MemoryRouter>);
  return rollback;
}

it('UXE-09: Mission Control rollback asks first; cancel makes no call', async () => {
  const rollback = openMissionControl();
  const button = await screen.findByRole('button', { name: 'Rollback' });
  const dialog = await decide(() => fireEvent.click(button), 'cancel', 'Roll back');
  expect(visibleText(dialog)).toContain('Roll back proof run proof-fixture?');
  expect(rollback).not.toHaveBeenCalled();
});

it('UXE-09: Mission Control rollback runs exactly once on confirm', async () => {
  const rollback = openMissionControl();
  await decide(async () => fireEvent.click(await screen.findByRole('button', { name: 'Rollback' })), 'confirm', 'Roll back');
  await waitFor(() => expect(rollback).toHaveBeenCalledTimes(1));
  expect(rollback).toHaveBeenCalledWith('proof-fixture');
});

function openProofRun() {
  vi.spyOn(api, 'getProofRun').mockResolvedValue(PROOF_RUN as never);
  const rollback = vi.spyOn(api, 'rollbackProofRun').mockResolvedValue({ ...PROOF_RUN, status: 'rolled_back', rollback_safe: false } as never);
  render(<MemoryRouter initialEntries={['/p/proof-fixture']}><Routes><Route path="/p/:proofRunId" element={<ProofRunDetailPage />} /></Routes></MemoryRouter>);
  return rollback;
}

it('UXE-09: proof-run detail rollback asks first; cancel makes no call', async () => {
  const rollback = openProofRun();
  const button = await screen.findByRole('button', { name: 'Rollback this proof run' });
  const dialog = await decide(() => fireEvent.click(button), 'cancel', 'Roll back');
  expect(visibleText(dialog)).toContain('cannot be undone');
  expect(rollback).not.toHaveBeenCalled();
});

it('UXE-09: proof-run detail rollback runs exactly once on confirm', async () => {
  const rollback = openProofRun();
  const button = await screen.findByRole('button', { name: 'Rollback this proof run' });
  await decide(() => fireEvent.click(button), 'confirm', 'Roll back');
  await waitFor(() => expect(screen.getByText('rolled back')).not.toBeNull());
  expect(rollback).toHaveBeenCalledTimes(1);
});

const DECISION = (lease_id: string, status: string, eligible: boolean) => ({
  lease_id, role: 'maker', effective_runtime: 'opencode', risk_class: 'low', queue_age_ms: 1000, priority_score: 5,
  next_action: status === 'running' ? 'monitor' : 'start', status, eligible, blocked_reasons: [], bottleneck_reason: null,
});

function openFleet() {
  vi.spyOn(api, 'getSwarmStatus').mockResolvedValue({ fleet_pools: [], fleet_topology: [], resource_snapshot: { cpu_threads: 4, free_memory_bytes: 0, load_average: [] }, active_execution_count: 0, task_count: 0 } as never);
  vi.spyOn(api, 'planWorkerPool').mockResolvedValue({ decisions: [DECISION('lease-running', 'running', false), DECISION('lease-prepared', 'prepared', true)] } as never);
  vi.spyOn(api, 'getRuntimeContracts').mockResolvedValue({ runtimes: {} } as never);
  const drain = vi.spyOn(api, 'drainWorkerPool').mockResolvedValue({} as never);
  const stop = vi.spyOn(api, 'stopWorkerLease').mockResolvedValue({} as never);
  render(<MemoryRouter><FleetCockpitPage /></MemoryRouter>);
  return { drain, stop };
}

it('UXE-09: Fleet drain asks first with the worker cap; cancel makes no call, confirm exactly one', async () => {
  const { drain } = openFleet();
  const button = await screen.findByRole('button', { name: 'Drain' });
  const dialog = await decide(() => fireEvent.click(button), 'cancel', 'Drain');
  expect(visibleText(dialog)).toContain('Starts up to 2 eligible workers on opencode');
  expect(drain).not.toHaveBeenCalled();
  await decide(() => fireEvent.click(screen.getByRole('button', { name: 'Drain' })), 'confirm', 'Drain');
  await waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
});

it('UXE-09: Fleet stop asks first naming the lease; cancel makes no call, confirm exactly one', async () => {
  const { stop } = openFleet();
  const button = await screen.findByRole('button', { name: 'Stop' });
  const dialog = await decide(() => fireEvent.click(button), 'cancel', 'Stop lease');
  expect(visibleText(dialog)).toContain('Stop worker lease lease-running?');
  expect(stop).not.toHaveBeenCalled();
  await decide(() => fireEvent.click(screen.getByRole('button', { name: 'Stop' })), 'confirm', 'Stop lease');
  await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  expect(stop).toHaveBeenCalledWith('lease-running');
});
