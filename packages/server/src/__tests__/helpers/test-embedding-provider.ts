import type { EmbeddingProvider } from '../../services/embedding-provider';

const concepts = [
  ['security', 'vulnerability', 'auth', 'authentication'],
  ['database', 'connection', 'pool', 'postgres'],
  ['performance', 'optimization', 'cache', 'caching'],
  ['typescript', 'javascript', 'typed', 'types', 'interfaces', 'generics'],
  ['python', 'dynamic'],
  ['memory', 'learning', 'feedback'],
];

export const testEmbeddingProvider: EmbeddingProvider = {
  id: 'test:concepts',
  async embed(text: string) {
    const words = new Set(text.toLowerCase().split(/\W+/));
    const vector: number[] = concepts.map((concept) => concept.filter((word) => words.has(word)).length);
    return [...vector, vector.some((value) => value > 0) ? 0 : 1];
  },
};
