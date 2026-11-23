import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import type { EvolutionEvidence } from '../../lib/api';
import { SignalsBody } from './Signals';

const body = (data: Partial<EvolutionEvidence>, interactions: number | null = null) =>
  render(<MemoryRouter><SignalsBody data={data as EvolutionEvidence} interactions={interactions} /></MemoryRouter>);

it('shows the maker forecast score, curiosity, dreams and agent-to-agent counts', () => {
  body({
    flags: [{ name: 'MAKER_FORECAST_MODE', acting: true, value: 'shadow' }],
    maker_forecast: { window_days: 60, n: 4, positives: 1, unresolved: 2, brier: 0.3375, base_rate: 0.25, baseline_brier: 0.1875, skill: -0.8, note: '' },
    knowledge_gaps: { mode: 'shadow', status: 'ok', window_days: 30, open: 7, open_by_source: null, recurrences: 3, oldest_age_days: 12, capability_candidates: 0, note: '' },
    knowledge_links: { genomes_with_refs: 2, genomes_total: 5, proposals_with_refs: 0 },
  }, 42);
  expect(screen.getByText('mode shadow')).toBeTruthy();
  expect(screen.getByText('1 (25 %)')).toBeTruthy();
  expect(screen.getByText('0.338')).toBeTruthy();
  expect(screen.getByText('-0.80')).toBeTruthy();
  expect(screen.getByText('7')).toBeTruthy();
  expect(screen.getByText('5')).toBeTruthy();
  expect(screen.getByText('42')).toBeTruthy();
});

it('renders missing evidence as a dash, never as zero', () => {
  const { container } = body({});
  expect(screen.getByText('No scored forecast yet: the flag is off.')).toBeTruthy();
  expect(container.textContent).not.toMatch(/\b0\b(?! =)/);
  expect(screen.getAllByText('—').length).toBeGreaterThan(8);
});
