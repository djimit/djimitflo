import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgiReasoningPage } from './AgiReasoningPage';
import { PredictiveAnalyticsPage } from './PredictiveAnalyticsPage';
import { SelfHealingPage } from './SelfHealingPage';
import { api } from '../lib/api';

beforeEach(() => localStorage.setItem('djimitflo_auth_session', 'test-session'));
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('authenticated intelligence actions', () => {
  it.each([
    { Page: AgiReasoningPage, button: 'Run Reasoning', endpoint: '/api/agi/reason', method: 'POST', response: { observations: { observations: ['Observed fixture'], anomalies: [], opportunities: [] }, hypotheses: [], strategies: [] }, visible: 'Observed fixture' },
    { Page: PredictiveAnalyticsPage, button: 'Run Prediction', endpoint: '/api/intelligence/predict', method: 'POST', response: { successProbability: 0.8, expectedDurationMs: 60000, expectedCostDollars: 0.1, riskFactors: [], recommendations: [] }, visible: '80%' },
    { Page: SelfHealingPage, button: 'Run Health Check', endpoint: '/api/intelligence/health', method: undefined, response: { checks: [{ name: 'Fixture health', status: 'healthy', message: 'Observed fixture' }] }, visible: 'Fixture health' },
  ])('$button uses the authenticated client and renders the response', async ({ Page, button, endpoint, method, response, visible }) => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => response });
    vi.stubGlobal('fetch', fetch);
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(await screen.findByText(visible)).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-session' }) }));
    expect(fetch.mock.calls[0][1].method).toBe(method);
  });

  it.each([PredictiveAnalyticsPage, SelfHealingPage])('shows denied requests instead of silently presenting no result', async Page => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    render(<Page />);
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Access denied');
  });

  it('downloads compliance evidence with bearer authentication and no GET body', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(['evidence']), headers: new Headers({ 'Content-Disposition': 'attachment; filename="compliance.json"' }) });
    vi.stubGlobal('fetch', fetch);
    const createObjectURL = vi.fn().mockReturnValue('blob:fixture');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await api.exportCompliance('json');
    expect(fetch).toHaveBeenCalledWith('/api/compliance/export?format=json', expect.objectContaining({ method: 'GET', body: undefined, headers: expect.objectContaining({ Authorization: 'Bearer test-session' }) }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fixture');
  });
});
