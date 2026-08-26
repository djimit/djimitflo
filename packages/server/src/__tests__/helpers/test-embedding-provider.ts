import type { EmbeddingProvider } from '@djimitflo/shared';

export class TestEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'test:semantic';

  async embed(text: string): Promise<number[]> {
    const value = text.toLowerCase();
    const terms = ['typescript', 'javascript', 'python', 'security', 'vulnerability', 'performance', 'memory'];
    const vector: number[] = terms.map((term) => value.includes(term) ? 1 : 0);
    vector.push(Math.max(1, value.split(/\s+/).length) / 10);
    return vector;
  }
}
