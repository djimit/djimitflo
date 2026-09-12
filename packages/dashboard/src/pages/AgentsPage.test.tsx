import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../../../server/src/database/schema';
import { NlAgentFactory } from '../../../server/src/services/nl-agent-factory';
import { useStore } from '../lib/store';
import { useAuthStore } from '../lib/auth-store';
import { AgentsPage } from './AgentsPage';

afterEach(() => { cleanup(); localStorage.clear(); useStore.setState({ agents: [], tasks: [] }); useAuthStore.setState({ user: null, token: null, isAuthenticated: false }); vi.unstubAllGlobals(); });

it('renders the actual factory pending-approval record without activating it', () => {
  const db = new Database(':memory:');
  try {
    db.exec(schema);
    const created = new NlAgentFactory(db).createFromDescription('Read fixture documentation', { name: 'Disposable NL draft' });
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(created.id) as any;
    useStore.setState({ agents: [{ ...row, capabilities: JSON.parse(row.capabilities), metadata: JSON.parse(row.metadata) }] });
    render(<MemoryRouter><AgentsPage /></MemoryRouter>);
    expect(screen.getByText('Disposable NL draft')).toBeTruthy();
    expect(screen.getByText('pending_approval')).toBeTruthy();
    expect(db.prepare('SELECT status FROM agents WHERE id = ?').get(created.id)).toEqual({ status: 'pending_approval' });
  } finally { db.close(); }
});

it('keeps unknown provider status visible without crashing the entire registry', () => {
  useStore.setState({ agents: [{ id: 'fixture', name: 'Unexpected status', status: 'future_status', capabilities: [], total_tasks: 0, completed_tasks: 0, failed_tasks: 0 }] as any });
  render(<MemoryRouter><AgentsPage /></MemoryRouter>);
  expect(screen.getByText('future_status')).toBeTruthy();
});

it('distinguishes an offline retired agent from temporary offline status', () => {
  useStore.setState({ agents: [{ id: 'fixture', name: 'Retired fixture', status: 'offline', retired_at: '2026-09-09T12:00:00Z', retirement_reason: 'Fixture decommission', capabilities: [], total_tasks: 0, completed_tasks: 0, failed_tasks: 0 }] as any });
  render(<MemoryRouter><AgentsPage /></MemoryRouter>);
  expect(screen.getByText('offline')).toBeTruthy();
  expect(screen.getByText(/Retired at/)).toBeTruthy();
  expect(screen.getByText(/Fixture decommission/)).toBeTruthy();
});

it('shows and releases a real governance hold only to governance writers, with server refresh', async () => {
  localStorage.setItem('djimitflo_auth_session', 'fixture-admin-token');
  useAuthStore.setState({ user: { id: 'admin', role: 'admin' } as any, token: 'fixture-admin-token', isAuthenticated: true });
  useStore.setState({ agents: [{ id: 'governed-agent', name: 'Governed agent', description: '', status: 'idle', capabilities: [], total_tasks: 0, completed_tasks: 0, failed_tasks: 0 }] as any });
  let released = false;
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/runtime-governance/agents/governed-agent/release') && options?.method === 'POST') {
      released = true;
      return { ok: true, status: 200, json: async () => ({ released: true, agentId: 'governed-agent' }) };
    }
    if (url.endsWith('/runtime-governance/agents/governed-agent')) {
      return { ok: true, status: 200, json: async () => ({ quarantined: !released, circuitBreakerTripped: !released, violationCount: released ? 0 : 5, baseline: { agentId: 'governed-agent' } }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetch);

  const renderAgentRoute = () => render(<MemoryRouter initialEntries={['/agents/governed-agent']}><Routes><Route path="/agents/:agentId" element={<AgentsPage />} /></Routes></MemoryRouter>);
  renderAgentRoute();
  expect(await screen.findByText('Quarantined')).toBeTruthy();
  const releaseButton = screen.getByRole('button', { name: 'Release governance hold' }) as HTMLButtonElement;
  expect(releaseButton.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Reason for release'), { target: { value: 'Independent review completed' } });
  expect(releaseButton.disabled).toBe(false);
  fireEvent.click(releaseButton);

  expect(await screen.findByText('Not quarantined')).toBeTruthy();
  expect(screen.getByText('Circuit breaker: clear')).toBeTruthy();
  expect(screen.getByText('Recorded violations: 0')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('status refreshed from the server');
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/runtime-governance/agents/governed-agent/release', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ reason: 'Independent review completed' }),
    headers: expect.objectContaining({ Authorization: 'Bearer fixture-admin-token' }),
  })));
  const releaseRequestsBeforeViewer = fetch.mock.calls.filter(([url, options]) => url.endsWith('/release') && options?.method === 'POST').length;

  cleanup();
  localStorage.setItem('djimitflo_auth_session', 'fixture-viewer-token');
  useAuthStore.setState({ user: { id: 'viewer', role: 'viewer' } as any, token: 'fixture-viewer-token', isAuthenticated: true });
  renderAgentRoute();
  await screen.findByText('Not quarantined');
  expect(screen.queryByRole('button', { name: 'Release governance hold' })).toBeNull();
  expect(fetch.mock.calls.filter(([url, options]) => url.endsWith('/release') && options?.method === 'POST')).toHaveLength(releaseRequestsBeforeViewer);
});
