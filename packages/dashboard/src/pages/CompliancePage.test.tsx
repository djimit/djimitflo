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
    expect(screen.getByText('partial-spec')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Compliance filter'), { target: { value: 'full' } });
    expect(screen.queryByText('partial-spec')).toBeNull();
    expect(screen.getByText('Export JSON')).toBeTruthy();
  });
});
