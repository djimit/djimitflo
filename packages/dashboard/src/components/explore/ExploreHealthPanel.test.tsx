import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExploreHealthPanel } from './ExploreHealthPanel';
import type { ExploreHealthPanelProps, HealthMeter } from '@djimitflo/shared';

const meter = (over: Partial<HealthMeter>): HealthMeter => ({
  label: 'Coverage',
  score: 80,
  status: 'good',
  recommendation: 'Add more tests',
  ...over,
});

describe('ExploreHealthPanel', () => {
  it('renders the section heading and the overall score when provided', () => {
    const props: ExploreHealthPanelProps = {
      overall_health: 73,
      meters: [meter({ label: 'Coverage', score: 73 })],
    };
    const html = renderToStaticMarkup(<ExploreHealthPanel {...props} />);
    expect(html).toContain('Repository health');
    expect(html).toContain('73');
    expect(html).toContain('Overall health score out of 100');
  });

  it('omits the overall score block when overall_health is null', () => {
    const props: ExploreHealthPanelProps = {
      overall_health: null,
      meters: [meter({ label: 'Coverage', score: 90, status: 'good' })],
    };
    const html = renderToStaticMarkup(<ExploreHealthPanel {...props} />);
    expect(html).not.toContain('Overall health score out of 100');
    expect(html).toContain('Repository health');
  });

  it('renders every meter label and score, and renders recommendations when present', () => {
    const props: ExploreHealthPanelProps = {
      overall_health: 50,
      meters: [
        meter({ label: 'Coverage', score: 50, status: 'warning', recommendation: 'Raise coverage' }),
        meter({ label: 'Security', score: 10, status: 'critical', recommendation: 'Patch CVEs' }),
      ],
    };
    const html = renderToStaticMarkup(<ExploreHealthPanel {...props} />);
    expect(html).toContain('Coverage');
    expect(html).toContain('50/100');
    expect(html).toContain('Security');
    expect(html).toContain('10/100');
    expect(html).toContain('Raise coverage');
    expect(html).toContain('Patch CVEs');
  });

  it('omits the recommendation line when a meter has no recommendation', () => {
    const props: ExploreHealthPanelProps = {
      overall_health: null,
      meters: [meter({ label: 'Docs', score: 95, status: 'good', recommendation: undefined })],
    };
    const html = renderToStaticMarkup(<ExploreHealthPanel {...props} />);
    expect(html).toContain('Docs');
    expect(html).toContain('95/100');
    expect(html).not.toContain('Add more tests');
  });

  it('maps each status to the correct indicator color class', () => {
    const cases: Array<{ status: HealthMeter['status']; cls: string }> = [
      { status: 'good', cls: 'bg-emerald-500' },
      { status: 'warning', cls: 'bg-amber-400' },
      { status: 'critical', cls: 'bg-rose-500' },
      { status: 'unknown', cls: 'bg-slate-500' },
    ];
    for (const { status, cls } of cases) {
      const html = renderToStaticMarkup(
        <ExploreHealthPanel
          overall_health={null}
          meters={[meter({ label: status, score: 1, status, recommendation: undefined })]}
        />,
      );
      expect(html).toContain(cls);
    }
  });

  it('renders an empty meter grid when there are no meters', () => {
    const props: ExploreHealthPanelProps = { overall_health: 100, meters: [] };
    const html = renderToStaticMarkup(<ExploreHealthPanel {...props} />);
    expect(html).toContain('Repository health');
    expect(html).toContain('100');
    expect(html).not.toContain('/100');
  });
});
