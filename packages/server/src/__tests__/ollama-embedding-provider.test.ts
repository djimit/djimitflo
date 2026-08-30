import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaEmbeddingProvider } from '../services/ollama-embedding-provider';

describe('OllamaEmbeddingProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns a real provider vector from the current Ollama endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaEmbeddingProvider('http://ollama.test', 'embed-model', 100);

    await expect(provider.embed('semantic input')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(fetchMock).toHaveBeenCalledWith('http://ollama.test/api/embed', expect.objectContaining({ method: 'POST' }));
  });

  it('supports the legacy Ollama embeddings endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ embedding: [0.4, 0.5] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaEmbeddingProvider('http://ollama.test', 'embed-model', 100);

    await expect(provider.embed('legacy input')).resolves.toEqual([0.4, 0.5]);
    expect(fetchMock.mock.calls[1][0]).toBe('http://ollama.test/api/embeddings');
  });
});
