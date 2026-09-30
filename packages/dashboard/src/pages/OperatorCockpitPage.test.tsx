import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { NeedsYou, OperatorCockpitPage } from './OperatorCockpitPage';
import { api } from '../lib/api';

beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(api, 'getServiceMap').mockResolvedValue({ services: [
  { names: ['event bus'], endpoint: 'http://100.86.47.122:8083', status: 'up', http: 404, ms: 12, error: null },
  { names: ['LiteLLM'], endpoint: 'http://192.168.1.28:4000', status: 'down', http: null, ms: null, error: 'timeout' },
] }); });

it('shows breached guardrails, stalls and gym species from the cockpit endpoint', async () => {
  vi.spyOn(api, 'getOperatorCockpit').mockResolvedValue({
    at: '2026-09-28T20:00:00Z', build: { commit: 'f9f481ad3eb5', build_time: null },
    scorecard: { verified_7d: 11, regressed_7d: 5 },
    guardrails: [{ name: 'regressions', ok: false, value: 5, limit: '<= verified/5 (2.2)' }],
    stalls: [{ subsystem: 'gym:atomic@llama-router', since: null, detail: 'no outcome for 9 h' }],
    gym: [{ species: 'atomic', outcomes: 27, successes: 24, success_pct: 89, avg_seconds: 588, avg_tokens: 0, last: '2026-09-28T08:53:00Z' }],
    remote_workers: [], maker_usage_7d: [], judgments_7d: [],
    deploys: [{ at: '2026-09-28T18:43:09Z', event: 'verdict_ok', sha: 'f9f481ad3eb5', detail: '' }],
  });
  render(<OperatorCockpitPage />);
  expect(await screen.findByText('breached · limit <= verified/5 (2.2)')).toBeTruthy();
  expect(screen.getByText('gym:atomic@llama-router')).toBeTruthy();
  expect(screen.getByText('89%')).toBeTruthy();
  expect(screen.getByText('No remote host has claimed work.')).toBeTruthy();
  expect(screen.getByText('verdict ok')).toBeTruthy();
  expect(await screen.findByText('down (timeout)')).toBeTruthy();
});

it('shows the error when the endpoint fails', async () => {
  vi.spyOn(api, 'getOperatorCockpit').mockRejectedValue(new Error('Access denied'));
  render(<OperatorCockpitPage />);
  expect((await screen.findByRole('alert')).textContent).toBe('Access denied');
});

it('W3: shows what needs the operator with links into /decisions, and a calm line when nothing does', () => {
  const html = renderToStaticMarkup(<MemoryRouter><NeedsYou n={{ approvals: 2, requeue: 0, labels: 22, memory_review: 1 }} /></MemoryRouter>);
  expect(html).toContain('Needs you (25)');
  expect(html).toContain('href="/decisions#approvals"');
  expect(html).toContain('22 pre-screen labels');
  expect(html).not.toContain('requeue candidates');
  expect(renderToStaticMarkup(<MemoryRouter><NeedsYou n={{ approvals: 0, requeue: 0, labels: 0, memory_review: 0 }} /></MemoryRouter>)).toContain('Nothing needs you right now');
});
