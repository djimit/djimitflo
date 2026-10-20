# E1: reciprocal rank fusion vs raw and min-max cross-source scores (pre-registration)

Operator-approved 2026-10-20. Offline only, in-house code only (no RuVector code). Registered before any scoring; this
file is committed on `exp/e1-rrf` before the harness arm or the scoring script exists. Amendments go below, never edits.

## Question

UX-24 (`docs/design/retrieval-eval.md`, `rankContextResults` in `context-injection-service.ts`) found that injected
context is ranked by trust tier first, then by the **raw** score compared across sources whose scales differ (Qdrant
cosine 0–1, OKF/KB search scores, experience similarity). `RETRIEVAL_NORMALISE_SCORES=true` (default off) min-max
normalises within each source. E1 asks: does reciprocal rank fusion (RRF) rank relevant items higher than raw scores and
per-source min-max?

## Arms (trust-tier handling identical in all three)

All arms sort by trust tier first (`approved` → `validated` → `agent_generated` → other), exactly as `rankContextResults`
does today. Only the within-tier key differs.

| arm | within-tier key | implementation |
|---|---|---|
| `raw` | the item's raw `score` | `rankContextResults(candidates, {})` (today's prod order) |
| `minmax` | per-source min-max of `score` | `rankContextResults(candidates, { RETRIEVAL_NORMALISE_SCORES: 'true' })` |
| `rrf` | Σ over sources 1 / (k + rank of the item in that source's own score order), **k = 60** | new pure harness function in `services/retrieval-eval.ts` |

RRF ranks inside a source are 1-based, by descending raw score, ties by id. An item listed by several sources sums its
contributions. Ties in the final key keep input order (stable sort), in every arm.

## Labelled set (single label source, no LLM labels)

A labelled query is `{ id, relevant: [ids], candidates: [{ id, source, score, trust_level }] }`: one real information
need, the candidate list the sources returned for it (≥ 2 sources), and the ids a human operator marked relevant. Only one
label source may be used per run. LLM / jev labels are never eligible (NE-001). Synthetic labels are never added to reach n.

Inventory at registration (repo and fixtures; prod not accessed):

1. **UX-24 fixture** `packages/server/corpus/retrieval/fixture.json`: 5 queries, author-written synthetic 3-d embeddings,
   each restricted to one source. Not human operator labels and not cross-source, so it cannot test fusion. Eligible as a
   unit-test fixture only; **0 eligible queries**.
2. **#835 blind discovery-relevance labels** (`judgments`, `judgment = 'operator_label'`, `state_hash =
   'discovery_relevance'`): human, blind, but per-document yes / no / unclear against one fixed scope ("relevant to
   Djimitflo"), with no query text and no per-source candidate scores. They cannot form ranked queries. **Ineligible** for
   E1 regardless of their count. They live only in the prod DB; DI-001 PREREG amendment 2 (2026-10-14) recorded 0 rows then.
3. **Human query → relevant-id retrieval labels** (the procedure in `retrieval-eval.md` "Labelling a real set"): none exist
   in the repo. Whether any exist in prod is checked with the read-only query in `E1-RRF_RESULT.md`.

## Metrics and decision rule

- Per query and arm: **MRR** (1 / rank of the first relevant id, 0 if none) and **recall@5** (share of relevant ids in the
  top 5), on the arm's ranking of that query's candidates.
- **Primary:** mean over queries of MRR(rrf) − MRR(raw), with a **paired bootstrap 95 % CI over queries** (10 000
  resamples, percentile interval, seed 20261020).
- Secondary (descriptive, no verdict): MRR(rrf) − MRR(minmax), and recall@5 for every pair.
- **INSUFFICIENT** if fewer than **30** eligible labelled queries: report n and stop; no metric is reported as evidence.
- **FALSIFIED** if the primary CI contains 0. **SUPPORTED** if the CI lies entirely above 0. A CI entirely below 0 is
  recorded as FALSIFIED with the direction stated (RRF worse).

## Scope guards

- No prod behaviour change: `rankContextResults` and the `RETRIEVAL_NORMALISE_SCORES` prod read are not edited; the RRF arm
  exists only in the harness. Default unchanged.
- ACE-001 arms and every prod retrieval path are not touched. No network calls; the prod DB is never opened from this branch.
- Scoring script: `scripts/e1-rrf-score.mjs <export.json>` (exported labelled set, read-only export done by the operator).

## Registration

Registered in commit `dcad1ed9e47edb6016ae4ece353dab32347db1fe` (this file only), before the RRF arm, the scoring
function or the scoring script existed. Nothing above this section has changed since.
