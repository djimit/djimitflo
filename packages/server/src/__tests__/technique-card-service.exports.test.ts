import { afterEach, describe, expect, it, vi } from 'vitest';
import { scholarlyAbstractFetcher } from '../services/technique-card-service';

afterEach(() => vi.unstubAllGlobals());

const dataciteBody = (doi: string, abstract: string) => ({
  data: {
    attributes: {
      doi,
      titles: [{ title: `Paper ${doi}` }],
      descriptions: [{ description: abstract, descriptionType: 'Abstract' }],
      creators: [],
      subjects: [],
    },
  },
});

const arxivXml = (id: string, summary: string) =>
  `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/${id}</id><title>Paper ${id}</title><summary>${summary}</summary><author><name>A Researcher</name></author></entry></feed>`;

const isDatacite = (url: string) => url.includes('api.datacite.org');
const isArxiv = (url: string) => url.includes('export.arxiv.org');

describe('scholarlyAbstractFetcher', () => {
  it('returns the DataCite abstract for a doi: ref', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (isDatacite(url)) return new Response(JSON.stringify(dataciteBody('10.48550/arxiv.2601.04728', 'DataCite abstract.')), { status: 200 });
        throw new Error(`unexpected ${url}`);
      }) as unknown as typeof fetch,
    );
    const fetcher = scholarlyAbstractFetcher();
    expect(await fetcher('doi:10.48550/arxiv.2601.04728')).toBe('DataCite abstract.');
  });

  it('returns null for a doi: ref DataCite does not hold (no arXiv fallback for DOI refs)', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (isDatacite(url)) return new Response('', { status: 404 });
        throw new Error(`unexpected ${url}`);
      }) as unknown as typeof fetch,
    );
    const fetcher = scholarlyAbstractFetcher();
    expect(await fetcher('doi:10.9999/missing')).toBeNull();
    expect(calls.every(isDatacite)).toBe(true);
  });

  it('returns the DataCite abstract for an arxiv: ref without calling arXiv when DataCite has it', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (isDatacite(url)) return new Response(JSON.stringify(dataciteBody('10.48550/arxiv.2601.04728', 'From DataCite.')), { status: 200 });
        throw new Error(`unexpected ${url}`);
      }) as unknown as typeof fetch,
    );
    const fetcher = scholarlyAbstractFetcher();
    expect(await fetcher('arxiv:2601.04728')).toBe('From DataCite.');
    expect(calls.every(isDatacite)).toBe(true);
  });

  it('falls back to the arXiv adapter when DataCite has no DOI for the arXiv id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (isDatacite(url)) return new Response('', { status: 404 });
        if (isArxiv(url)) return new Response(arxivXml('2601.99999', 'From arXiv.'), { status: 200 });
        throw new Error(`unexpected ${url}`);
      }) as unknown as typeof fetch,
    );
    const fetcher = scholarlyAbstractFetcher();
    expect(await fetcher('arxiv:2601.99999')).toBe('From arXiv.');
  });

  it('returns null when neither DataCite nor arXiv has the arXiv id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (isDatacite(url)) return new Response('', { status: 404 });
        if (isArxiv(url)) return new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>', { status: 200 });
        throw new Error(`unexpected ${url}`);
      }) as unknown as typeof fetch,
    );
    const fetcher = scholarlyAbstractFetcher();
    expect(await fetcher('arxiv:2601.00000')).toBeNull();
  });

  it('returns null for an unrecognized ref without calling any source', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const fetcher = scholarlyAbstractFetcher();
    expect(await fetcher('expert:aaaaaaaa-0000-4000-8000-000000000001')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses case-insensitive DOI: and ARXIV: prefixes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (isDatacite(url)) return new Response(JSON.stringify(dataciteBody('10.48550/arxiv.2601.04728', 'Lowercase prefix abstract.')), { status: 200 });
        throw new Error(`unexpected ${url}`);
      }) as unknown as typeof fetch,
    );
    const fetcher = scholarlyAbstractFetcher();
    expect(await fetcher('DOI:10.48550/arxiv.2601.04728')).toBe('Lowercase prefix abstract.');
    expect(await fetcher('ARXIV:2601.04728')).toBe('Lowercase prefix abstract.');
  });

  it('returns null for a malformed arXiv id (wrong digit shape)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const fetcher = scholarlyAbstractFetcher();
    expect(await fetcher('arxiv:not-an-id')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});