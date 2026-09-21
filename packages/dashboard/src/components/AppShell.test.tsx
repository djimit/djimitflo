import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ApprovalRequest } from '@djimitflo/shared';
import { Layout } from './Layout';
import { ApprovalCard } from './ApprovalCard';
import { TabbedPage } from './TabbedPage';
import { api } from '../lib/api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.title = 'Djimitflo'; });

const approval = (patch: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: 'a1', task_id: 't1', execution_event_id: null, action_type: 'task_execution', title: 'Approval required before task execution', description: null,
  command: null, tool_name: null, target_path: null, risk_level: 'high', status: 'pending', requested_by: 'system', requested_at: '', decided_at: null,
  decided_by: null, decision_reason: null, expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), policy_id: 'policy-medium-task-approval',
  request_type: 'high_risk_action', request_message: 'Matched policy', request_data: {}, approved_by: null, approved_at: null, denied_at: null,
  denial_reason: null, metadata: {}, created_at: '', updated_at: '', ...patch,
} as ApprovalRequest);

describe('app shell approvals visibility', () => {
  it('shows a badge on Approvals, a banner with the time left and the count in the tab title', async () => {
    vi.spyOn(api, 'getAllApprovals').mockResolvedValue({ approvals: [approval()] });
    vi.spyOn(api, 'getAuthorityStats').mockRejectedValue(new Error('x'));
    document.title = 'Djimitflo';
    render(<MemoryRouter initialEntries={['/tasks']}><Layout /></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText('1 pending')).toBeTruthy());
    expect(screen.getByRole('status').textContent).toMatch(/1 approval is waiting — the first expires in (9|10) min/);
    expect(document.title).toBe('(1) Djimitflo');
  });

  it('shows nothing when no approval is open, and no banner on the approvals page itself', async () => {
    const spy = vi.spyOn(api, 'getAllApprovals').mockResolvedValue({ approvals: [] });
    vi.spyOn(api, 'getAuthorityStats').mockRejectedValue(new Error('x'));
    render(<MemoryRouter><Layout /></MemoryRouter>);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();
    vi.spyOn(api, 'getAllApprovals').mockResolvedValue({ approvals: [approval()] });
    render(<MemoryRouter initialEntries={['/approvals']}><Layout /></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText('1 pending')).toBeTruthy());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('ignores approvals that already expired', async () => {
    vi.spyOn(api, 'getAllApprovals').mockResolvedValue({ approvals: [approval({ expires_at: new Date(Date.now() - 60_000).toISOString() })] });
    const spy = vi.spyOn(api, 'getAuthorityStats').mockRejectedValue(new Error('x'));
    render(<MemoryRouter><Layout /></MemoryRouter>);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByLabelText('1 pending')).toBeNull();
  });
});

describe('ApprovalCard execution context', () => {
  it('tells the reviewer which proposal, goal, worker and directory the approval is for', () => {
    render(<ApprovalCard approval={approval({ context: {
      kind: 'loop_worker', goal_objective: 'Add an idempotency test', proposal_title: 'Idempotent sweep test', loop_run_id: 'r1',
      lease_role: 'maker', runtime: 'opencode', working_directory: '/data/loop-worktrees/r1/f1', prompt_preview: 'Create one test',
    } })} />);
    const ctx = screen.getByLabelText('Execution context');
    expect(ctx.textContent).toContain('Idempotent sweep test');
    expect(ctx.textContent).toContain('maker · opencode');
    expect(ctx.textContent).toContain('/data/loop-worktrees/r1/f1');
  });
  it('renders no context block for ordinary approvals', () => {
    render(<ApprovalCard approval={approval()} />);
    expect(screen.queryByLabelText('Execution context')).toBeNull();
  });
});

describe('TabbedPage', () => {
  const tabs = [{ id: 'one', label: 'One', element: <p>first</p> }, { id: 'two', label: 'Two', element: <p>second</p> }];
  it('defaults to the first tab and honours ?tab= for deep links', () => {
    render(<MemoryRouter initialEntries={['/x']}><Routes><Route path="/x" element={<TabbedPage tabs={tabs} />} /></Routes></MemoryRouter>);
    expect(screen.getByText('first')).toBeTruthy();
    cleanup();
    render(<MemoryRouter initialEntries={['/x?tab=two']}><Routes><Route path="/x" element={<TabbedPage tabs={tabs} />} /></Routes></MemoryRouter>);
    expect(screen.getByText('second')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Two' }).getAttribute('aria-selected')).toBe('true');
  });
});
