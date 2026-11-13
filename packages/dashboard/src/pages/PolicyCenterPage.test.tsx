import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth-store';
import { visibleText } from '../test/visible-text';
import { PolicyCenterPage } from './PolicyCenterPage';

// Truth audit 12-11: "Require approval for medium+" showed only "medium", no priority, no history, and a deny/require
// policy was disabled in one click.
const MEDIUM_PLUS = {
  id: 'p-medium', name: 'Require approval for medium+', description: '', action_type: 'unknown', risk_level: 'medium',
  risk_levels: ['medium', 'high', 'critical'], decision: 'require_approval', enabled: true, priority: 50,
  last_change: { at: '2026-11-01T10:00:00Z', action: 'approval_policy.updated', user_id: 'u1', email: 'ops@example.test', role: 'admin' },
};
const ALLOW_LOW = { id: 'p-low', name: 'Allow low', description: '', action_type: 'unknown', risk_level: 'low', risk_levels: ['low'], decision: 'allow', enabled: true, priority: 10, last_change: null };

beforeEach(() => {
  useAuthStore.setState({ token: 't', user: { id: 'admin-fixture', email: 'admin@example.test', role: 'admin' } as never, isAuthenticated: true } as never);
  vi.spyOn(api, 'getPolicies').mockResolvedValue({ policies: [MEDIUM_PLUS, ALLOW_LOW] as never });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows every risk level, the evaluation order and who last changed the policy', async () => {
  render(<PolicyCenterPage />);
  expect(await screen.findByText('medium, high, critical')).toBeTruthy();
  expect(screen.getByText('priority 50 · #1 in evaluation order')).toBeTruthy();
  expect(screen.getByText('priority 10 · #2 in evaluation order')).toBeTruthy();
  expect(screen.getByText(/Last changed .* by ops@example\.test \(admin\)/)).toBeTruthy();
  expect(screen.getByText('No change recorded in the audit trail')).toBeTruthy();
});

it('disabling a require-approval policy asks first, naming what stops being enforced; cancel makes no call', async () => {
  const update = vi.spyOn(api, 'updatePolicy').mockResolvedValue({ ...MEDIUM_PLUS, enabled: false } as never);
  const confirm = vi.spyOn(window, 'confirm');
  render(<PolicyCenterPage />);
  const [toggle] = await screen.findAllByRole('button', { name: 'Enabled' });
  fireEvent.click(toggle);
  const dialog = await screen.findByRole('dialog');
  expect(visibleText(dialog)).toContain('unknown actions at risk medium, high, critical no longer require approval');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(update).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();

  fireEvent.click(screen.getAllByRole('button', { name: 'Enabled' })[0]);
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disable policy' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith('p-medium', { enabled: false }));
});

it('an allow policy toggles without a confirmation step', async () => {
  const update = vi.spyOn(api, 'updatePolicy').mockResolvedValue({ ...ALLOW_LOW, enabled: false } as never);
  render(<PolicyCenterPage />);
  const buttons = await screen.findAllByRole('button', { name: 'Enabled' });
  fireEvent.click(buttons[1]);
  await waitFor(() => expect(update).toHaveBeenCalledWith('p-low', { enabled: false }));
  expect(screen.queryByRole('dialog')).toBeNull();
});
