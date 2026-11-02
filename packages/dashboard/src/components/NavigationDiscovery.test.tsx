import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './Layout';

const state = vi.hoisted(() => ({ permitted: true, authorityUnavailable: false, mode: 'on' as string | undefined, healthFails: false }));
vi.mock('../lib/auth-store', () => ({ useAuthStore: () => ({ user: null, logout: vi.fn(), hasPermission: () => state.permitted }) }));
vi.mock('../hooks/usePendingApprovals', () => ({ usePendingApprovals: () => ({ count: 0, approvals: [] }) }));
vi.mock('./OrganizationSelector', () => ({ OrganizationSelector: () => null }));
vi.mock('./PendingApprovalsBanner', () => ({ PendingApprovalsBanner: () => null }));
vi.mock('./WebSocketProvider', () => ({ ConnectionBanner: () => null }));
vi.mock('../lib/api', () => ({ api: { getHealth: () => state.healthFails ? Promise.reject(new Error('offline')) : Promise.resolve({ ui: { navigation_discovery_mode: state.mode } }), request: vi.fn().mockResolvedValue({}), getAuthorityStats: () => state.authorityUnavailable ? Promise.reject(new Error('AUTHORITY_LEDGER_UNAVAILABLE')) : Promise.resolve({}) } }));
const show = async (path = '/') => { const view = render(<MemoryRouter initialEntries={[path]}><Layout /></MemoryRouter>); if (state.mode === 'on' && !state.healthFails) await screen.findByRole('searchbox'); return view; };
const search = (value: string) => fireEvent.change(screen.getByRole('searchbox', { name: 'Find a function' }), { target: { value } });
beforeEach(() => { state.permitted = true; state.authorityUnavailable = false; state.mode = 'on'; state.healthFails = false; });
afterEach(cleanup);

describe('function discovery', async () => {
  it.each([['skills', 'Knowledge'], ['memory', 'Swarm Mission Control'], ['providers', 'Configuration'], ['logs', 'Audit']])('finds %s through the existing %s page', async (query, label) => {
    await show(); search(query);
    expect(screen.getByRole('link', { name: label })).toBeTruthy();
  });
  it('keeps navigation available while a page is loading', async () => {
    const pending = new Promise(() => {});
    function LoadingPage(): never { throw pending; }
    render(<MemoryRouter><Routes><Route element={<Layout />}><Route index element={<LoadingPage />} /></Route></Routes></MemoryRouter>);
    expect(screen.getByRole('status').textContent).toBe('Loading page…');
    expect(await screen.findByRole('searchbox', { name: 'Find a function' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Tasks' })).toBeTruthy();
  });
  it('finds a Lab page without requiring the user to know its group', async () => {
    await show(); search('mission');
    const link = screen.getByRole('link', { name: 'Swarm Mission Control' });
    expect(link.getAttribute('href')).toBe('/swarm-mission-control');
    expect(link.closest('details')?.open).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('1 matching page');
    expect(screen.queryByRole('link', { name: 'Tasks' })).toBeNull();
  });
  it('matches case-insensitive routes and groups, and clears with Escape', async () => {
    await show(); search(' /SWARM-MISSION ');
    expect(screen.getByRole('link', { name: 'Swarm Mission Control' })).toBeTruthy();
    search('Govern');
    expect(screen.getByRole('link', { name: 'Configuration' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(screen.getByRole('link', { name: 'Tasks' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('explains no results and resets after following a result', async () => {
    await show(); search('unfindable');
    expect(screen.getByRole('status').textContent).toContain('No matching pages');
    search('tasks'); fireEvent.click(screen.getByRole('link', { name: 'Tasks' }));
    await waitFor(() => expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe(''));
    expect(screen.getByRole('link', { name: 'Tasks' }).getAttribute('aria-current')).toBe('page');
  });
  it('never exposes permission-filtered pages or empty groups', async () => {
    state.permitted = false; await show(); search('configuration');
    expect(screen.queryByRole('link', { name: 'Configuration' })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('No matching pages');
    expect(screen.queryByText('Govern')).toBeNull();
  });
  it('does not advertise an authority ledger that is not provisioned', async () => {
    state.authorityUnavailable = true; await show(); search('authority');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Authority ledger' })).toBeNull());
    expect(screen.getByRole('status').textContent).toContain('No matching pages');
  });
});

it.each([undefined, 'off', 'shadow', 'unexpected'])('keeps baseline navigation when mode is %s', async mode => {
  state.mode = mode; await show();
  await waitFor(() => expect(screen.getByRole('link', { name: 'Tasks' })).toBeTruthy());
  expect(screen.queryByRole('searchbox')).toBeNull();
  expect(screen.getByText('Lab · experimental').closest('details')?.open).toBe(false);
});
it('keeps baseline navigation when health fails', async () => {
  state.healthFails = true; await show();
  await waitFor(() => expect(screen.getByRole('link', { name: 'Tasks' })).toBeTruthy());
  expect(screen.queryByRole('searchbox')).toBeNull();
});
