# DI-001 P3 — discovery relevance benchmark: result

Protocol: `PREREG.md` (sha256 `2de706a2…c5b739`, amendments 1 and 2 included; first frozen version commit `31d219e2`; the results below were computed under amendment 1, `893eb43c…35ac1a`. Amendment 2 changes only how future L2 rows are read, and a re-run gives identical numbers because 0 L2 rows exist).
Every number comes from `results.json`, written by `scripts/di-001/relevance-bench.cjs` (read-only, run inside
`djimitflo-live`, snapshot `2026-10-13T22:50:26Z` container clock). No jev, LLM or embedding call was made.

**Result: INSUFFICIENT for every comparison.** There are 7 independently labelled discoveries in the primary population
(8 over all sources). The pre-registered minimum is 50, with ≥ 10 positives and ≥ 10 negatives. The labelling plan in
§6 fixes this in about 19 operator days at 30 min/day.

## 1. Population and the three separate states

The population is 7 325 distinct discovery refs. 6 245 of them come from the in-scope sources (`djimitflo-scout` 5 227,
`operator-chatgpt` 1 018); out of scope are hermes-macmini 643, djimit-kbwiki 390 and hermes-eve-v 47.

| state (PREREG §2a) | primary population (n = 6 245) |
|---|---|
| classification A (taxonomy + scope) | admit 1 471 · reject 1 855 · **no record 2 919** (would need the deterministic `capabilitiesFor` to be recomputed) |
| classification C (jev, first non-error verdict) | yes 239 · no 278 · uncertain 2 798 · **unjudged 2 930** (no verdict, or errors only) |
| classification B (stored vectors) | **not computable for all 6 245**: no table stores a vector for a discovery |
| admission | 929 units · 5 316 without a unit |
| verification (independent) | 6 positive · 1 negative · 6 238 unlabelled |

Admission is not relevance, and a classification is neither admission nor verification. Every per-ref record in
`results.json` keeps the three states in separate fields.

## 2. Independent label inventory

| label source (PREREG §2) | rows | discoveries it labels |
|---|---|---|
| L1 human lifecycle action (`admin@djimit.nl`) on a paper/repository unit | 11 events on 9 units | 7 primary (6 `CHECKED`, 1 `REJECTED`). Outside primary: 1 (`github:usestrix/strix`, see Deviation 3). Not a discovery: 1 (`stored-evidence` REJECTED, no discovery event). |
| L2 explicit operator relevance label | **0** | 0 |
| L3 cited by a verified change | 73 verified `self_improvements` scanned, plus their goals and runs | **0**. The only text hit is `github:djimit/djimitflo`, Djimitflo's own repo (excluded, Deviation 2). |
| Not used as labels | 242 jev `yes`, 8 `model-review:*` CHECKED on persons, 4 355 automated `CAPABILITY_INFERRED` | — |

The labels came in 5 sessions (09-28: 1, 09-30: 2, 10-04: 1, 10-06: 2, 10-13: 1). That gives 5 bootstrap clusters.

**Representativeness: the labelled set is not representative.**

| dimension | labelled (n = 7) | primary population |
|---|---|---|
| A decision | 7 admit (100 %) | admit 24 % · reject 30 % · no record 47 % |
| admission | 7 units (100 %) | 15 % units |
| jev decision | uncertain 5 · yes 1 · no 1 | unjudged 47 % · uncertain 45 % · no 4 % · yes 4 % |
| source | scout 5 · chatgpt 2 | scout 84 % · chatgpt 16 % |
| kind | paper 4 · repository 3 | paper 85 % · repository 15 % |

All the labels sit inside A's admitted set, because a human can only check a unit that already exists. So A's recall
cannot be estimated at all, and C's and D's recall only inside A-admit. The construct caveat also applies: `CHECKED`
attests that a capability claim was checked, which is weaker than "relevant to an open problem".

## 3. Per-candidate results (primary labelled set, n = 7; descriptive only)

Loss is `3·FA + 1·FR` per covered ref (DI-001 low-risk weights). Precision and recall use Wilson 95 % CIs. Loss CIs
come from a session bootstrap (B = 2000, seed 20261014).

| candidate | TP / FP / FN / TN / abstain | precision | recall (inside A-admit) | loss (default) [95 % CI] | grid (12 cells) min–max | Brier | downstream verified yield |
|---|---|---|---|---|---|---|---|
| **A** taxonomy + scope | 6 / 1 / 0 / 0 / 0 | 0.86 [0.49, 0.97] | 1.00 [0.61, 1.00] (selection-forced) | 0.43 [0, 1.50] | 0.14–1.43 | — | 0 / 7 [0, 0.35] |
| **B** stored embeddings | NOT COMPUTABLE (no stored discovery vector) | — | — | — | — | — | — |
| **C** selective jev | 1 / 0 / 1 / 0 / 5 | 1.00 [0.21, 1.00] | 0.50 [0.09, 0.91] | 0.50 [0, 1.00] (coverage 2/7) | 0.25–2.50 | 0.348 [0.247, 0.459]* | 0 / 1 [0, 0.79] |
| **C\*** jev, uncertain → reject | 1 / 0 / 5 / 1 / 0 | 1.00 [0.21, 1.00] | 0.17 [0.03, 0.56] | 0.71 [0.33, 1.00] | 0.36–3.57 | 0.348 [0.247, 0.459]* | 0 / 1 [0, 0.79] |
| **D** A, then jev veto | 5 / 1 / 1 / 0 / 0 | 0.83 [0.44, 0.97] | 0.83 [0.44, 0.97] | 0.57 [0, 1.67] | 0.21–2.14 | — | 0 / 6 [0, 0.39] |

\* Brier over the 7 refs with a jev p (item bootstrap). ECE is not computed because n < 50 (PREREG §4).

| comparison (PREREG §5) | disagreements | verdict | why |
|---|---|---|---|
| A vs C | 1 | INSUFFICIENT | n 7 < 50; positives 6 < 10; negatives 1 < 10; 0 sources with ≥ 10 |
| A vs C\* | 6 | INSUFFICIENT | same; disagreements 6 < 10 |
| A vs D | 1 | INSUFFICIENT | same |
| C\* vs D | 5 | INSUFFICIENT | same |
| A vs B, B vs C\* | 0 | INSUFFICIENT | B NOT COMPUTABLE |

The table should not be read for direction. With 1 negative, every FA count is 0 or 1. A looks best only because the
label set is conditioned on A admitting. The one pattern visible is that jev marks 5 of the 6 human-checked units
`uncertain` and 1 of them `no`. That is consistent with #825, where 84 % of verdicts were uncertain, but it is not
evidence at this n.

**Operational cost and latency** (these need no labels):

| | A | B | C (jev) | D |
|---|---|---|---|---|
| inference per discovery | 0 (in-process keyword/category match over `expert_capability_taxonomy`) | 1 embedding call (not made; no stored vector) | 854 tokens per successful call | 0 for the gate, plus jev for A-admits (about 24 % of refs) |
| latency | not measured separately (synchronous, in the ingest transaction) | — | p50 3.6 s, p95 233 s (n = 3 451) | as C on A-admits |
| failure rate | — | — | 294 / 3 745 = 7.9 % [7.0, 8.8] (queue-full, timeouts) | as C |
| tokens per labelled TP | 0 | — | 2.95 M tokens / 1 TP | — |

## 4. Verdicts

| candidate | verdict | basis |
|---|---|---|
| **A** deterministic taxonomy + source filter | **HOLD** | INSUFFICIENT. Stays the live cheap gate (no inference, reversible). Its recall is unknown, and the protected sample measures it for the first time (it contains A-rejects). |
| **B** embedding relevance | **HOLD** (not computable) | No stored discovery vectors. Computing B needs one embedding call per ref, which is outside this study. The next step is an offline embedding of the 340 protected refs plus an AL pool, which is a cost decision for the operator. |
| **C** selective jev | **HOLD** (stays paused under #825) | INSUFFICIENT. The #825 reactivation rule is unmet: no incremental value over A/D has been shown, and the consumers have barely acted (1 of 242 `yes` units reached `CHECKED`; 0 downstream verified use). |
| **D** hybrid cascade | **HOLD** (not built) | INSUFFICIENT. It needs jev on A-admits, so it inherits C's pause. |

None of the candidates earns GO or REJECT under PREREG §5.

## 5. Why INSUFFICIENT is the expected answer

Of the 242 `yes` units, 1 was ever checked by a human. 0 discovery units are cited by any verified change. The
`CHECKED` actions happened as the operator browsed `/frontier-experts`, not as sampling. Labels therefore exist only
where A admitted and a human happened to look. More passive data will not fix this, so the labels have to be
collected on purpose.

## 6. Bounded human-labelling plan (design; nothing built)

### 6.1 Protected evaluation sample, frozen

The sample is `eval-sample.json` (sha256 `4830232560726ecf…dc7ca09d`, commit `f153ca36`). It was frozen before any
label on it and before any optimisation.

- **N = 340 refs**, stratified by source × ISO week: scout W39 3, W40 147, W41 132, W42 3; chatgpt W39 55.
- The size comes from the pre-registered McNemar rule. The label-free A-vs-C\* disagreement is ψ = 0.434 (n = 3 315
  refs where both decided). With δ = 0.10, α = 0.05 and power 0.80, the formula gives n = 338, rounded to 340.
- Stated limitation: jev covers only about 53 % of refs (the rest are unjudged, and re-judging is paused). Paired
  comparisons that involve C therefore have about 180 usable items, and the MDE for them is **δ ≈ 0.14**, not 0.10.
  Comparisons among A, D and B (once B is computable) keep δ = 0.10. A's 47 % "no record" is closed before labelling
  by recomputing the deterministic taxonomy match (label-free, no inference).
- The sample is used for evaluation only: never for training, B's threshold or source calibration.

### 6.2 Active-learning pool (outside the protected sample)

150 labels, used only to tune B's threshold and per-source calibration, never in an evaluation number:

| cell (outside protected) | pool | labels | why |
|---|---|---|---|
| A reject ∧ jev yes | 100 | 40 | the gate misses that jev claims |
| A admit ∧ jev no | 100 | 40 | jev vetoes (D's only lever) |
| A admit ∧ jev uncertain | 1 164 | 25 | the bulk of FE2 traffic |
| A reject ∧ jev uncertain | 1 474 | 15 | the rejected-shadow bulk |
| uniform random over the rest | — | 30 (20 %) | keeps the pool from being purely adversarial |

### 6.3 Labelling protocol (PREREG §6b)

- The annotator sees a blind card: title, note/abstract, source and URL. It never shows jev, A, admission state or any
  earlier label. Order is shuffled.
- Each card gets one answer: `relevant` / `not relevant` / `unclear`. `unclear` is recorded but is not a negative.
- 20 % overlap: 68 of the protected refs are re-labelled.
  - One operator: a delayed blind re-label, ≥ 7 days after the first label. This is reported only as
    **intra-annotator consistency** (κ with a bootstrap CI). It shows whether the operator's own labels are stable. It
    does not show that another person would agree, and it does not catch a bias the operator holds consistently.
  - A second human, if available: they label the same 68, and that number is reported separately as
    **inter-annotator agreement**.
  - If the lower bound of κ is below 0.4, no GO verdict may rest on the labels.
- Disagreements: a third reviewer decides; if there is none, the operator decides with both labels visible. Both
  original labels are kept, the item is flagged, and nothing is discarded.

### 6.4 Time budget

Assumption: about 1 min per label. It is not measured yet. The first session measures it from label timestamps, and
the plan is re-cut if the real figure differs by more than 50 %.

| phase | labels | days at 30/day |
|---|---|---|
| protected evaluation | 340 | 12 |
| overlap re-label (from day 8, ≥ 7 days after the first label) | 68 | 2–3 |
| active-learning pool | 150 | 5 |
| **total** | **558** | **≈ 19 operator days**, never more than 30 min/day |

After the protected set is complete, the benchmark is re-run with this same script and the same PREREG.

### 6.5 Label UI: the existing `/decisions` pattern (design only)

- Add a "Discovery relevance" section to `DecisionsInboxPage`, next to D5 (pre-screen labelling). Each row shows one
  card from today's quota: protected refs first, then AL refs. It has three buttons.
- `POST /self-improve/discovery-label/:ref` writes one `judgments` row:
  - `judgment = 'operator_label'`, `subject_type = 'discovery'`, `subject_id = <ref>`;
  - `state_hash = 'discovery_relevance'`, `mode = 'enforce'`;
  - `decision` = yes / no / unclear;
  - `reason` = `{sample: protected|al, pass: 1|2, actor}`.
- This is the same shape as `labelPrescreen` in `decisions-inbox.ts`. The benchmark already reads it as L2.
- The inbox never shows jev or A on the card. `openDecisionCounts` counts the day's remaining quota, not the whole
  backlog.

## Deviations from PREREG

1. **Multi-sender refs.** PREREG did not say what happens when several sources send the same ref. The script puts a ref
   in scope if any sender is in scope, and takes its source from the first in-scope sender. In practice
   `external_events` dedupes on the ref (`dedupe_key = discovery:<ref>`), so every ref has exactly one stored event and
   this changes nothing.
2. **Own repository excluded from L3.** `github:djimit/djimitflo` (a kbwiki "discovery") matches every change that
   mentions the repo. Citing it is not use of a discovery, so it is excluded. It is outside primary anyway.
3. **`github:usestrix/strix`.** Its only stored event is from hermes-macmini (out of scope), while its unit provenance
   says operator-chatgpt (the chatgpt event was deduped). By the rule it is outside primary, and it is reported under
   "all sources" (8 labels). Including it changes no verdict.
