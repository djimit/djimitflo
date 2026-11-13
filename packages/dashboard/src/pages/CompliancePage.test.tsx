import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompliancePage } from './CompliancePage';

const report = {
  generatedAt: '2026-08-27T10:00:00.000Z',
  totalSpecs: 2,
  fullComplianceCount: 1,
  partialCount: 1,
  noneCount: 0,
  specs: [
    { specName: 'full-spec', path: '/specs/full', source: 'speckit', lifecycleState: 'implemented', score: 7, fullCompliance: true, assuranceStatus: 'pass', nextSafeAction: 'No action required', layers: Array.from({ length: 7 }, (_, index) => ({ layer: `L${index + 1}`, name: `Layer ${index + 1}`, present: true, evidence: 'found' })) },
    { specName: 'partial-spec', path: '/openspec/partial', source: 'openspec', lifecycleState: 'proposed', score: 3, fullCompliance: false, assuranceStatus: 'fail', nextSafeAction: 'Add missing layers: L4, L5, L6, L7', layers: Array.from({ length: 7 }, (_, index) => ({ layer: `L${index + 1}`, name: `Layer ${index + 1}`, present: index < 3, evidence: index < 3 ? 'found' : 'missing' })) },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('CompliancePage', () => {
  it('shows evidence and filters by compliance level', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => report }));
    render(<CompliancePage />);

    expect(await screen.findByText('full-spec')).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('/api/compliance/specs', expect.objectContaining({ headers: expect.any(Object) }));
    expect(screen.getByText('partial-spec')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Compliance filter'), { target: { value: 'full' } });
    expect(screen.queryByText('partial-spec')).toBeNull();
    expect(screen.getByText('Export JSON')).toBeTruthy();
  });

  it('names the scanned paths and commit, and flags a missing directory instead of hiding it', async () => {
    const sources = { repoRoot: '/app', commit: '96c0fba7abcdef0123', dirs: [{ path: '/app/specs', found: true }, { path: '/app/openspec/changes', found: false }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...report, sources }) }));
    render(<CompliancePage />);

    expect(await screen.findByText(/Scanned \/app\/specs, \/app\/openspec\/changes at commit 96c0fba7abcd/)).toBeTruthy();
    expect(screen.getByText(/No specs found at \/app\/openspec\/changes/)).toBeTruthy();
  });

  it('shows "no specs found" instead of a score when nothing was scanned', async () => {
    const empty = { ...report, totalSpecs: 0, fullComplianceCount: 0, partialCount: 0, noneCount: 0, specs: [], sources: { repoRoot: '/app', commit: null, dirs: [{ path: '/app/specs', found: false }, { path: '/app/openspec/changes', found: false }] } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => empty }));
    render(<CompliancePage />);

    expect(await screen.findByText(/No specs found at \/app\/specs, \/app\/openspec\/changes: there is nothing to score/)).toBeTruthy();
    expect(screen.queryByText('Full Compliance')).toBeNull();
  });
});
