# DI-001 P3 pre-registration — discovery relevance benchmark (A / B / C / D)

Status: **frozen**. This file is committed on its own, before any benchmark result in this directory exists. Its sha256 is
recorded in the next commit (`PREREG.sha256`). Any later change is a protocol deviation and must be listed in
`BENCHMARK.md §Deviations` with a reason; it never silently re-defines a result.

Operator directive: DI-001 P3 (2026-10-14). Read-only on prod. No flags, no restarts, no writes, no jev / LLM calls, no
embedding API calls. Builds on `DISCOVERY_RELEVANCE_AUDIT.md` (PR #825, the pause and the `unjudged` marker) and the
DI-001 scoring method (PR #827: PREREG/LABELS/LOSS).

Amendment 1 (operator correction, made before any result or sample existed; both versions are in the branch history):
§6b names single-operator re-label agreement *intra-annotator consistency*, never inter-annotator agreement; §6a freezes
the protected sample before any optimisation. `PREREG.sha256` is the hash of this amended file; the first frozen
version is commit `31d219e2`.

## 0. What was already seen (not a blind protocol)

Before this file was written, three read-only inventory probes were run on prod (snapshot `2026-10-13T22:44Z`, container
clock). They showed, without any candidate-vs-label cross-tab being computed:

- 7 325 distinct discovery refs in `external_events` (`discovery.paper` / `discovery.repository`), 5 sources.
- 3 451 non-error `discovery_relevance` verdicts (242 yes / 322 no / 2 887 uncertain), 294 errors.
- Human lifecycle actions on paper/repository units: 11 events by `admin@djimit.nl` on 9 units (7 now `CHECKED`, 2
  `REJECTED`); one of the 9 is a `stored-evidence` unit (not a discovery). The list of these 9 units and their stored jev
  rows was printed (so the labels and the jev values of these 9 were seen).
- 0 of 1 336 `self_improvements`, 0 goals and 0 loop runs cite any discovery ref, unit id or claim id.
- Stored vectors exist only for `kb_pages` (1 313, KB wiki pages), `proposal_embeddings` (189 proposals) and
  `experience_embeddings` (22). No table stores a vector for a discovery.
- No `external_events` payload carries the #825 `relevance: 'unjudged'` marker (the pause is not merged/active).

Consequence: this study cannot discover anything about these 9 labels; it can only state, under fixed rules, whether the
evidence is sufficient. Every rule and threshold below is fixed by reference to #825/#827, not tuned on what was seen.

## 1. Unit and population

- Unit: one distinct discovery ref (`json_extract(payload,'$.ref')` of a `discovery.*` event, e.g. `arxiv:2610.06401`,
  `github:owner/repo`). Its source = payload `agent`, else event `source`; first `occurred_at` = its time.
- Primary population: refs from the in-scope sources (`DISCOVERY_RELEVANCE_SOURCES` on prod =
  `djimitflo-scout,operator-chatgpt`). Secondary: all sources (hermes-macmini, hermes-eve-v, djimit-kbwiki included).
- Snapshot: wall-clock UTC at the scoring run, recorded in `results.json`. Only rows with `created_at <= snapshot_at` count.
- A discovery's unit = the `expert_identities` row (kind paper/repository) whose `aliases_json` contains the ref.

## 2. Ground truth: independent labels only

| id | label source | positive | negative | rule |
|---|---|---|---|---|
| L1 | operator lifecycle action on the discovery's unit (`expert_lifecycle_events`, human actor = an account id, i.e. not `ingestion:*`, `model-review:*`, `codex:*`, `system*`, `loop:*`, any agent id) | latest human transition to `CHECKED`, `APPROVED`, `ACTIVE` | latest human transition to `REJECTED`, `REVOKED` | latest human event wins; a human transition back to an automated state (un-check) without a later human state = unlabelled |
| L2 | explicit operator relevance label (`judgments`, `mode IN ('operator_label','annotation')` on the ref or its unit, about `discovery_relevance`) | `yes` / relevant | `no` / not relevant | 0 exist today; this is what the label UI (BENCHMARK §6) writes |
| L3 | downstream use in a verified run: the ref, unit id or one of its `expert_claims` ids is cited by a `self_improvements` row with `status = 'verified'` (title, description, rationale, evidence refs, grounding), or by its goal / loop run | cited by a verified change | **never** | absence of a citation is missing evidence, not a negative |

Precedence: L2 over L1 (L2 asks the relevance question directly). L3 only adds positives. A conflict (one source positive,
another negative) excludes the ref from the primary set and lists it.

**Not labels** (never used as ground truth): any jev verdict in any mode (it is candidate C); `model-review:*` / LLM
lifecycle actors; automated lifecycle states (`CAPABILITY_INFERRED` etc.); the taxonomy match (candidate A); committee /
scout-persona / dream-evolution reads of a `yes`; knowledge-overview display; `expert_claims.support_status` (machine).

Construct caveat (stated with every table): `CHECKED` attests that a human checked the unit's capability claim, which
implies "worth attention" but is a weaker statement than "relevant to an open Djimitflo problem". It is used as a
relevance-positive proxy because it is the only human action that exists.

Selection caveat: an L1 label can only exist on a discovery that became a unit, i.e. one that candidate A (and, after
FE2 on 2026-09-29, also jev) already admitted. Recall of A cannot be estimated from L1 at all; recall of C, D only inside
A's admitted set.

Missing evidence is never a negative label: unlabelled refs, paused (`unjudged`) refs, errored jev rows and refs without
a unit are UNLABELLED.

### 2a. Three states per discovery, never collapsed (operator addendum)

Every ref carries three separate fields in `results.json`, each with its own provenance; no metric may derive one from
another:

| state | values | source |
|---|---|---|
| **classification** (per candidate) | A/B/C/D each: admit / reject / abstain / not_computable, plus C's raw class, confidence, p | the candidate rules in §3 |
| **admission** | unit / no_unit (+ `derived`: fleet-discovery, taxonomy_override:jev) | `expert_identities` row exists for the ref |
| **verification** | positive / negative / unlabelled / conflict, with label source (L1/L2/L3) | §2 only |

"Admitted" never means "relevant", and "classified relevant" never means "admitted" or "verified".

## 3. Candidates

| id | decision rule | probability |
|---|---|---|
| **A** deterministic taxonomy + source filter | admit iff source ∈ scope **and** the taxonomy gate matched: recorded as a unit with ≥ 1 `source-units:*` capability, or a `discovery_pending` jev row (accepted by the gate); a `discovery_rejected` row = gate rejected; a unit with 0 capabilities (`taxonomy_override:jev`) = gate rejected. No record → ABSTAIN (may be recomputed by the deterministic `capabilitiesFor`, no inference) | none |
| **B** embedding relevance, stored vectors only | admit iff cosine(stored discovery vector, centroid of stored open-problem / lane vectors) ≥ the threshold that admits the same number as A (budget-matched), fixed on non-protected labels only (§6a). Requires a stored vector for the discovery; no embedding call is made in this study | cosine (uncalibrated score) |
| **C** selective jev (existing verdicts only) | first non-error `discovery_relevance` row on the ref or its unit: `yes` → admit, `no` → reject, `uncertain` → ABSTAIN (selective). Variant **C\*** (what FE2 does): `uncertain` → reject | p(relevant) = conf if the chosen class ∈ {open_problem, lane_technique}, else 1 − conf |
| **D** hybrid cascade | A first: A-reject → reject. A-admit → jev `no` vetoes (reject); jev `yes`, `uncertain`, error or unjudged → admit (jev only as a confident veto) | none |

C is a **candidate**, never ground truth: no label in §2 is derived from it.

## 4. Metrics (all with 95 % CIs)

- precision = TP / admitted; recall = TP / labelled positives (only inside the population where the candidate's rejects
  can carry a label — see §2 selection caveat; otherwise NOT ESTIMABLE); coverage (non-abstained / labelled).
- false-negative cost, DI-001 loss weights (#827 LOSS.md): discovery admission is a **low-risk** decision (a unit can never
  self-promote past `CAPABILITY_INFERRED`; I06), so `ℓ = 3 · FA + 1 · FR` per labelled ref, FA = admit ∧ negative, FR =
  reject ∧ positive. Sensitivity grid `w_FA(low) ∈ {1, 3, 10}` × `w_FR ∈ {0.5, 1, 2, 5}` (12 cells). Abstentions are not
  costed (reported as coverage). These are exploratory relative weights, not money.
- calibration: Brier score for C (the only candidate with a probability); a 10-bin reliability / ECE only when n ≥ 50.
- latency: C from `judgments.latency_ms` (p50 / p95); A in-process (not separately measured; deterministic, no I/O beyond
  the DB); B not measurable without a stored vector.
- operational cost: tokens per call and per labelled TP, error rate (C); 0 inference for A and D's gate.
- downstream verified yield: admitted refs with an L3 positive / admitted refs.

CIs: Wilson 95 % for single proportions; for differences and losses a bootstrap (B = 2000, mulberry32 seed `20261014`),
resampling **labelling sessions** (calendar day of the human action) as clusters, with the item-level bootstrap reported
alongside (labelled "ignores batch dependence").

## 5. Sufficiency and verdict rules

A pairwise comparison X vs Y is **evaluable** only if the primary labelled set has ≥ 50 refs, ≥ 10 positives, ≥ 10
negatives, ≥ 2 sources with ≥ 10 labelled refs each, and ≥ 10 labelled refs on which X and Y disagree. Otherwise it is
**INSUFFICIENT**. A candidate with no prediction on the labelled set is **NOT COMPUTABLE**.

Per candidate:
- **GO** — every comparison against the other computable candidates is evaluable, the session-bootstrap CI of
  `L_other − L_X` lies above 0 under the default weights for the best other, and `L_X` is lower in every grid cell.
- **REJECT** — evaluable and the mirror condition holds (worse than the best other), or (for C) the #825 reactivation rule
  cannot be met because no consumer acts on its output.
- **HOLD** — anything else (INSUFFICIENT, INCONCLUSIVE, NOT COMPUTABLE). HOLD means: keep the current operational state —
  A stays the live cheap gate, C stays as recorded history (paused under #825 once that flag is set), B and D are not built.

jev reactivation (C) additionally needs, per #825 §6: incremental value over the best cheap alternative (A, B or D) by a
non-overlapping 95 % CI on precision at a budget-matched admission count, on ≥ 50 stratified labels, **and** an
operational consumer that acts on `yes` (FE2 units that reach `CHECKED`, or N4 terms whose yield beats the static
baseline). Without a consumer the value of information is 0 whatever the accuracy.

## 6. Labelling plan (design only; sized in BENCHMARK.md)

If the result is INSUFFICIENT, BENCHMARK.md delivers a bounded human-labelling plan, budget **≤ 30 operator minutes/day**.

### 6a. Protected evaluation sample (operator addendum)

- A representative **PROTECTED** evaluation sample is drawn from the primary population, stratified by source × ISO week of
  first occurrence, proportional allocation, minimum 3 refs per non-empty cell, order within a cell by
  `sha256(ref + "di001-relevance-eval")` ascending. The list of refs is frozen in `eval-sample.json` with its sha256 in
  `eval-sample.sha256`, committed in its own commit **before any label on it exists and before any optimisation** (no
  threshold, calibration or model choice is fitted before the freeze; the sample depends only on label-free data).
- Size `N_eval` = the McNemar paired-proportion sample size for a minimum detectable difference **δ = 0.10** in per-item
  error rate between two candidates, α = 0.05 two-sided, power 0.80, with discordance ψ = the label-free disagreement rate
  of A vs C\* on the primary population at snapshot (for two binary decisions, exactly one is wrong when they disagree,
  so ψ needs no label): `n = (1.96·√ψ + 0.8416·√(ψ − δ²))² / δ²`, rounded up to a multiple of 10, floor 100, cap 400.
- The protected sample is used **only** for evaluation: never for training, never for B's threshold, never for
  source-specific calibration. Per-candidate precision on it is reported with its (wide) Wilson CI; the primary
  comparison is the paired per-item loss over all N_eval refs (C abstentions scored as reject, i.e. C\*).
- **Active learning** selects only **additional** labels from outside the protected sample: over-sample the A-vs-C\*
  disagreement cells and C `uncertain`, plus a fixed 20 % random share (so the training pool is not purely adversarial).
  These labels may tune B's threshold and source calibration; they never enter an evaluation number.

### 6b. Labelling protocol (operator addendum)

- Question (one per ref): "Would this discovery plausibly inform a concrete Djimitflo change or gym experiment — an open
  problem it addresses, or a technique a lane or agent could try?" → `relevant` / `not relevant` / `unclear`.
- The card shows title, note/abstract, source and URL only. It is **blind** to every candidate (no jev class or
  confidence, no taxonomy match, no admission state) and to any earlier label. Order is randomised per session.
- `unclear` is a recorded label, not a negative: it is excluded from precision/recall and counted.
- ≥ 2 annotations on a **≥ 20 % overlap subset** (stratified like the sample), reported with raw agreement, the
  confusion table and κ with a bootstrap 95 % CI (B = 2000, seed `20261014`). What the number is called depends on who
  annotated:
  - **two or more independent humans** → **inter-annotator agreement** (Cohen's κ for two, Fleiss' κ for ≥ 3);
  - **one operator only** → a **delayed blind re-label** of the overlap subset (shown again ≥ 7 days after the first
    label, shuffled, without the first label) → **intra-annotator consistency** (test-retest). It is reported under that
    name only. The κ computed from it is **not** inter-annotator agreement and is never presented as such.
- Limitation (one operator): intra-annotator consistency shows whether the operator's own labels are stable over time. It
  cannot show that another person would agree, and it cannot detect a bias the operator holds consistently. A verdict
  resting on single-operator labels says so explicitly. When a second human becomes available, they label the same
  overlap subset and the report gives both numbers, each under its own name.
- Adjudication: a disagreement goes to a third reviewer when one exists, else the operator decides with both earlier labels
  visible. The adjudicated label is used; both original labels are kept and the item is flagged. Disagreements are
  logged, never discarded.
- If the κ lower CI bound (of either kind) is < 0.4 the labels are reported as unreliable and no GO verdict may rest on them.
- Label UI = the existing `/decisions` pattern (`decisions-inbox.ts` D5: one row, a few buttons, an `operator_label`
  judgment with `state_hash = 'discovery_relevance'`). Design only, nothing is built here.
- jev output is never ground truth, never shown to the annotator, and never used to adjudicate.

## 7. Reproducibility

`scripts/di-001/relevance-bench.cjs` (read-only, `better-sqlite3 {readonly: true}`, run inside the prod container with
`docker exec`) writes every number in `BENCHMARK.md` to `results.json`. It makes no network call and no inference call.
