import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SWARM_MEMORY_COLLECTION,
  memoryEmbedModel,
  checkCollection,
  ensureCollection,
} from '../services/memory-embedding-contract';

// memory-embedding-contract is the single embedding contract for the Qdrant swarm-memory
// collections. These tests cover the public exports without hitting a real Qdrant: fetch is
// stubbed per test so the read-only check and the writer ensure paths are exercised deterministically.

const BASE = 'http://qdrant.local:6333';
const HEADERS = { Authorization: 'Bearer x' };
const COLLECTION = SWARM_MEMORY_COLLECTION;
const DIM = 384;
const MODEL = 'snowflake-arctic-embed:s';

const jsonRes = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const emptyRes = (status: number): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => ({}) }) as unknown as Response;

const collectionInfo = (size: unknown) => ({
  result: { config: { params: { vectors: { size } } } },
});

let originalFetch: typeof globalThis.fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

const stubFetch = (impl: (input: unknown, init?: RequestInit) => Promise<Response> | Response) => {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
};

describe('SWARM_MEMORY_COLLECTION', () => {
  it('is the stable collection name string', () => {
    expect(SWARM_MEMORY_COLLECTION).toBe('djimitflo_swarm');
    expect(typeof SWARM_MEMORY_COLLECTION).toBe('string');
  });
});

describe('memoryEmbedModel', () => {
  it("defaults to 'snowflake-arctic-embed:s' when no env var is set", () => {
    expect(memoryEmbedModel({})).toBe('snowflake-arctic-embed:s');
  });

  it('prefers DJIMITFLO_EMBED_MODEL over OLLAMA_EMBED_MODEL', () => {
    expect(memoryEmbedModel({ DJIMITFLO_EMBED_MODEL: 'a', OLLAMA_EMBED_MODEL: 'b' })).toBe('a');
  });

  it('falls back to OLLAMA_EMBED_MODEL when DJIMITFLO_EMBED_MODEL is unset', () => {
    expect(memoryEmbedModel({ OLLAMA_EMBED_MODEL: 'b' })).toBe('b');
  });

  it('treats an empty string as unset and falls through', () => {
    expect(memoryEmbedModel({ DJIMITFLO_EMBED_MODEL: '', OLLAMA_EMBED_MODEL: '' })).toBe('snowflake-arctic-embed:s');
    expect(memoryEmbedModel({ DJIMITFLO_EMBED_MODEL: '', OLLAMA_EMBED_MODEL: 'b' })).toBe('b');
  });

  it('reads process.env by default', () => {
    const before = process.env.DJIMITFLO_EMBED_MODEL;
    try {
      process.env.DJIMITFLO_EMBED_MODEL = 'env-model';
      expect(memoryEmbedModel()).toBe('env-model');
    } finally {
      if (before === undefined) delete process.env.DJIMITFLO_EMBED_MODEL;
      else process.env.DJIMITFLO_EMBED_MODEL = before;
    }
  });
});

describe('checkCollection', () => {
  it('returns ready when the collection vector size matches dim', async () => {
    stubFetch(async () => jsonRes(collectionInfo(DIM)));
    await expect(checkCollection(BASE, COLLECTION, HEADERS, DIM, MODEL)).resolves.toEqual({ status: 'ready' });
  });

  it('returns missing on a 404', async () => {
    stubFetch(async () => emptyRes(404));
    await expect(checkCollection(BASE, COLLECTION, HEADERS, DIM, MODEL)).resolves.toEqual({ status: 'missing' });
  });

  it('returns unavailable with a reason on a non-ok non-404 status', async () => {
    stubFetch(async () => emptyRes(503));
    await expect(checkCollection(BASE, COLLECTION, HEADERS, DIM, MODEL)).resolves.toEqual({
      status: 'unavailable', reason: 'collection check 503',
    });
  });

  it('returns unavailable when the vector size is not a number', async () => {
    stubFetch(async () => jsonRes(collectionInfo(null)));
    await expect(checkCollection(BASE, COLLECTION, HEADERS, DIM, MODEL)).resolves.toEqual({
      status: 'unavailable', reason: 'collection vector size unknown',
    });
  });

  it('returns unavailable when the size path is absent', async () => {
    stubFetch(async () => jsonRes({ result: { config: { params: {} } } }));
    await expect(checkCollection(BASE, COLLECTION, HEADERS, DIM, MODEL)).resolves.toEqual({
      status: 'unavailable', reason: 'collection vector size unknown',
    });
  });

  it('returns unavailable with a dimension-mismatch reason naming both sizes', async () => {
    stubFetch(async () => jsonRes(collectionInfo(768)));
    const state = await checkCollection(BASE, COLLECTION, HEADERS, DIM, MODEL);
    expect(state).toEqual({
      status: 'unavailable',
      reason: `dimension mismatch: ${COLLECTION} is 768-dim, ${MODEL} embedding is ${DIM}-dim (no automatic repair; operator migration required)`,
    });
  });

  it('issues a GET to /collections/<collection> with the supplied headers', async () => {
    const fn = stubFetch(async () => jsonRes(collectionInfo(DIM)));
    await checkCollection(BASE, COLLECTION, HEADERS, DIM, MODEL);
    expect(fn).toHaveBeenCalledTimes(1);
    const [input, init] = fn.mock.calls[0];
    expect(String(input)).toBe(`${BASE}/collections/${COLLECTION}`);
    expect(init?.headers).toBe(HEADERS);
    expect(init?.method).toBeUndefined();
  });
});

describe('ensureCollection', () => {
  it('returns ready without creating when the collection already matches dim', async () => {
    const fn = stubFetch(async () => jsonRes(collectionInfo(DIM)));
    await expect(ensureCollection(BASE, COLLECTION, HEADERS, DIM, MODEL)).resolves.toEqual({ status: 'ready' });
    expect(fn).toHaveBeenCalledTimes(1); // only the check GET, no PUT
  });

  it('returns unavailable (no create) on a dimension mismatch', async () => {
    const fn = stubFetch(async () => jsonRes(collectionInfo(768)));
    const state = await ensureCollection(BASE, COLLECTION, HEADERS, DIM, MODEL);
    expect(state).toEqual({ status: 'unavailable', reason: expect.stringContaining('dimension mismatch') });
    expect(fn).toHaveBeenCalledTimes(1); // never deletes/recreates
  });

  it('creates the collection on a 404 and returns ready on a successful PUT', async () => {
    const fn = stubFetch(async (_input, init) => (init?.method === 'PUT' ? emptyRes(200) : emptyRes(404)));
    const state = await ensureCollection(BASE, COLLECTION, HEADERS, DIM, MODEL);
    expect(state).toEqual({ status: 'ready' });
    expect(fn).toHaveBeenCalledTimes(2);
    const putCall = fn.mock.calls[1];
    expect(putCall[1]?.method).toBe('PUT');
    expect(JSON.parse(String(putCall[1]?.body))).toEqual({ vectors: { size: DIM, distance: 'Cosine' } });
  });

  it('returns unavailable when the create PUT fails', async () => {
    const fn = stubFetch(async (_input, init) => (init?.method === 'PUT' ? emptyRes(500) : emptyRes(404)));
    const state = await ensureCollection(BASE, COLLECTION, HEADERS, DIM, MODEL);
    expect(state).toEqual({ status: 'unavailable', reason: 'collection create 500' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('returns unavailable (no create) when the check itself is unavailable', async () => {
    const fn = stubFetch(async () => emptyRes(503));
    const state = await ensureCollection(BASE, COLLECTION, HEADERS, DIM, MODEL);
    expect(state).toEqual({ status: 'unavailable', reason: 'collection check 503' });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});