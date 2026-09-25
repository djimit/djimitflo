import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { identityConfidence } from '../services/expert-evidence-enrichment-service';
import { DataCiteAdapter, dataCiteName, parseDataCiteRecords } from '../services/knowledge-adapters/datacite-adapter';

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'datacite-leike.json'), 'utf8'));

describe('DataCite DOI adapter (arXiv-native Tier-1 evidence, §10, I10)', () => {
  it('maps a real response: arXiv ids from DOIs, category codes from subjects, abstracts, reordered names', () => {
    expect(dataCiteName('Jan Leike')).toBe('Leike, Jan');
    expect(dataCiteName('Leike, Jan')).toBe('Leike, Jan');
    const papers = parseDataCiteRecords(fixture);
    expect(papers).toHaveLength(5);
    expect(papers[0]).toMatchObject({ arxiv_id: '2601.04728', url: 'https://arxiv.org/abs/2601.04728', primary_category: 'cs.LG', published: '2026' });
    expect(papers[0].categories).toEqual(expect.arrayContaining(['cs.LG', 'cs.AI', 'Machine Learning (cs.LG)']));
    expect(papers[0].authors).toContain('Jan Leike');
    expect(papers[0].summary.length).toBeGreaterThan(100);
    const identity = identityConfidence(papers, 'Jan Leike');
    expect(identity.matched.length).toBeGreaterThanOrEqual(2);
    expect(identity.ai_share).toBe(1);
    expect(identity.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('queries both name orders and surfaces HTTP failures as source errors', async () => {
    const calls: string[] = [];
    const adapter = new DataCiteAdapter((async (url: string | URL | Request) => { calls.push(decodeURIComponent(String(url)).replace(/\+/g, " ")); return new Response(JSON.stringify(fixture), { status: 200 }); }) as typeof fetch);
    expect(await adapter.searchAuthorPapers('Jan Leike', 3)).toHaveLength(3);
    expect(calls[0]).toContain('creators.name:("Leike, Jan" OR "Jan Leike")');
    await expect(new DataCiteAdapter((async () => new Response('', { status: 503 })) as typeof fetch).searchAuthorPapers('X')).rejects.toThrow('DATACITE_HTTP_503');
  });
});
