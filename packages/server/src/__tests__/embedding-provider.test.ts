import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OllamaEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
  cosineSimilarity,
  createEmbeddingProvider,
} from '../services/embedding-provider';

afterEach(() => vi.unstubAllGlobals());

describe('embedding providers', () => {
  it('sends the Ollama contract and normalizes its URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ embedding: [1, 2] }) });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaEmbeddingProvider('http://ollama/', 'model', 99);
    expect(await provider.embed('hello')).toEqual([1, 2]);
    expect(provider).toMatchObject({ modelId: 'model', dimensions: 2 });
    expect(fetchMock).toHaveBeenCalledWith('http://ollama/api/embeddings', expect.objectContaining({ method: 'POST', body: JSON.stringify({ model: 'model', prompt: 'hello' }) }));
  });

  it('sends the OpenAI-compatible contract with attribution header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [3, 4] }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleEmbeddingProvider('http://api/', 'secret', 'model');
    expect(await provider.embed('hello')).toEqual([3, 4]);
    expect(provider).toMatchObject({ modelId: 'model', dimensions: 2 });
    expect(fetchMock).toHaveBeenCalledWith('http://api/embeddings', expect.objectContaining({ headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' }, body: JSON.stringify({ model: 'model', input: 'hello' }) }));
  });

  it.each([undefined, [], [1, Number.NaN], ['1']])('rejects invalid vectors: %j', async embedding => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ embedding }) }));
    await expect(new OllamaEmbeddingProvider('http://ollama', 'model').embed('hello')).rejects.toThrow('invalid vector');
  });

  it('reports non-success HTTP responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(new OllamaEmbeddingProvider('http://ollama', 'model').embed('hello')).rejects.toThrow('(503)');
  });

  it.each([{}, { data: [] }, { data: [{}] }])('rejects missing OpenAI-compatible vectors: %j', async payload => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));
    await expect(new OpenAICompatibleEmbeddingProvider('http://api', 'key', 'model').embed('hello')).rejects.toThrow('invalid vector');
  });

  it('selects configured providers and rejects incomplete or unknown configuration', () => {
    expect(createEmbeddingProvider({ EMBEDDING_PROVIDER: 'ollama', EMBEDDING_MODEL: 'm', EMBEDDING_OLLAMA_URL: 'http://o' } as any).id).toBe('ollama:m');
    expect(createEmbeddingProvider({ EMBEDDING_PROVIDER: 'openai-compatible', EMBEDDING_BASE_URL: 'http://a', EMBEDDING_API_KEY: 'k', EMBEDDING_MODEL: 'm' } as any).id).toBe('openai-compatible:m');
    expect(() => createEmbeddingProvider({ EMBEDDING_PROVIDER: 'openai-compatible' } as any)).toThrow('required');
    expect(() => createEmbeddingProvider({ EMBEDDING_PROVIDER: 'openai-compatible', EMBEDDING_BASE_URL: 'http://a' } as any)).toThrow('required');
    expect(() => createEmbeddingProvider({ EMBEDDING_PROVIDER: 'openai-compatible', EMBEDDING_API_KEY: 'k' } as any)).toThrow('required');
    expect(() => createEmbeddingProvider({ EMBEDDING_PROVIDER: 'unknown' } as any)).toThrow('Unsupported');
  });

  it('computes cosine similarity including invalid and zero vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([2, 0], [2, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});
