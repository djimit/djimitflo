import type { EmbeddingProvider } from '@djimitflo/shared';

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;

  constructor(
    private readonly baseUrl = (process.env.OLLAMA_URL || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, ''),
    private readonly model = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
    private readonly timeoutMs = Number(process.env.EMBEDDING_TIMEOUT_MS) || 5_000,
  ) {
    this.name = `ollama:${model}`;
  }

  async embed(text: string): Promise<number[]> {
    if (!text.trim()) throw new Error('EMBEDDING_TEXT_REQUIRED');

    let response = await this.request('/api/embed', { model: this.model, input: text });
    if (response.status === 404) {
      response = await this.request('/api/embeddings', { model: this.model, prompt: text });
    }
    if (!response.ok) throw new Error(`EMBEDDING_PROVIDER_ERROR:${response.status}`);

    const payload = await response.json() as { embedding?: number[]; embeddings?: number[][] };
    const embedding = payload.embedding || payload.embeddings?.[0];
    if (!embedding?.length || embedding.some((value) => !Number.isFinite(value))) {
      throw new Error('EMBEDDING_PROVIDER_INVALID_RESPONSE');
    }
    return embedding;
  }

  private request(path: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}
