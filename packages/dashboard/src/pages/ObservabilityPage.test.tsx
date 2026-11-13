import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObservabilityPage } from './ObservabilityPage';
import { useAuthStore } from '../lib/auth-store';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('uses the assessment population rather than task count for risk percentages', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
    total_tasks: 1, completed_tasks: 0, failed_tasks: 0, pending_approvals: 0,
    risk_distribution: { low: 2, medium: 2, high: 0, critical: 0 }, policy_decisions: {}, recent_errors: [],
  }) }));
  render(<ObservabilityPage />);
  expect(await screen.findByText('Risk Assessments')).toBeTruthy();
  expect(screen.getAllByText('2 (50%)')).toHaveLength(2);
  expect(screen.queryByText('2 (200%)')).toBeNull();
});

it('shows failed metrics requests instead of an endless loading skeleton', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Metrics offline')));
  render(<ObservabilityPage />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Metrics offline');
});

// Dashboard truth audit 2026-11-12 (/observability): recommendations were labelled "Policy Decisions", every card was
// all-time without saying so, and one 7,377-char error was listed ten times.
describe('truthful labels and window', () => {
  const blob = `vitest verification: The user has specified a rule which prevents you from using this tool. ${'x'.repeat(7_300)}`;
  const body = {
    window_days: 7, total_tasks: 4, completed_tasks: 2, failed_tasks: 1, pending_approvals: 0,
    risk_distribution: { low: 0, medium: 0, high: 298, critical: 0 }, policy_decisions: { allow: 0, deny: 0, require_approval: 298 },
    approval_outcomes: { approved: 687, denied: 5, expired: 12 },
    recent_errors: [{ task_id: 'task-aaaaaaaa', message: blob, timestamp: '2026-11-11T12:17:04Z', count: 10 }],
  };
  let urls: string[] = [];
  beforeEach(() => {
    urls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => body }; }));
  });

  it('labels risk-engine recommendations as such and shows real approval outcomes', async () => {
    render(<ObservabilityPage />);
    expect(await screen.findByText('Risk-engine recommendations')).toBeTruthy();
    expect(screen.queryByText('Policy Decisions')).toBeNull();
    expect(screen.getByText('Approval outcomes')).toBeTruthy();
    expect(screen.getByText('687')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
  });

  it('labels the window, defaults to 7 days, and refetches when it changes', async () => {
    render(<ObservabilityPage />);
    await screen.findByText('Risk-engine recommendations');
    expect(urls.some((u) => u.includes('/observability/metrics?days=7'))).toBe(true);
    expect(screen.getAllByText(/last 7 days/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Window'), { target: { value: '30' } });
    await waitFor(() => expect(urls.some((u) => u.includes('/observability/metrics?days=30'))).toBe(true));
  });

  it('notes a risk distribution dominated by one level', async () => {
    render(<ObservabilityPage />);
    expect(await screen.findByText(/100% of assessments are high/)).toBeTruthy();
  });

  it('shows a repeated error once with its count, clamped with an expand control', async () => {
    render(<ObservabilityPage />);
    const item = await screen.findByTestId('recent-error');
    expect(screen.getAllByTestId('recent-error')).toHaveLength(1);
    expect(item.textContent).toMatch(/×10/);
    expect(item.textContent!.length).toBeLessThan(500);
    fireEvent.click(screen.getByRole('button', { name: /Show full message/ }));
    expect(screen.getByTestId('recent-error').textContent!.length).toBeGreaterThan(7_000);
  });
});

// OBS-004 (forensic audit 2026-10-26): a stream EOF is never shown as a healthy, quiet feed.
describe('live event feed lifecycle', () => {
  const metrics = { total_tasks: 0, completed_tasks: 0, failed_tasks: 0, pending_approvals: 0, risk_distribution: {}, policy_decisions: {}, recent_errors: [] };
  const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
  const sse = (...frames: string[]) => new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(new TextEncoder().encode(f));
      controller.close(); // clean EOF
    },
  });
  let streamCalls = 0;

  function stubFetch(stream: () => ReadableStream<Uint8Array>) {
    streamCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/observability/stream')) { streamCalls++; return { ok: true, status: 200, body: stream() }; }
      return { ok: true, status: 200, json: async () => metrics };
    }));
  }

  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); useAuthStore.setState({ token: 'test-token' }); });
  afterEach(() => { vi.useRealTimers(); useAuthStore.setState({ token: null }); });

  it('shows a clean EOF as reconnecting, then closed after bounded attempts, never as connected', async () => {
    stubFetch(() => sse(frame({ type: 'connected', timestamp: '2026-10-27T00:00:00Z' })));
    render(<ObservabilityPage />);
    expect(await screen.findByText(/Reconnecting \(attempt 1\//)).toBeTruthy();
    expect(screen.queryByText('Connected. Waiting for events...')).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await screen.findByText(/Live stream closed/)).toBeTruthy();
    expect(screen.getByTestId('stream-status').textContent).toBe('closed');
    const calls = streamCalls;
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(6); // first connect + at most 5 reconnects
    await vi.advanceTimersByTimeAsync(120_000);
    expect(streamCalls).toBe(calls); // bounded: no further attempts
    expect(screen.getByRole('link', { name: /Audit/ }).getAttribute('href')).toBe('/audit');
  });

  it('does not render the connected handshake as an event or replay events across reconnects', async () => {
    let n = 0;
    stubFetch(() => { n++; return sse(frame({ type: 'connected' }), frame({ type: 'convergence', timestamp: '2026-10-27T00:00:00Z', data: { seq: n } })); });
    render(<ObservabilityPage />);
    await screen.findAllByText('convergence');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(streamCalls).toBeGreaterThan(1);
    // one row per delivered event: nothing replayed or duplicated across reconnects
    await waitFor(() => expect(screen.getAllByText('convergence').length).toBe(streamCalls));
    expect(screen.queryByText('connected')).toBeNull();
  });

  it('shows an open stream as connected and aborts it on unmount', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/observability/stream')) {
        signal = init?.signal ?? undefined;
        return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(frame({ type: 'connected' }))); } }) };
      }
      return { ok: true, status: 200, json: async () => metrics };
    }));
    const view = render(<ObservabilityPage />);
    expect(await screen.findByText('Connected. Waiting for events...')).toBeTruthy();
    expect(screen.getByTestId('stream-status').textContent).toBe('open');
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
