import type { EmbeddingProvider } from '@djimitflo/shared';
export type { EmbeddingProvider } from '@djimitflo/shared';

function validateEmbedding(value: unknown, providerId: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new Error(`Embedding provider ${providerId} returned an invalid vector`);
  }
  return value as number[];
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Embedding request failed (${response.status})`);
  return response.json();
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly modelId: string;
  private detectedDimensions = 0;
  get dimensions(): number { return this.detectedDimensions; }

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs = 30_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.modelId = model;
    this.id = `ollama:${model}`;
  }

  async embed(text: string): Promise<number[]> {
    const result = await postJson(
      `${this.baseUrl}/api/embeddings`,
      { model: this.model, prompt: text },
      {},
      this.timeoutMs,
    ) as { embedding?: unknown };
    const embedding = validateEmbedding(result.embedding, this.id);
    this.detectedDimensions = embedding.length;
    return embedding;
  }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly modelId: string;
  private detectedDimensions = 0;
  get dimensions(): number { return this.detectedDimensions; }

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs = 30_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.modelId = model;
    this.id = `openai-compatible:${model}`;
  }

  async embed(text: string): Promise<number[]> {
    const result = await postJson(
      `${this.baseUrl}/embeddings`,
      { model: this.model, input: text },
      { Authorization: `Bearer ${this.apiKey}` },
      this.timeoutMs,
    ) as { data?: Array<{ embedding?: unknown }> };
    const embedding = validateEmbedding(result.data?.[0]?.embedding, this.id);
    this.detectedDimensions = embedding.length;
    return embedding;
  }
}

export function createEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const provider = env.EMBEDDING_PROVIDER || 'ollama';
  const model = env.EMBEDDING_MODEL || env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
  const timeoutMs = Number(env.EMBEDDING_TIMEOUT_MS || 30_000);

  if (provider === 'ollama') {
    return new OllamaEmbeddingProvider(
      env.EMBEDDING_OLLAMA_URL || env.OLLAMA_URL || env.OLLAMA_HOST || 'http://127.0.0.1:11434',
      model,
      timeoutMs,
    );
  }
  if (provider === 'openai-compatible') {
    if (!env.EMBEDDING_BASE_URL || !env.EMBEDDING_API_KEY) {
      throw new Error('EMBEDDING_BASE_URL and EMBEDDING_API_KEY are required for openai-compatible embeddings');
    }
    return new OpenAICompatibleEmbeddingProvider(env.EMBEDDING_BASE_URL, env.EMBEDDING_API_KEY, model, timeoutMs);
  }
  throw new Error(`Unsupported EMBEDDING_PROVIDER: ${provider}`);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}
