import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

type Spec = {
  specName: string; path: string; source: 'speckit' | 'openspec'; lifecycleState: string;
  layers: Array<{ layer: string; name: string; present: boolean; evidence: string }>;
  score: number; fullCompliance: boolean; assuranceStatus: 'pass' | 'fail' | 'blocked'; nextSafeAction: string;
};
type Report = { generatedAt: string; totalSpecs: number; fullComplianceCount: number; partialCount: number; noneCount: number; specs: Spec[] };

const request = vi.fn<(endpoint: string, options?: RequestInit) => Promise<Report>>();
const exportCompliance = vi.fn<(format: 'json' | 'csv') => Promise<void>>();
vi.mock('../lib/api', () => ({
  api: {
    request: (e: string, o?: RequestInit) => request(e, o),
    exportCompliance: (f: 'json' | 'csv') => exportCompliance(f),
  },
}));
import { SpecComplianceWidget } from './SpecComplianceWidget';

const L = (layer: string, name: string, present: boolean) => ({ layer, name, present, evidence: 'e' });
const spec = (o: Partial<Spec> = {}): Spec => ({
  specName: 'auth', path: 'specs/auth.md', source: 'speckit', lifecycleState: 'stable',
  layers: [L('L1', 'Why', true), L('L2', 'What', true), L('L3', 'How', false)],
  score: 2, fullCompliance: false, assuranceStatus: 'fail', nextSafeAction: 'Add L3 evidence', ...o,
});
const full = (o: Partial<Spec> = {}): Spec => spec({ score: 7, fullCompliance: true, assuranceStatus: 'pass', layers: [L('L1', 'Why', true)], ...o });
const report = (o: Partial<Report> = {}): Report => ({
  generatedAt: '2026-11-09T10:00:00Z', totalSpecs: 3, fullComplianceCount: 1, partialCount: 1, noneCount: 1, specs: [spec()], ...o,
});
function mount(o: Partial<Report> = {}, controls = false) {
  request.mockReset(); exportCompliance.mockReset();
  request.mockResolvedValue(report(o)); exportCompliance.mockResolvedValue(undefined);
  return render(<SpecComplianceWidget controls={controls} />);
}

describe('SpecComplianceWidget', () => {
  it('requests /compliance/specs on mount and renders the metric cards once loaded', async () => {
    mount({ totalSpecs: 4, fullComplianceCount: 3, partialCount: 2, noneCount: 1, specs: [full({ score: 7 })] });
    expect(request).toHaveBeenCalledWith('/compliance/specs', undefined);
    await waitFor(() => expect(screen.getByText('SDD Compliance')).toBeTruthy());
    for (const label of ['Total Specs', 'Full Compliance', 'Partial', 'Non-Compliant']) expect(screen.getByText(label)).toBeTruthy();
    for (const v of ['4', '3', '2', '1']) expect(screen.getByText(v)).toBeTruthy();
  });

  it('shows the loading message while pending', () => {
    request.mockImplementation(() => new Promise<Report>(() => {}));
    render(<SpecComplianceWidget />);
    expect(screen.getByText('Scanning specs...')).toBeTruthy();
    expect(screen.queryByText('SDD Compliance')).toBeNull();
  });

  it('renders an error line when the request rejects', async () => {
    request.mockRejectedValue(new Error('compliance down'));
    render(<SpecComplianceWidget />);
    await waitFor(() => expect(screen.getByText('Error: compliance down')).toBeTruthy());
  });

  it('lists each spec with its score', async () => {
    mount({ specs: [spec({ specName: 'auth', score: 5 }), spec({ specName: 'billing', score: 2 })] });
    await waitFor(() => expect(screen.getByText('auth')).toBeTruthy());
    expect(screen.getByText('5/7')).toBeTruthy();
    expect(screen.getByText('2/7')).toBeTruthy();
    expect(screen.getByText('billing')).toBeTruthy();
  });

  it('expands a spec to show status, lifecycle, source, layers and next safe action', async () => {
    mount({ specs: [spec({ path: 'openspec/auth', source: 'openspec', lifecycleState: 'proposed', assuranceStatus: 'blocked', layers: [L('L3', 'How', false)], score: 1 })] });
    await waitFor(() => expect(screen.getByText('auth')).toBeTruthy());
    fireEvent.click(screen.getByText('auth'));
    for (const t of ['blocked', 'proposed', 'openspec', 'openspec/auth', 'How', 'Missing', 'Next safe action:', 'Add L3 evidence']) {
      expect(screen.getByText(t)).toBeTruthy();
    }
  });

  it('omits the next safe action block for a fully compliant spec', async () => {
    mount({ specs: [full({ nextSafeAction: 'should not show' })] });
    await waitFor(() => expect(screen.getByText('auth')).toBeTruthy());
    fireEvent.click(screen.getByText('auth'));
    expect(screen.queryByText('Next safe action:')).toBeNull();
  });

  it('re-fetches with ?refresh=1 when Refresh is clicked', async () => {
    mount();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/compliance/specs?refresh=1', undefined));
  });

  it('hides controls and export buttons when controls is false', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('SDD Compliance')).toBeTruthy());
    expect(screen.queryByLabelText('Compliance filter')).toBeNull();
    expect(screen.queryByLabelText('Sort specs')).toBeNull();
    expect(screen.queryByText('Export JSON')).toBeNull();
    expect(screen.queryByText('Export CSV')).toBeNull();
  });

  it('renders controls and exports json/csv on button clicks', async () => {
    mount({}, true);
    await waitFor(() => expect(screen.getByLabelText('Compliance filter')).toBeTruthy());
    fireEvent.click(screen.getByText('Export JSON'));
    await waitFor(() => expect(exportCompliance).toHaveBeenCalledWith('json'));
    fireEvent.click(screen.getByText('Export CSV'));
    await waitFor(() => expect(exportCompliance).toHaveBeenCalledWith('csv'));
  });

  it('filters specs by compliance and sorts by name', async () => {
    mount({ specs: [full({ specName: 'zeta' }), spec({ specName: 'alpha', score: 1 })] }, true);
    await waitFor(() => expect(screen.getByText('zeta')).toBeTruthy());
    const f = screen.getByLabelText('Compliance filter');
    fireEvent.change(f, { target: { value: 'full' } });
    await waitFor(() => expect(screen.queryByText('alpha')).toBeNull());
    expect(screen.getByText('zeta')).toBeTruthy();
    fireEvent.change(f, { target: { value: 'none' } });
    await waitFor(() => expect(screen.queryByText('zeta')).toBeNull());
    expect(screen.getByText('alpha')).toBeTruthy();
    fireEvent.change(f, { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Sort specs'), { target: { value: 'name' } });
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy());
    expect(screen.getByText('zeta')).toBeTruthy();
  });

  it('shows the empty view when no specs match the filter', async () => {
    mount({ specs: [full()] }, true);
    await waitFor(() => expect(screen.getByText('auth')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Compliance filter'), { target: { value: 'none' } });
    await waitFor(() => expect(screen.getByText('No specs match this view.')).toBeTruthy());
  });

  it('surfaces an export error in the error line', async () => {
    mount({}, true);
    await waitFor(() => expect(screen.getByText('Export JSON')).toBeTruthy());
    exportCompliance.mockRejectedValueOnce(new Error('export blocked'));
    fireEvent.click(screen.getByText('Export JSON'));
    await waitFor(() => expect(screen.getByText('Error: export blocked')).toBeTruthy());
  });
});
