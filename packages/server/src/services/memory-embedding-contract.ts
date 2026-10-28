/**
 * One embedding contract for the Qdrant memory collections (CODE-001/002, forensic audit 2026-10-26).
 *
 * Model: every writer (memory-sync, memory flywheel, reasoning bank) and every reader of these
 * collections resolves the model here, per call, so they cannot drift apart. Dimension: never
 * guessed from the model name — it is the collection's configured vector size, and the actual
 * embedding must match it. A mismatch is reported as unavailable and the write/query is skipped.
 *
 * Nothing on these paths ever DELETEs or recreates a collection: a points_count read is not a
 * lock, so "empty" can be stale, missing or raced by a concurrent writer. Only a 404 (no
 * collection at all) may be created. Moving a collection to another model/dimension is an
 * operator migration (new collection, backfill, switch readers, keep the old one for rollback),
 * see docs/design/embedding-unification.md — it is deliberately not automated here.
 */

export const SWARM_MEMORY_COLLECTION = 'djimitflo_swarm';

/** The embedding model for the memory collections; resolved per call so env changes apply without a rebuild. */
export const memoryEmbedModel = (env: NodeJS.ProcessEnv = process.env): string =>
  env.DJIMITFLO_EMBED_MODEL || env.OLLAMA_EMBED_MODEL || 'snowflake-arctic-embed:s';

const QDRANT_TIMEOUT_MS = 5_000;

export type CollectionState =
  | { status: 'ready' }
  | { status: 'missing' }
  | { status: 'unavailable'; reason: string };

/**
 * Read-only compatibility check of a collection against an embedding of `dim` dimensions.
 * An unknown vector size is unavailable (never assumed compatible).
 */
export async function checkCollection(base: string, collection: string, headers: Record<string, string>, dim: number, model: string): Promise<CollectionState> {
  const res = await fetch(`${base}/collections/${collection}`, { headers, signal: AbortSignal.timeout(QDRANT_TIMEOUT_MS) });
  if (res.status === 404) return { status: 'missing' };
  if (!res.ok) return { status: 'unavailable', reason: `collection check ${res.status}` };
  const info = (await res.json()) as { result?: { config?: { params?: { vectors?: { size?: unknown } } } } };
  const size = info.result?.config?.params?.vectors?.size;
  if (typeof size !== 'number') return { status: 'unavailable', reason: 'collection vector size unknown' };
  if (size !== dim) {
    return { status: 'unavailable', reason: `dimension mismatch: ${collection} is ${size}-dim, ${model} embedding is ${dim}-dim (no automatic repair; operator migration required)` };
  }
  return { status: 'ready' };
}

/** Writer variant: like checkCollection, but a missing collection (404) is created at `dim`. Never deletes. */
export async function ensureCollection(base: string, collection: string, headers: Record<string, string>, dim: number, model: string): Promise<{ status: 'ready' } | { status: 'unavailable'; reason: string }> {
  const state = await checkCollection(base, collection, headers, dim, model);
  if (state.status !== 'missing') return state;
  const res = await fetch(`${base}/collections/${collection}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ vectors: { size: dim, distance: 'Cosine' } }),
    signal: AbortSignal.timeout(QDRANT_TIMEOUT_MS),
  });
  return res.ok ? { status: 'ready' } : { status: 'unavailable', reason: `collection create ${res.status}` };
}
