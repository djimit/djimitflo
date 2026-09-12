import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ReviewPage } from './ReviewPage';
import { api } from '../lib/api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const renderReview = () => render(<MemoryRouter initialEntries={['/tasks/review-fixture/review']}><Routes><Route path="/tasks/:taskId/review" element={<ReviewPage />} /></Routes></MemoryRouter>);
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const review = { task: { id: 'review-fixture', title: 'Review fixture' }, summary: null, evidence: [], file_changes: [], audit_trail: [] };

it('shows a failed review load as unavailable instead of falsely saying task not found', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Review service unavailable'); }));
  renderReview();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Review service unavailable');
  expect(screen.queryByText('Task not found')).toBeNull();
});

it('reports diff failure while retaining successfully loaded snapshots', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/evidence/review/')) return response(review);
    if (url.endsWith('/snapshots')) return response({ snapshots: [{ id: 'snap', snapshot_type: 'pre_execution', branch: 'verified-snapshot', is_clean: true }] });
    throw new Error('Diff unavailable');
  }));
  renderReview();
  expect(await screen.findByText('Git diff unavailable. File changes could not be verified.')).toBeTruthy();
  expect(screen.getByText('verified-snapshot')).toBeTruthy();
  expect(screen.queryByText('No file changes detected.')).toBeNull();
});

it('reports missing snapshot evidence even when the diff is empty', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/evidence/review/')) return response(review);
    if (url.endsWith('/diff')) return response({ files: [], summary: { totalFiles: 0, totalAdditions: 0, totalDeletions: 0, truncated: false, redactedSecrets: 0 } });
    throw new Error('Snapshots unavailable');
  }));
  renderReview();
  expect(await screen.findByText('Execution snapshots unavailable. Repository state could not be verified.')).toBeTruthy();
});

it.each(['awaiting_approval', 'running', 'unrecognized_status'])('renders %s neutrally without a completed checkmark', async (status) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/evidence/review/')) return response({ ...review, summary: { final_status: status, risk_level: 'medium', policy_decision: 'unknown', duration_ms: 0, event_count: 0, error_count: 0, tool_call_count: 0, approval_required: true, approval_granted: null, metadata: { approval_status: 'pending', executor_source: 'task_configuration' }, executor_kind: 'codex' } });
    if (url.endsWith('/snapshots')) return response({ snapshots: [] });
    return response({ files: [], summary: {} });
  }));
  renderReview();
  const label = await screen.findByText(status);
  expect(label.className).not.toContain('text-status-completed');
  expect(label.querySelector('.lucide-circle-check')).toBeNull();
  expect(screen.getByText('Pending')).toBeTruthy();
  expect(screen.getByText('Execution approval (recorded)')).toBeTruthy();
  expect(screen.getByText('0s')).toBeTruthy();
  expect(screen.getByText('codex (configured; execution not evidenced)')).toBeTruthy();
});

it('keeps the standalone summary and audit clients aligned with the actual wire envelopes', async () => {
  const summary = { task_id: 'fixture', final_status: 'awaiting_approval' };
  const audit = { audit_trail: [{ action: 'fixture' }] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.includes('/summary/') ? summary : audit)));
  expect(await api.getExecutionSummary('fixture')).toEqual(summary);
  expect(await api.getAuditTrail('fixture')).toEqual(audit);
});
