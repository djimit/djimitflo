# E1 result: RRF vs raw vs min-max

**Verdict: INSUFFICIENT** (0 eligible labelled queries; the protocol needs ≥ 30). No metric is reported as evidence.
**Pending prod labels**: whether human query-level retrieval labels exist in prod is unknown from the repo; the read-only
check is below. Protocol: `E1-RRF_PROTOCOL.md`, registered at `dcad1ed9e47edb6016ae4ece353dab32347db1fe`.

## Label inventory

| source | rows | human | query-level with cross-source candidates | eligible |
|---|---|---|---|---|
| UX-24 fixture `corpus/retrieval/fixture.json` | 5 queries | no (author-written synthetic) | no (each query is single-source) | 0 |
| #835 blind discovery-relevance labels (`judgments`, `operator_label` / `discovery_relevance`) | prod only, not read (0 at DI-001 PREREG amendment 2, 2026-10-14) | yes | no (yes/no per paper against one fixed scope; no query, no candidate scores) | 0, at any count |
| human query → relevant-id retrieval labels (`retrieval-eval.md` "Labelling a real set") | none in the repo | — | — | 0 |

Offline run (`node scripts/e1-rrf-score.mjs` on the fixture, exported with per-source cosine scores): `n_input 5,
n_eligible 0, n_excluded 5, verdict INSUFFICIENT`, all metrics `null`. Per the protocol the run stops here; no synthetic
labels were added.

## What is ready

- `services/retrieval-eval.ts`: `reciprocalRankFusion` (k = 60), `rankE1Arm` (`raw` / `minmax` reuse the unchanged prod
  `rankContextResults`; `rrf` is harness-only; trust tier first in every arm), `pairedBootstrapCI` (10 000 resamples, seed
  20261020), `scoreE1` (eligibility, < 30 → INSUFFICIENT with nulls). Tests: `__tests__/retrieval-e1-rrf.test.ts`.
- `scripts/e1-rrf-score.mjs <export.json>`: offline, one label source per run, refuses jev / LLM / synthetic sources.
- Prod behaviour is unchanged: `rankContextResults` and the `RETRIEVAL_NORMALISE_SCORES` read are not edited (a test pins
  that `RETRIEVAL_NORMALISE_SCORES=rrf` still gives today's raw order).

## Read-only prod check (for the operator; do not run branch code in the prod container)

Inside the prod container, with the DB opened `{ readonly: true }`:

```sql
-- 1. every human label family, by kind (confirms the #835 count and shows whether any retrieval labels exist)
SELECT judgment, mode, state_hash, subject_type, decision, COUNT(*) AS n
FROM judgments WHERE mode IN ('operator_label', 'annotation')
GROUP BY judgment, mode, state_hash, subject_type, decision ORDER BY n DESC;
-- 2. any query-level retrieval label (expected 0)
SELECT COUNT(*) FROM judgments WHERE state_hash LIKE '%retrieval%' OR subject_type LIKE '%retrieval%';
```

If (2) is 0, E1 stays INSUFFICIENT until ≥ 30 queries are labelled by one human source: real context requests, the
candidate list each source returned (`id`, `source`, raw `score`, `trust_level`), and the relevant ids. Export them as
`{ "label_source": "<who>", "queries": [...] }` (ids only, no production text, kept outside git) and run
`npm run build:server && node scripts/e1-rrf-score.mjs <export.json>`; the verdict is the script's `verdict`, unedited.
