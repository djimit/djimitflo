import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  expect(fetch.mock.calls[0][0]).toBe('/api/audit?limit=50');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Audit unavailable');
  expect(screen.queryByText('No audit events recorded yet.')).toBeNull();
});
