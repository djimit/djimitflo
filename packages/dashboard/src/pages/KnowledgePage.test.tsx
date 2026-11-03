import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { KnowledgeBody, SkillCardsSection } from './KnowledgePage';

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

it('K4: skill cards by lane and status, with the latest cards; unknown is not zero', () => {
  const html = renderToStaticMarkup(<SkillCardsSection data={{
    mode: 'shadow', total: 3, reason: null, note: 'record-only: cards are never injected into any maker, checker or panel context',
    by_lane: [{ lane: 'test-gap-loop', kind: 'skill', status: 'survived', n: 2 }, { lane: 'test-gap-loop', kind: 'anti_pattern', status: 'candidate', n: 1 }],
    latest: [{ run_id: 'r1', kind: 'anti_pattern', status: 'candidate', content_sha256: 'x', created_at: '2026-10-16T08:00:00Z', updated_at: '2026-10-16T08:00:00Z',
      card: { lane: 'test-gap-loop', task_kind: 'test_gap', target_pattern: ['src/*.test.ts'], runtime: 'opencode', model: 'kimi', diff_shape: { files_changed: 1, diff_lines: 10, test_only: true }, failure: { gate: 'tests_lint_typecheck', signature: 'abc' } } }],
  }} />);
  for (const text of ['Distilled skill cards', '3 card(s)', 'never injected', 'test-gap-loop', 'anti-pattern · candidate', 'src/*.test.ts', 'gate tests_lint_typecheck']) expect(html).toContain(text);
  const unknown = renderToStaticMarkup(<SkillCardsSection data={{ mode: 'off', total: null, by_lane: [], latest: [], reason: 'no cards recorded yet', note: 'record-only' }} />);
  expect(unknown).toContain('unknown (no cards recorded yet)');
  expect(unknown).not.toContain('0 card(s)');
});

it('K1: shows knowledge fitness counts per kind and the top items; unknown stays a dash', () => {
  const html = renderToStaticMarkup(<KnowledgeBody data={{
    at: '', sources: [], relevance: { yes: 0, uncertain: 0, no: 0 }, recent_relevant: [], kb_retrieval: { hits_30d: 0, panels_30d: 0, last: null }, interest_profile: null,
    fitness: { at: '', window_days: 90, half_life_days: 30, min_n: 5, baseline: { n: 10, verified_rate: 0.4 }, runs: { in_window: 12, maker_attributable: 10, non_maker: 1, unattributed: 1 },
      by_kind: [{ kind: 'kb_page', inventory: 2, used_with_value: 1, used_no_value: 0, insufficient: 0, unused: 1 }, { kind: 'discovery', inventory: null, used_with_value: 0, used_no_value: 0, insufficient: 0, unused: null }],
      top: [{ kind: 'kb_page', id: 'a.md', title: 'Runbook', n_used: 5, n_verified: 4, n_regressed: 1, n_survived_14d: null, wilson: [0.38, 0.96], last_used_at: '2026-10-15T00:00:00Z', decayed_verified_rate: 0.8, status: 'used_with_value' }],
      rule: 'r' },
  }} />);
  for (const text of ['Knowledge fitness', '10 maker-attributable (baseline 40 % verified)', 'Runbook', '38 %–96 %', 'with value']) expect(html).toContain(text);
});
