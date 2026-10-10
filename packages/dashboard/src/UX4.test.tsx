import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@djimitflo/shared';
import { App } from './App';
import { AUTH_SESSION_KEY, useAuthStore } from './lib/auth-store';
import { api } from './lib/api';
import { ApprovalCard } from './components/ApprovalCard';
import { ACTION_PERMISSIONS, NAV_PERMISSIONS, permissionError } from './lib/permissions';

class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
class NoopSocket { static OPEN = 1; readyState = 0; onopen = null; onclose = null; onmessage = null; onerror = null; close() {} send() {} addEventListener() {} removeEventListener() {} }

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal('WebSocket', NoopSocket);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterAll(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterEach(() => { cleanup(); localStorage.clear(); });

function signIn(role: string) {
  localStorage.setItem(AUTH_SESSION_KEY, 'ux4-token');
  useAuthStore.setState({ token: 'ux4-token', user: { id: 'u1', email: 'ux4@example.test', role } as never, isAuthenticated: true, isLoading: false, error: null, restoreSession: async () => undefined } as never);
}

const pending = { id: 'a1', status: 'pending', risk_level: 'high', request_type: 'worker_execution', title: 'Run maker', request_message: 'approve?', request_data: {} } as unknown as ApprovalRequest;

it('UX-4: a viewer sees no approve/deny buttons, only what permission is needed', () => {
  signIn('viewer');
  render(<ApprovalCard approval={pending} />);
  expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /deny/i })).toBeNull();
  expect(screen.getByText(/Needs approve:task/)).toBeTruthy();
});

it('UX-4: an admin (and an approver) gets the approve/deny buttons', () => {
  for (const role of ['admin', 'approver']) {
    signIn(role);
    const view = render(<ApprovalCard approval={pending} />);
    expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /deny/i })).toBeTruthy();
    view.unmount();
  }
});

it('UX-4: a server 403 renders a clear message naming the permission', async () => {
  signIn('admin');
  vi.spyOn(api, 'approveRequestExplicit').mockRejectedValueOnce(new Error('Insufficient permissions'));
  render(<ApprovalCard approval={pending} />);
  fireEvent.click(screen.getByRole('button', { name: /approve/i }));
  expect((await screen.findByRole('alert')).textContent).toContain('Not allowed: this action needs approve:task');
  expect(permissionError(new Error('boom'), 'x', 'fallback')).toBe('boom'); // non-permission errors pass through
});

it('UX-4: the nav hides pages a viewer cannot use and shows them to an admin', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('API down'); }));
  signIn('viewer');
  window.history.pushState({}, '', '/');
  const viewer = render(<App />);
  await waitFor(() => expect(viewer.container.querySelector('nav[aria-label="Main"]')).toBeTruthy());
  const nav = () => viewer.container.querySelector('nav[aria-label="Main"]')!;
  expect(nav().querySelector('a[href="/configuration"]')).toBeNull();
  expect(nav().querySelector('a[href="/audit"]')).toBeNull();
  expect(nav().querySelector('a[href="/decisions"]')).toBeTruthy();
  viewer.unmount();
  signIn('admin');
  const admin = render(<App />);
  await waitFor(() => expect(admin.container.querySelector('nav[aria-label="Main"] a[href="/configuration"]')).toBeTruthy());
  expect(admin.container.querySelector('nav[aria-label="Main"] a[href="/audit"]')).toBeTruthy();
});

it('UX-4: the permission map mirrors the server routes (hand list from packages/server/src/routes)', () => {
  expect(ACTION_PERMISSIONS).toEqual({
    approveRequest: 'approve:task', // approvals.ts POST /:id/approve, /:id/deny
    fleetCommandDecide: 'approve:task', // fleet.ts POST /commands/:id/approve, /deny
    fleetCommandRequest: 'manage:config', // fleet.ts POST /commands
    requeueProposal: 'write:governance', // self-improvement.ts POST /proposals/:id/requeue
    labelPrescreen: 'write:governance', // self-improvement.ts POST /proposals/:id/prescreen-label
    dismissRequeue: 'write:governance', // self-improvement.ts POST /proposals/:id/requeue-dismiss
    auditAttribution: 'write:governance', // self-improvement.ts POST /attribution-audit/:runId
    memoryReview: 'approve:task', // swarm-governance.ts POST /memory/candidates/:id/promote|reject
    telegramIdentity: 'manage:config', // self-improvement.ts PUT|DELETE /telegram-identities/:telegramId
    mcpCreateServer: 'manage:config', // mcp.ts POST /servers
    policyUpdate: 'manage:config', // policies.ts PATCH /:id
    runtimeConfig: 'manage:config', // health.ts GET /config
  });
  expect(NAV_PERMISSIONS).toEqual({ '/configuration': 'manage:config', '/audit': 'read:audit' }); // audit.ts GET / read:audit
});
