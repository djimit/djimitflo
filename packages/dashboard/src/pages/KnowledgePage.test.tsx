import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { KnowledgeBody } from './KnowledgePage';

it('W5: shows sources with relevance, recent relevant items, KB hits and the interest profile', () => {
  const html = renderToStaticMarkup(<KnowledgeBody data={{
    at: '2026-09-30T20:00:00Z',
    sources: [{ source: 'operator-chatgpt', events: 1072, events_7d: 0, last: '2026-09-27T22:00:00Z', yes: 8, uncertain: 162, no: 58, units: 205, relevant_pct: 3.5 }],
    relevance: { yes: 8, uncertain: 162, no: 58 },
    recent_relevant: [{ ref: 'arxiv:1', title: 'GitHarness', source: 'djimitflo-scout', at: '2026-09-30T07:00:00Z' }],
    kb_retrieval: { hits_30d: 12, panels_30d: 11, last: '2026-09-29T17:40:00Z' },
    interest_profile: { at: '2026-09-30T05:18:00Z', terms: ['agents', 'repair'] },
  }} />);
  for (const text of ['operator-chatgpt', '3.5 %', '4 % relevant overall', 'GitHarness', '12 page hits in 11 panel reviews', 'repair']) expect(html).toContain(text);
});

it('W5: empty states say what is missing', () => {
  const html = renderToStaticMarkup(<KnowledgeBody data={{ at: '', sources: [], relevance: { yes: 0, uncertain: 0, no: 0 }, recent_relevant: [], kb_retrieval: { hits_30d: 0, panels_30d: 0, last: null }, interest_profile: null }} />);
  for (const text of ['No discoveries in the last 30 days.', 'Nothing judged relevant yet.', 'No profile published yet.']) expect(html).toContain(text);
});
