import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '../lib/api';

const getAllApprovals = vi.fn<(status?: string) => Promise<{ approvals: ApprovalRequest[] }>>();

vi.mock('../lib/api', () => ({
  api: {
    getAllApprovals: (status?: string) => getAllApprovals(status),
  },
}));

import { APPROVALS_CHANGED, minutesUntil, usePendingApprovals } from './usePendingApprovals';

const approval = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: '1', task_id: 't1', execution_event_id: null, action_type: null, title: null, description: null,
  command: null, tool_name: null, target_path: null, risk_level: 'medium', status: 'pending',
  requested_by: null, requested_at: '2026-01-01T00:00:00.000Z', decided_at: null, decided_by: null,
  decision_reason: null, expires_at: null, policy_id: null, request_type: 'tool_call',
  request_message: '', request_data: {}, approved_by: null, approved_at: null, denied_at: null,
  denial_reason: null, metadata: {}, ...over,
});

describe('usePendingApprovals', () => {
  beforeEach(() => { getAllApprovals.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts empty, loads pending approvals, and drops expired ones', async () => {
    const now = Date.now();
    getAllApprovals.mockResolvedValue({
      approvals: [
        approval({ id: '1', expires_at: new Date(now + 60_000).toISOString() }),
        approval({ id: '2', expires_at: null }),
        approval({ id: '3', expires_at: new Date(now - 60_000).toISOString() }),
      ],
    });
    const { result } = renderHook(() => usePendingApprovals(30_000));
    expect(result.current).toEqual({ count: 0, soonestExpiresAt: null });
    await waitFor(() => expect(result.current.count).toBe(2));
    expect(result.current.soonestExpiresAt).toBe(new Date(now + 60_000).toISOString());
    expect(getAllApprovals).toHaveBeenCalledWith('pending');
  });

  it('polls on the configured interval and stops on unmount', async () => {
    vi.useFakeTimers();
    getAllApprovals.mockResolvedValue({ approvals: [] });
    const { unmount } = renderHook(() => usePendingApprovals(1_000));
    expect(getAllApprovals).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(getAllApprovals).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(getAllApprovals).toHaveBeenCalledTimes(3);
    unmount();
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(getAllApprovals).toHaveBeenCalledTimes(3);
  });

  it('refreshes immediately on the APPROVALS_CHANGED event', async () => {
    vi.useFakeTimers();
    getAllApprovals.mockResolvedValue({ approvals: [] });
    renderHook(() => usePendingApprovals(30_000));
    expect(getAllApprovals).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new Event(APPROVALS_CHANGED)); });
    expect(getAllApprovals).toHaveBeenCalledTimes(2);
  });

  it('ignores a response that resolves after unmount', async () => {
    let resolveList!: (v: { approvals: ApprovalRequest[] }) => void;
    getAllApprovals.mockReturnValue(new Promise((r) => { resolveList = r; }));
    const { result, unmount } = renderHook(() => usePendingApprovals(30_000));
    expect(result.current).toEqual({ count: 0, soonestExpiresAt: null });
    unmount();
    await act(async () => { resolveList({ approvals: [approval({ id: '9', expires_at: new Date(Date.now() + 60_000).toISOString() })] }); });
    // No state update is committed after unmount.
    expect(result.current).toEqual({ count: 0, soonestExpiresAt: null });
  });

  it('keeps the last good state when the API throws', async () => {
    const now = Date.now();
    const future = new Date(now + 60_000).toISOString();
    getAllApprovals.mockResolvedValueOnce({ approvals: [approval({ id: '1', expires_at: future })] });
    getAllApprovals.mockRejectedValueOnce(new Error('HTTP 503'));
    const { result } = renderHook(() => usePendingApprovals(30_000));
    await waitFor(() => expect(result.current).toEqual({ count: 1, soonestExpiresAt: future }));
    vi.useFakeTimers();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(result.current).toEqual({ count: 1, soonestExpiresAt: future });
  });
});

describe('minutesUntil', () => {
  it('returns null for a null expiry', () => {
    expect(minutesUntil(null)).toBeNull();
  });

  it('rounds the remaining minutes to the nearest whole minute', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(minutesUntil('2026-01-01T00:01:30.000Z', now)).toBe(2);
    expect(minutesUntil('2026-01-01T00:02:14.000Z', now)).toBe(2);
  });

  it('clamps an already-expired timestamp to zero', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(minutesUntil('2025-12-31T23:00:00.000Z', now)).toBe(0);
  });
});
