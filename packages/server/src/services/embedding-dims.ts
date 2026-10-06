/**
 * UX-21: embeddings live at 768d (nomic-embed-text), 384d (snowflake-arctic-embed:s) and 2048d (nemotron-3-embed-1b)
 * in different stores. Comparing vectors of different dimension is meaningless: vector-memory resampled them by index
 * striding, proposal-dedupe silently scored 0. Every mismatch is now counted ('embedding_dim_mismatch', per store);
 * with VECTOR_STRICT_DIM=true a mismatched vector is skipped instead of resampled. Default keeps today's behaviour.
 */
export const vectorStrictDim = (env: NodeJS.ProcessEnv = process.env): boolean => env.VECTOR_STRICT_DIM === 'true';

const mismatches = new Map<string, number>();

/** True when the two dims match. Otherwise counts the mismatch for the store and returns false. */
export function dimsMatch(store: string, expected: number, got: number): boolean {
  if (expected === got) return true;
  mismatches.set(store, (mismatches.get(store) ?? 0) + 1);
  return false;
}

/** Mismatch counts per store since boot (in memory; read by the evidence endpoint). */
export const embeddingDimMismatch = (): Record<string, number> => Object.fromEntries(mismatches);
export const resetEmbeddingDimMismatch = (): void => mismatches.clear();
