import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth-store';
import { FleetCockpitPage } from './FleetCockpitPage';

beforeEach(() => {
  useAuthStore.setState({ token: 't', user: { id: 'admin-fixture', email: 'admin@example.test', role: 'admin' } as never, isAuthenticated: true } as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ENVELOPE = 'BEGIN_EXTERNAL_CONTENT source=github_pull_request trust=untrusted\n{"title":"fix(tasks): real task totals","url":"https://github.com/djimit/djimitflo/pull/1247"}\nEND_EXTERNAL_CONTENT';
const ITEM = { goal_id: 'g1', goal_objective: ENVELOPE, loop_run_id: 'r1', loop_name: 'repo-maintenance-loop', run_status: 'running', lease_id: 'lease-1', role: 'maker',
  runtime: 'codex', lease_status: 'running', artifact_path: null, stdout_path: null, stderr_path: null, warning_count: 0, latest_gate: null, failed_gate: null,
  latest_event: null, next_safe_action: 'monitor', bottleneck_reason: null };

it('truth audit: the topology GOAL column shows a PR-wrapped objective as its title, marked external, never the raw envelope', async () => {
  vi.spyOn(api, 'getSwarmStatus').mockResolvedValue({ fleet_pools: [], fleet_topology: [ITEM, { ...ITEM, lease_id: 'lease-2', goal_objective: 'Add a test' }],
    resource_snapshot: { cpu_threads: 4, free_memory_bytes: 0, load_average: [] }, active_execution_count: 0, task_count: 0 } as never);
  vi.spyOn(api, 'planWorkerPool').mockResolvedValue({ decisions: [] } as never);
  vi.spyOn(api, 'getRuntimeContracts').mockResolvedValue({ runtimes: {} } as never);
  render(<MemoryRouter><FleetCockpitPage /></MemoryRouter>);
  const cell = await screen.findByTitle('fix(tasks): real task totals (from external content)');
  expect(cell.textContent).toBe('fix(tasks): real task totalsfrom external content'); // title, then the marker on its own line
  expect(screen.getByTitle('Add a test').textContent).toBe('Add a test');
  expect(document.body.textContent).not.toContain('BEGIN_EXTERNAL_CONTENT');
});
