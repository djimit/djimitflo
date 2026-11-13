import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuditPage } from './AuditPage';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows successful canonical events without requiring failed tasks, and reports refresh failure', async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ events: [{
    id: 'created-1', timestamp: '2026-09-09T10:00:00Z', event_type: 'task.created',
    action: 'Successful task created', risk_level: 'low', user_id: 'maker-1', metadata: {},
  }] }) }).mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: { message: 'Audit unavailable' } }) });
  vi.stubGlobal('fetch', fetch);
  render(<AuditPage />);
  expect(await screen.findByText('Successful task created')).toBeTruthy();
  expect(fetch.mock.calls[0][0]).toBe('/api/audit?limit=50&hide_service_logins=1');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Audit unavailable');
  expect(screen.queryByText('No audit events recorded yet.')).toBeNull();
});

it('filters by type on the server, hides service-account logins by default, and names the actor', async () => {
  const fetch = vi.fn().mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ total: 1, hidden_service_logins: 287, events: [{
    id: 'p-1', timestamp: '2026-11-12T10:00:00Z', event_type: 'policy.updated', action: 'approval_policy.updated', risk_level: 'high',
    user_id: 'ee5e7993-uuid', actor_email: 'ops@example.test', actor_role: 'admin', metadata: {},
  }] }) }));
  vi.stubGlobal('fetch', fetch);
  render(<AuditPage />);
  expect(await screen.findByText('Actor: ops@example.test (admin)')).toBeTruthy();
  expect(screen.getByText(/1 of 1 events · 287 service-account logins hidden/)).toBeTruthy();

  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'policy' } });
  await waitFor(() => expect(String(fetch.mock.calls.at(-1)![0])).toBe('/api/audit?limit=50&event_type=policy.created%2Cpolicy.updated%2Cpolicy.violation&hide_service_logins=1'));

  fireEvent.click(screen.getByRole('checkbox', { name: 'Show service-account logins' }));
  await waitFor(() => expect(String(fetch.mock.calls.at(-1)![0])).toBe('/api/audit?limit=50&event_type=policy.created%2Cpolicy.updated%2Cpolicy.violation'));
});
