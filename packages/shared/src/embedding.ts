export interface EmbeddingProvider {
  readonly id: string;
  readonly modelId: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}
