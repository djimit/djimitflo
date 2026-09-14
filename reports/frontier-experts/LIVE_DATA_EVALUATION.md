# Live-data evaluation (§43 on real identities, §45, G-03/G-04)

Database: the Pacing-the-Frontier seed (1 094 DISCOVERED identities, INGESTION_REPORT.md) enriched on 2026-09-14 with the DataCite DOI API (`knowledge-adapters/datacite-adapter.ts`, arXiv-native records) after arXiv (429 after every single request) and OpenAlex (100 requests/day anonymous, `retry-after` 23 h) proved unusable at seed scale; 76 identities were enriched through OpenAlex before its quota closed. Runner: `src/scripts/enrich-experts.ts --source datacite --batch 25 --spacing-ms 1000` — 44 batches, 0 throttles, 24 minutes. Evaluation: `src/scripts/expert-live-evaluation.ts --db <seed.db> --sample 30 --seed 7`.

Nobody has been CHECKED, APPROVED or ACTIVE by a human yet, so the resolver was asked for `CAPABILITY_INFERRED+` states explicitly. **Every number below is tentative by construction** (§36): it measures the ingestion → resolution pipeline, not verified expertise.

## Outcome of the seed run

| state after enrichment | before recompute | after recompute (namesake filter + title-only single words) |
|---|---|---|
| DISCOVERED (no author match in DataCite) | 363 | 363 |
| AMBIGUOUS (identity below 0.8, nothing attached, I03) | 350 | 350 |
| EVIDENCE_COLLECTED (papers, no capability phrase) | 30 | 30 |
| CAPABILITY_INFERRED | 351 | 297 |
| INSUFFICIENT_EVIDENCE (all inferred capabilities fell away) | — | 54 |
| paper evidence rows (Tier 1) | 2 114 | 2 114 (264 challenged as non-AI namesake papers) |
| active capabilities | 1 802 | 890 (912 over-broad inferences revoked, 3 added) |

The recompute is offline (`--recompute`), idempotent (second pass: 0 changes) and only touches `inferred` capabilities; checked/approved ones would be reported, never revoked automatically (§54).

## Resolution on the 30 benchmark queries (K = 3)

| metric | broad inference (before) | after recompute |
|---|---|---|
| in-domain queries | 27 | 27 |
| abstained (in-domain) | 3 | 3 |
| precision@3 (selected expert holds an expected capability family) | 0.986 | 0.944 |
| recall@3 (expected families covered) | 0.944 | 0.903 |
| candidates considered per query (mean) | 152.4 | 93.1 |
| primary evidence ratio | 1.000 | 1.000 |
| mean identity confidence of selected | 0.909 | 0.934 |
| out-of-domain abstention | 3/3 | 3/3 |

Reading: the "before" precision was inflated by over-broad capability inference (a person with eight capabilities matches almost any family). After the recompute the resolver still covers 24 of 27 in-domain queries with evidence-backed people whose capabilities come from paper titles and category codes. The three abstentions are honest: no signatory has DataCite evidence matching `automated_ai_research` or `recursive_self_improvement` phrases (the taxonomy aliases for those families are the next data fix). Off-target picks remain for `cyber_capabilities` (few signatories publish on it) — the resolver reports them as off-target rather than inventing a fit.

## Identity-resolution sample (G-04)

30 deterministic-random enriched identities were reviewed against their self-stated Pacing title and their newest active paper (full table in the scratch evaluation output, reproducible with `--seed 7`). Reviewer: this session, heuristic reading of titles, not a ground-truth label.

- Plausibly the same person with on-topic evidence: 24 (e.g. system cards, alignment, interpretability and RL papers matching the stated lab).
- Namesake or mixed identities still present after the filter: 3 (a weather-forecasting VARIMA paper, an automotive-crash ML paper, an algebraic-geometry paper under names that self-state Google/Anthropic roles). Two of them carry zero or one capability, so they cannot be recommended for anything specific; none is ACTIVE.
- Uncertain: 3 (plausible field, could not be confirmed from titles alone).
- Before the filter the same sample contained 7 clear namesake papers (tear osmolarity, spacecraft re-entry, a tokamak simulator, a MONAI release, …); the AI-only rule removed 264 such papers overall.

Estimated identity-resolution error after the filter: **~10 % of enriched identities (3/30), upper bound ~20 % including uncertain cases.** This is why CAPABILITY_INFERRED is never recommended by default and why CHECKED/APPROVED need two different humans (I06). A stricter rule (require ≥ 2 AI papers or an affiliation match against the self-stated organisation) would cut the error further at the cost of recall; it is the next §54 iteration, listed in GAP_REGISTER.md.

## Capability status

- Ingestion → enrichment → resolution on real data: **PROVEN** (1 094 identities, 2 114 Tier-1 evidence rows, 890 evidence-backed capabilities, resolver answers 24/27 in-domain queries with WHY_SELECTED, abstains out of domain).
- Identity resolution accuracy: **PARTIALLY_PROVEN** (measured on a 30-sample by heuristic review; no human labels yet).
- Verified expertise: **NOT_PROVEN by design** — zero ACTIVE experts until humans check and approve.
