import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExploreReadmeWidgetProps } from '@djimitflo/shared';
import { ExploreReadmeWidget } from './ExploreReadmeWidget';

const baseProps: ExploreReadmeWidgetProps = {
  repository_full_name: 'djimitflo/djimitflo',
  openmythos_score: 88,
  tagline: 'A self-improving agent loop.',
  explainer_url: 'https://djimitflo.com/explore/djimitflo/djimitflo',
};

describe('ExploreReadmeWidget', () => {
  it('renders the heading and mentions the repository in the snippet guidance', () => {
    const html = renderToStaticMarkup(<ExploreReadmeWidget {...baseProps} />);
    expect(html).toContain('README embed widget');
    expect(html).toContain('djimitflo/djimitflo’s README');
    expect(html).toContain('explainer page');
  });

  it('embeds the tagline and explainer link inside the markdown snippet', () => {
    const html = renderToStaticMarkup(<ExploreReadmeWidget {...baseProps} />);
    expect(html).toContain('A self-improving agent loop.');
    expect(html).toContain('[Read the full Djimit Explore page →]');
    expect(html).toContain(baseProps.explainer_url);
  });

  it('links the rendered badge to the explainer page in a new tab', () => {
    const html = renderToStaticMarkup(<ExploreReadmeWidget {...baseProps} />);
    expect(html).toContain(`href="${baseProps.explainer_url}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('rounds the score and uses the green badge color when score >= 85', () => {
    const html = renderToStaticMarkup(<ExploreReadmeWidget {...baseProps} openmythos_score={88.4} />);
    expect(html).toContain('88%2F100-34d399');
    expect(html).toContain('alt="Djimit Explore score 88 / 100"');
  });

  it('uses the amber badge color when 60 <= score < 85', () => {
    const html = renderToStaticMarkup(<ExploreReadmeWidget {...baseProps} openmythos_score={60} />);
    expect(html).toContain('60%2F100-fbbf24');
  });

  it('uses the rose Badge color when score < 60', () => {
    const html = renderToStaticMarkup(<ExploreReadmeWidget {...baseProps} openmythos_score={42} />);
    expect(html).toContain('42%2F100-f43f5e');
  });

  it('treats a null OpenMythos score as 0 with the rose badge color', () => {
    const html = renderToStaticMarkup(<ExploreReadmeWidget {...baseProps} openmythos_score={null} />);
    expect(html).toContain('0%2F100-f43f5e');
    expect(html).toContain('alt="Djimit Explore score 0 / 100"');
  });

  it('builds the badge URL against the shields.io endpoint with the github logo', () => {
    const html = renderToStaticMarkup(<ExploreReadmeWidget {...baseProps} />);
    expect(html).toContain('https://img.shields.io/badge/Explore-');
    expect(html).toContain('logo=github');
    expect(html).toContain('style=flat');
  });
});
