import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ProofRunDetailPage } from './ProofRunDetailPage';

vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe: vi.fn(() => () => {}) }) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const run = (status: 'completed' | 'rolled_back' = 'completed') => ({
  id: 'proof-fixture', status, runtime: 'mock', created_at: '2026-09-10T00:00:00Z', completed_at: '2026-09-10T00:01:00Z',
  rollback_safe: status === 'completed', counts: { goal: 1 }, artifact_refs: { goal: 'goal-fixture', loop_run: 'loop-fixture', worker_leases: [], panel: null, memory_candidate: null },
  minimums: { goal: 1 }, passed: true, proof_class: 'demo', production_passed: false, production_missing: ['external_provider'], missing: {}, narrative: ['Plan persisted', 'Verification completed'],
});

it('loads a proof run and refreshes to the returned rollback state', async () => {
  const fetch = vi.fn(async (_url: string, options?: RequestInit) => ({ ok: true, status: 200, json: async () => options?.method === 'POST' ? run('rolled_back') : run() }));
  vi.stubGlobal('fetch', fetch);
  render(<MemoryRouter initialEntries={['/swarm-mission-control/proof-runs/proof-fixture']}><Routes><Route path="/swarm-mission-control/proof-runs/:proofRunId" element={<ProofRunDetailPage />} /></Routes></MemoryRouter>);
  expect(await screen.findByText('Proof Run Detail')).toBeTruthy();
  expect(screen.getByText('Rollback this proof run')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Rollback this proof run' }));
  await waitFor(() => expect(screen.getByText('rolled back')).toBeTruthy());
  expect(fetch).toHaveBeenLastCalledWith('/api/swarms/proof-runs/proof-fixture/rollback', expect.objectContaining({ method: 'POST' }));
});

it('renders a failed lookup without exposing a blank route', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'Proof run not found' } }) })));
  render(<MemoryRouter initialEntries={['/swarm-mission-control/proof-runs/missing']}><Routes><Route path="/swarm-mission-control/proof-runs/:proofRunId" element={<ProofRunDetailPage />} /></Routes></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Not found');
  expect(screen.getByRole('link', { name: 'Back to Mission Control' })).toBeTruthy();
});
