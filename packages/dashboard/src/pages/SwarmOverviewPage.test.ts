import { describe, expect, it } from 'vitest';
import { asArray, pickList } from './SwarmOverviewPage';

describe('swarm overview list normalization', () => {
  it('keeps arrays and rejects non-arrays', () => {
    expect(asArray(['a'])).toEqual(['a']);
    expect(asArray({ items: [] })).toEqual([]);
    expect(asArray(null)).toEqual([]);
  });

  it('extracts list payloads returned by dashboard APIs', () => {
    expect(pickList({ discussions: [{ id: 'd1' }] }, ['discussions', 'data'])).toEqual([{ id: 'd1' }]);
    expect(pickList({ learnings: [{ id: 'l1' }] }, ['learnings', 'data'])).toEqual([{ id: 'l1' }]);
    expect(pickList({ data: [{ id: 'x1' }] }, ['learnings', 'data'])).toEqual([{ id: 'x1' }]);
    expect(pickList({ discussions: { id: 'bad' } }, ['discussions', 'data'])).toEqual([]);
  });
});
