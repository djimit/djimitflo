import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, type ExpertDetail, type ExpertSummary } from '../lib/api';
import { FrontierExpertsPage } from './FrontierExpertsPage';

/** Truth audit 2026-11-12: prod lists 200 of 4,568 units without saying so; Rejected/Deprecate fire with no confirmation. */
const unit: ExpertSummary = { id: 'unit-1', canonical_name: 'Mutation-guided test generation', lifecycle_state: 'CAPABILITY_INFERRED', identity_confidence: 0.9, version: 1, updated_at: '', capabilities: [], provenance_json: '{}', kind: 'paper' };
const detail: ExpertDetail = { expert: { ...unit, aliases_json: '[]' }, provenance: [], affiliations: [], versions: [], snapshot: null, claims: [], lifecycle: [] };
let scroll: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll as unknown as Element['scrollIntoView'];
  vi.spyOn(api, 'listExperts').mockResolvedValue({ experts: Array.from({ length: 200 }, (_, i) => ({ ...unit, id: i ? `unit-${i + 1}` : 'unit-1', canonical_name: i ? `Paper ${i}` : unit.canonical_name })),
    funnel: [{ kind: 'paper', state: 'CAPABILITY_INFERRED', count: 4568 }], total: 4568, last_ingested_at: '2026-10-14T07:00:00Z' });
  vi.spyOn(api, 'getExpertSwarmRuns').mockResolvedValue([]);
  vi.spyOn(api, 'getExpertDedupe').mockRejectedValue(new Error('n/a'));
  vi.spyOn(api, 'getExpert').mockResolvedValue(detail);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const page = (path = '/frontier-experts') => render(
  <MemoryRouter initialEntries={[path]}><Routes><Route path="/frontier-experts" element={<FrontierExpertsPage />} /><Route path="/frontier-experts/:expertId" element={<FrontierExpertsPage />} /></Routes></MemoryRouter>);

it('says the registry list is capped ("200 of 4,568") and when the newest unit was ingested', async () => {
  page();
  expect(await screen.findByText(/Showing 200 of 4,568/)).toBeTruthy();
  expect(screen.getByText(/last ingested 2026-10-14/)).toBeTruthy();
});

it('a deep link sets the heading to the unit title and scrolls its detail into view', async () => {
  page('/frontier-experts/unit-1');
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Mutation-guided test generation'));
  await waitFor(() => expect(scroll).toHaveBeenCalled());
});

it('→ Rejected asks for an in-page confirmation with a reason before anything is sent (never window.confirm)', async () => {
  const confirm = vi.spyOn(window, 'confirm');
  const transition = vi.spyOn(api, 'transitionExpert').mockResolvedValue(unit);
  page('/frontier-experts/unit-1');
  fireEvent.click(await screen.findByRole('button', { name: '→ Rejected' }));
  expect(transition).not.toHaveBeenCalled();
  const confirmButton = screen.getByRole('button', { name: 'Confirm: Rejected' });
  expect(confirmButton).toHaveProperty('disabled', true);
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'off-topic quantum paper' } });
  fireEvent.click(confirmButton);
  await waitFor(() => expect(transition).toHaveBeenCalledWith('unit-1', 'REJECTED', 'off-topic quantum paper'));
  expect(confirm).not.toHaveBeenCalled();
});

it('Deprecate asks for an in-page confirmation with a note; Cancel sends nothing', async () => {
  const deprecate = vi.spyOn(api, 'deprecateExpert').mockResolvedValue(unit);
  page('/frontier-experts/unit-1');
  fireEvent.change(await screen.findByLabelText('Deprecate'), { target: { value: 'superseded' } });
  expect(deprecate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByLabelText('Reason')).toBeNull();
  fireEvent.change(screen.getByLabelText('Deprecate'), { target: { value: 'superseded' } });
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'v2 of the same paper' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm: Deprecate (superseded)' }));
  await waitFor(() => expect(deprecate).toHaveBeenCalledWith('unit-1', 'superseded', 'v2 of the same paper'));
});
