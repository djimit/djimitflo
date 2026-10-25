import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { useStore } from '../lib/store';
import { SwarmOverviewPage } from './SwarmOverviewPage';

afterEach(() => { cleanup(); useStore.setState({ agents: [], tasks: [] }); vi.unstubAllGlobals(); });

const agents = [
  { id: 'a1', name: 'Live one', status: 'active', liveness: 'live', total_token_usage: 0, total_execution_time_ms: 0, total_tasks: 0, capabilities: [] },
  { id: 'a2', name: 'Stale two', status: 'active', liveness: 'stale', total_token_usage: 0, total_execution_time_ms: 0, total_tasks: 0, capabilities: [] },
  { id: 'a3', name: 'Stale three', status: 'active', liveness: 'unknown', total_token_usage: 0, total_execution_time_ms: 0, total_tasks: 0, capabilities: [] },
];
function stub(usage: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = url.startsWith('/api/swarms/usage-window') ? usage
      : url.startsWith('/api/swarms/status') ? { fleet_pools: [{ runtime: 'codex', running_leases: 2, prepared_leases: 5, recommended_concurrency: 1 }], resource_snapshot: {} }
      : url.startsWith('/api/swarms/intelligence/capabilities') ? { capabilities: [{ id: 'cap-1', status: 'candidate', kind: 'skill' }], registry_total: 512, loaded: 100, limit: 100 }
      : url.startsWith('/api/agents') ? { agents }
      : url.startsWith('/api/tasks') ? { tasks: [] }
      : url.startsWith('/api/discussions') ? { discussions: [] }
      : url.startsWith('/api/learning') ? { learnings: [{ id: 'l1', title: 'Old curated note', category: 'pattern', description: 'x', created_at: '2026-07-14T10:00:00Z' }] }
      : null;
    if (body === null) throw new Error(`unexpected ${url}`);
    return { ok: true, status: 200, json: async () => body };
  }));
}

it('SW-01: tokens come from the windowed usage ledger (unknown = unknown), active = live, lifetime counters are not summed', async () => {
  stub({ window_days: 7, events: 0, known_events: 0, total_tokens: null, coverage: null, status: 'UNKNOWN' });
  useStore.setState({ agents: agents as any });
  render(<MemoryRouter><SwarmOverviewPage /></MemoryRouter>);
  expect((await screen.findByTestId('swarm-tokens')).textContent).toBe('unknown');
  expect(screen.getByTestId('swarm-live-agents').textContent).toBe('1');
  expect(screen.getByText(/3 registered active · 2 running leases/)).toBeTruthy();
  expect(screen.getByTestId('swarm-exec-time').textContent).toBe('not recorded');
  // learning feed names its source and date
  expect(await screen.findByText(/swarm_learning · curated notes/)).toBeTruthy();
  expect(screen.getByText(/2026-07-14/)).toBeTruthy();
  // registry vs loaded capabilities
  expect(await screen.findByText(/100 loaded of 512 in the registry/)).toBeTruthy();
});

it('SW-01: known windowed tokens are shown with the window and their coverage', async () => {
  stub({ window_days: 7, events: 3, known_events: 2, total_tokens: 1_234_567, coverage: 0.667, status: 'partial' });
  useStore.setState({ agents: agents as any });
  render(<MemoryRouter><SwarmOverviewPage /></MemoryRouter>);
  expect((await screen.findByTestId('swarm-tokens')).textContent).toBe('1.2M');
  expect(screen.getByText(/last 7 d · 2\/3 usage records reported \(67 %\)/)).toBeTruthy();
});
