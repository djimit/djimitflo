import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExploreHeroProps } from '@djimitflo/shared';
import { ExploreHero } from './ExploreHero';

const baseProps: ExploreHeroProps = {
  repository_full_name: 'djimitflo/djimitflo',
  repository_url: 'https://github.com/djimitflo/djimitflo',
  tagline: 'A self-improving agent loop.',
  stack_badges: [
    { name: 'TypeScript', icon: 'TS', detected_from: 'package.json' },
    { name: 'Vitest', detected_from: 'ci.yml' },
  ],
  openmythos_score: 88,
  health_score: 72,
  generated_at: '2026-11-08T00:00:00.000Z',
};

describe('ExploreHero', () => {
  it('renders the repository name, tagline, and GitHub link', () => {
    const html = renderToStaticMarkup(<ExploreHero {...baseProps} />);
    expect(html).toContain('djimitflo/djimitflo');
    expect(html).toContain('A self-improving agent loop.');
    expect(html).toContain('href="https://github.com/djimitflo/djimitflo"');
    expect(html).toContain('View on GitHub');
  });

  it('renders every stack badge with its detected_from title and icon fallback', () => {
    const html = renderToStaticMarkup(<ExploreHero {...baseProps} />);
    expect(html).toContain('TypeScript');
    expect(html).toContain('Detected from package.json');
    expect(html).toContain('Vitest');
    expect(html).toContain('Detected from ci.yml');
    // The badge without an icon falls back to the bullet glyph.
    expect(html).toContain('●');
    expect(html).toContain('TS');
  });

  it('labels the OpenMythos trust score Verified when score >= 85', () => {
    const html = renderToStaticMarkup(<ExploreHero {...baseProps} openmythos_score={90} />);
    expect(html).toContain('Verified');
    expect(html).toContain('text-emerald-400');
    expect(html).toContain('title="OpenMythos trust score: 90.0 / 100"');
  });

  it('labels the trust score Review when 60 <= score < 85', () => {
    const html = renderToStaticMarkup(<ExploreHero {...baseProps} openmythos_score={60} />);
    expect(html).toContain('Review');
    expect(html).toContain('text-amber-400');
  });

  it('labels the trust score Early when score < 60', () => {
    const html = renderToStaticMarkup(<ExploreHero {...baseProps} openmythos_score={30} />);
    expect(html).toContain('Early');
    expect(html).toContain('text-rose-500');
  });

  it('treats a null OpenMythos score as 0 with the Early label', () => {
    const html = renderToStaticMarkup(<ExploreHero {...baseProps} openmythos_score={null} />);
    expect(html).toContain('Early');
    expect(html).toContain('text-rose-500');
    expect(html).toContain('title="OpenMythos trust score: 0.0 / 100"');
  });

  it('renders the health meter when health_score is provided', () => {
    const html = renderToStaticMarkup(<ExploreHero {...baseProps} health_score={72} />);
    expect(html).toContain('72/100');
    expect(html).toContain('Health');
    expect(html).toContain('stroke-dasharray="72, 100"');
  });

  it('omits the health meter when health_score is null', () => {
    const html = renderToStaticMarkup(<ExploreHero {...baseProps} health_score={null} />);
    expect(html).not.toContain('/100');
    expect(html).not.toContain('Health');
  });

  it('renders the generated_at timestamp', () => {
    const html = renderToStaticMarkup(<ExploreHero {...baseProps} />);
    expect(html).toContain('Last generated:');
    // The exact locale string varies by environment, so only assert the date.
    expect(html).toMatch(/2026/);
  });
});
