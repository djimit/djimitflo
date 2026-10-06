# Retrieval evaluation (UX-24)

Djimitflo injects retrieved context into panels, makers and the council from several sources: Qdrant swarm memory, OKF
search and related concepts, DjimitKB search, experience retrieval and the KB corpus (`kbContext`). Until now nothing
measured whether those retrievals return the right items. This harness does, offline and deterministically.

## What it measures

`services/retrieval-eval.ts` → `evaluateRetrieval(queries, retrieve)` returns per source:
`n` (labelled queries), `recall@1/3/5/10` (share of a query's relevant ids in the top k, averaged) and `MRR` (mean of
1/rank of the first relevant id; 0 when none is returned). `cosineRetriever(corpus)` is the in-memory top-k used for the
fixture and for offline runs on exported embeddings.

The synthetic fixture lives in `packages/server/corpus/retrieval/fixture.json` (3-d embeddings, no production content)
and runs in CI through `src/__tests__/retrieval-eval.test.ts`.

## Finding: how injected context is ranked today

`rankContextResults` (used by `ContextInjectionService`) sorts by trust tier first (approved → validated →
agent_generated), then by the raw `score`:

1. **Scores are compared raw across sources.** Qdrant cosine (0–1), OKF/KB search scores (other scales) and experience
   retrieval are mixed in one comparison, so within a tier the source with the larger score scale wins regardless of
   relevance (fixture: a weak OKF hit at 3.1 outranks the best cosine hit at 0.92).
2. **Trust tier outranks relevance entirely.** An approved item with score 0.05 is placed above an agent-generated item
   with score 0.95.

`RETRIEVAL_NORMALISE_SCORES=true` (default off) min-max normalises the score within each source before the within-tier
comparison, which removes (1). It does not change (2); whether trust should be a tie-breaker or a weight is a design
decision for the operator, to be made with recall/MRR numbers from a real labelled set.

## Labelling a real set

1. Pick 30–50 real queries per source from recent panel/maker context requests (titles of proposals are a good start).
2. For each query, list the ids that a reviewer would want to see (KB page ids, OKF concept ids, experience ids).
3. Store them as `{ id, source, relevant: [...] }` plus either the query embedding or the query text.
4. Do not commit production content to this public repo: keep the labelled set outside git, or commit ids only.

## Running against prod (read-only)

Export embeddings and the labelled set read-only from the prod database (open it with `{ readonly: true }` inside the
container), then run `evaluateRetrieval` with `cosineRetriever` over the exported corpus, or with a retriever that calls
the real search function. Report recall@k and MRR with n per source; compare with `RETRIEVAL_NORMALISE_SCORES` on and off
before proposing to enable it.
