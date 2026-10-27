# Embedding unification (UX-21)

Djimitflo embeds text with three models in separate stores. Vectors from different models (or dimensions) live in
different spaces: comparing them is meaningless. Until UX-21, `vector-memory-service` resampled a mismatched vector by
index striding (cosine looks fine, means nothing) and `proposal-dedupe` silently scored it 0.

## What UX-21 changes (no re-embedding, nothing deleted)

- Every new write records the model and the dimension (SQLite columns `embedding_dim` / `embedding_model`, added with
  `ALTER TABLE … ADD COLUMN`; Qdrant payload fields `embedding_model`, `embedding_dim`).
- Every cross-dimension comparison is counted per store (`embedding_dim_mismatch` in
  `GET /api/health/evolution-evidence`, since boot).
- `VECTOR_STRICT_DIM=true` (default off) skips a mismatched vector instead of resampling it (vector memory). The KB
  and proposal-dedupe paths already scored a mismatch 0 / below threshold, so skipping there is behaviour-equivalent.

## Inventory (from code, 2026-10-06)

| Store | Where | Model | Dim | Rows in prod (read-only, 06-10) |
|---|---|---|---|---|
| `kb_pages.vector` (SQLite) | `kb-corpus.ts` | `nvidia/nemotron-3-embed-1b` (`EMBEDDING_MODEL`) | 2048 | 1 313 |
| `proposal_embeddings.vector` (SQLite) | `proposal-dedupe.ts` | `nvidia/nemotron-3-embed-1b` | 2048 | 112 |
| `vector_memories` (SQLite) | `vector-memory-service.ts` | configured provider (`ollama:<model>`) | provider-dependent | 0 |
| `experience_embeddings` (SQLite) + Qdrant | `experience-retrieval-service.ts` | `nomic-embed-text` | 768 | 19 (SQLite) |
| Qdrant `djimitflo_swarm` (memory flywheel) | `memory-candidate-service.ts` | `nomic-embed-text:latest` until 2026-10-27, now the shared contract | 768 → contract | _operator: count via Qdrant_ |
| Qdrant task memory (`memory-sync`) | `memory-sync-service.ts` | `snowflake-arctic-embed:s` (`DJIMITFLO_EMBED_MODEL`) | 384 | _operator_ |
| Qdrant reasoning bank | `reasoning-bank-service.ts` | `snowflake-arctic-embed:s` | 384 | _operator_ |
| Qdrant explainer knowledge | `explainer-knowledge-service.ts` | `snowflake-arctic-embed:s` | 384 | _operator_ |
| Qdrant OKF (read) | `context-injection-service.ts` | `nomic-embed-text:latest`, as written by the indexer | 768 | _operator_ |
| Qdrant `djimitflo_swarm` (read) | `context-injection-service.ts` | `nomic-embed-text:latest` until 2026-10-27, now the shared contract | contract | — |

## Migration plan (to one model) — operator decision, not started

1. **Pick one model.** Candidates: `nemotron-3-embed-1b` (2048d, NVIDIA free tier: 429s under bursts, see #482/#628) or
   one local Ollama model (no rate limit, runs on the workstation). Retrieval quality must be measured first (UX-24
   recall@k harness) on our own queries, not on vendor benchmarks.
2. **Re-embed cost** = rows × (1 call each). SQLite part: ~1 444 rows today. Qdrant collections: counts above. At the
   NVIDIA free-tier pace (~200/min sustained) the SQLite part takes ~8 min; Qdrant depends on the counts.
3. **Order:** write new vectors to a *new* column / collection next to the old (dual-write), backfill in batches,
   switch readers per store, keep the old vectors until the new store has served a week without a mismatch counter
   increase. Then `VECTOR_STRICT_DIM=true`.
4. **Rollback:** readers switch back to the old column / collection (nothing was deleted); the counter shows whether
   anything still compares across spaces.

## No automatic collection repair (CODE-001/002, 2026-10-27)

The task paths (`memory-sync`, `reasoning-bank`, the memory flywheel) and the swarm-memory reader share one contract,
`packages/server/src/services/memory-embedding-contract.ts`: one model (`DJIMITFLO_EMBED_MODEL` →
`OLLAMA_EMBED_MODEL` → `snowflake-arctic-embed:s`, resolved per call) and the collection's configured vector size as the
dimension. They never DELETE or recreate a collection. Before this change (since #249, and the flywheel since it was added) they did so when the dimension differed and
`points_count` read 0 — but a count read is no lock: it can be stale, missing (treated as 0) or raced by a concurrent
writer, so that "repair" could wipe live memory. Now:

- 404 (no collection): the writer creates it at the embedding's dimension.
- Dimension mismatch or unknown vector size: the write is skipped and logged as `unavailable, <reason>`; the reader
  returns no swarm memory and reports `unavailable` on the context snapshot, which marks the task's
  `context_snapshot.degraded` with the reason (distinct from "no matching memory").
- The reader only matches points whose payload `embedding_model` equals the contract model, so an equal-dimension
  model switch cannot return vectors from another space. Points written before UX-21 (no `embedding_model`) are not
  returned.

**Operator-only repair** (not built; deliberately manual): to move a collection to another model or dimension, follow
the migration plan above — snapshot the collection (`POST /collections/<name>/snapshots`), create a *new* collection at
the new dimension, backfill, point readers and writers at it (or swap a Qdrant alias), and keep the old collection
until rollback is no longer needed. Never delete in place.
