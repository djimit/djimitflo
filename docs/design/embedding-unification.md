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
| Qdrant `memory candidates` collection | `memory-candidate-service.ts` | `nomic-embed-text:latest` | 768 | _operator: count via Qdrant_ |
| Qdrant task memory (`memory-sync`) | `memory-sync-service.ts` | `snowflake-arctic-embed:s` (`DJIMITFLO_EMBED_MODEL`) | 384 | _operator_ |
| Qdrant reasoning bank | `reasoning-bank-service.ts` | `snowflake-arctic-embed:s` | 384 | _operator_ |
| Qdrant explainer knowledge | `explainer-knowledge-service.ts` | `snowflake-arctic-embed:s` | 384 | _operator_ |
| Qdrant OKF / context injection (read) | `context-injection-service.ts` | as written by the indexer | — | _operator_ |

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
