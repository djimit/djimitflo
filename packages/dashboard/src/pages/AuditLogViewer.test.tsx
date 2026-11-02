import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();
vi.mock('../lib/auth-store', () => ({
  useAuthStore: () => ({ token: 'test-token' }),
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

import { AuditLogViewer } from './AuditLogViewer';

const row = (id: string, resourceType = 'loop_run') => ({
  id, resource_type: resourceType, resource_id: `${id}-res`, action: 'pr_reviewed', metadata: '{}', timestamp: '2026-10-01T10:00:00Z',
});
const page = (rows: unknown[], hasMore: boolean, total: number) => new Response(JSON.stringify(rows), {
  status: 200, headers: { 'content-type': 'application/json', 'x-has-more': String(hasMore), 'x-total-count': String(total) },
});
const lastUrl = () => String(authenticatedFetch.mock.calls[authenticatedFetch.mock.calls.length - 1][0]);

beforeEach(() => { authenticatedFetch.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('sends the canonical loop_run resource type for the Loop filter', async () => {
  authenticatedFetch.mockImplementation(async () => page([row('a')], false, 1));
  render(<AuditLogViewer />);
  await screen.findByText('a-res');
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'loop_run' } });
  await waitFor(() => expect(lastUrl()).toContain('resource_type=loop_run'));
  expect((screen.getByRole('option', { name: 'Loop' }) as HTMLOptionElement).value).toBe('loop_run');
});

it('disables Next on an empty page and shows an explicit empty state', async () => {
  authenticatedFetch.mockImplementation(async () => page([], false, 0));
  render(<AuditLogViewer />);
  await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
  await waitFor(() => expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true));
  expect(await screen.findByText('No audit events match these filters.')).toBeTruthy();
});

it('resets the offset when a filter changes', async () => {
  authenticatedFetch.mockImplementation(async () => page(Array.from({ length: 50 }, (_, i) => row(`r${i}`)), true, 120));
  render(<AuditLogViewer />);
  await screen.findByText('r0-res');
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await waitFor(() => expect(lastUrl()).toContain('offset=50'));
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'approval' } });
  await waitFor(() => expect(lastUrl()).toContain('resource_type=approval'));
  expect(lastUrl()).toContain('offset=0');
});

it('exports with the same filter scope as the list and labels it as filtered', async () => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
  authenticatedFetch.mockImplementation(async (endpoint: string) => endpoint.startsWith('/audit-logs/export')
    ? new Response('[]', { status: 200 })
    : page([row('a')], false, 1));
  render(<AuditLogViewer />);
  await screen.findByText('a-res');
  expect(screen.getByRole('button', { name: 'Export all JSON' })).toBeTruthy();
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'loop_run' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Export filtered JSON' }));
  await waitFor(() => expect(lastUrl()).toMatch(/^\/audit-logs\/export\?/));
  const exported = new URL(lastUrl(), 'http://x').searchParams;
  expect(exported.get('format')).toBe('json');
  expect(exported.get('resource_type')).toBe('loop_run');
});
