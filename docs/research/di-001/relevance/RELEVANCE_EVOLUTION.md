# DI-001 P4 — relevance evolution: design (no build)

Design only. Nothing here is implemented. Builds on #825 (the pause and the `unjudged` marker), on `PREREG.md` and on
`BENCHMARK.md` in this directory. Principle: **missing evidence is never a negative label**, and **jev output is never
ground truth**.

## 1. Three recorded facts, one derived state

For each discovery ref the system already records, or can record, three separate facts. They are never merged into one
column (operator addendum, PREREG §2a).

| fact | what it says | where it lives today |
|---|---|---|
| **classification** | what a classifier said: A (taxonomy + scope), C (jev), later B (cosine) | A: `judgments.subject_type` `discovery_pending` (accepted) or `discovery_rejected` (rejected), and units' `source-units:*` capabilities. C: `judgments` `discovery_relevance` rows. #825 adds `external_events.payload.relevance = 'unjudged'`, `relevance_paused` and `relevance_paused_at` |
| **admission** | whether a unit was created | `expert_identities` (kind paper/repository) whose `aliases_json` holds the ref; `expert_evidence.metadata.derived` (`fleet-discovery`, `taxonomy_override:jev`) |
| **verification** | an independent outcome | L1 human `expert_lifecycle_events` (`CHECKED`/`APPROVED`/`ACTIVE` or `REJECTED`/`REVOKED`). L2 `judgments` `operator_label` with `state_hash = 'discovery_relevance'` (BENCHMARK §6.5). L3 citation by a `verified` self_improvement |

The **relevance state** below is a pure function `relevanceState(ref)` over these three facts: a read-model, computed on
read, with no new table and no stored state column. Each state names the fact it comes from, so the facts never
collapse.

## 2. State machine

```
 event stored
      │
      ▼
  UNJUDGED ──A reject──▶ FILTERED ──sampled (AL / audit) or C yes──┐
      │                                                            ▼
      ├──A admit, C uncertain / A≠C──────────────────────────▶ UNCERTAIN
      │                                                            │ admission rule fires
      └──A admit + admission rule (FE2) ──────────────────────▶ ADMITTED
                                                                   │
   classification facts above · verification facts below ─────────┼──────────
                                                                   ▼
   any of FILTERED / UNCERTAIN / ADMITTED ── independent + ──▶ VERIFIED
                                         └── independent − ──▶ REJECTED
                                   (VERIFIED ⇄ REJECTED only by a later human label)
```

| state | definition (derived) | maps onto | can become |
|---|---|---|---|
| **UNJUDGED** | an event is stored but there is no classification: #825 `relevance: 'unjudged'` (paused), jev errors only, or no gate record and A not recomputed | `external_events` row, plus the #825 marker or no `judgments` row | FILTERED, UNCERTAIN, ADMITTED (A recomputed, `rejudgePaused` once unpaused) |
| **FILTERED** | the cheap classifier rejected it (source out of scope, or no taxonomy match), and no override exists | `discovery_rejected` row, or recomputed A = reject; no unit | UNCERTAIN (picked by AL or the random audit, or C says `yes`), VERIFIED/REJECTED (label). **It is a classification, not a negative label.** |
| **UNCERTAIN** | a classification exists, but the evidence for admission is weak or conflicting: A admits and C is `uncertain`, or A and C disagree, or a FILTERED ref that was sampled | `judgments` decision `uncertain`, or A ≠ C | ADMITTED (an admission rule fires), VERIFIED/REJECTED (label) |
| **ADMITTED** | a unit exists (the admission fact), with no independent label yet | `expert_identities` `CAPABILITY_INFERRED` / `EVIDENCE_COLLECTED` | VERIFIED, REJECTED |
| **VERIFIED** | an independent positive: L1 human `CHECKED`/`APPROVED`/`ACTIVE`, L2 `yes`, or L3 cited by a verified change | `expert_lifecycle_events` (human actor), `operator_label`, `self_improvements` evidence ref | REJECTED (a later human `REVOKED` or L2 `no`, which wins by recency) |
| **REJECTED** | an independent negative: L1 human `REJECTED`/`REVOKED`, or L2 `no` | as above | VERIFIED (a later human label) |

Guards:
- VERIFIED and REJECTED are reachable **only** from verification facts.
- A jev `no`, an A reject, an automated lifecycle actor, a `model-review:*` actor and the absence of a citation each
  leave the ref where it was.
- An L1 human un-check (`CHECKED` → `CAPABILITY_INFERRED`) returns the ref to ADMITTED. It does not make it REJECTED.
- L2 beats L1. A conflict between label sources shows as VERIFIED/REJECTED with a `conflict` flag, and it goes to
  adjudication (PREREG §6b).
- Admission follows the current rule (FE2: A and C `yes`; paused: nothing new). ADMITTED is not a quality claim.

L3 needs one small convention to stop being text-scraped (design): a change that uses a discovery cites it as
`discovery:<ref>` in `evidence_refs_json`. That is the same pattern as `test-gap:` and `requeue-of:`.

## 3. Missing evidence ≠ negative label

Each of these is UNLABELLED (state UNJUDGED, FILTERED, UNCERTAIN or ADMITTED), never REJECTED:
- paused refs;
- jev errors (7.9 %);
- refs without a unit;
- units nobody looked at;
- discoveries no change cited.

Every metric reports these as coverage or abstention. This carries #825's rule ("paused events are missing, never `no`")
over to the verification side. The fleet source gate (R3) and N4 yields already follow it.

## 4. Active learning (outside the protected sample)

- The pool is every ref not in `eval-sample.json`. The protected sample is never selected, trained on or tuned on.
- Daily selection, in the steady state after the 340-ref evaluation:
  - 50 % from the **disagreement** cells (A ≠ C, and later A ≠ B or B ≠ C);
  - 30 % from **uncertainty** (C `uncertain` with p nearest 0.5; later B near its threshold);
  - 20 % **uniform random**, which keeps the pool unbiased enough to estimate base rates.
- Each source gets at least 2 labels a day while it is active, so a quiet source does not go unseen.
- Labels go to the L2 `operator_label` row. AL labels may set B's threshold and per-source calibration (§5). They never
  enter an evaluation number.

## 5. Source-specific calibration

- Base rate per source: P(relevant | source), Laplace-smoothed, computed from the AL random share plus protected labels.
  It is used to **report** precision per source and as the prior for per-source thresholds.
- A per-source threshold (B's cosine cut, or a C confidence floor) is allowed only with ≥ 30 non-protected labels from
  that source. Until then the global threshold applies.
- Every number is reported per source and never pooled across sources (as #827 never pools across risk classes).
- An out-of-scope source (hermes-*, kbwiki) gets a 2-per-week random audit. Once its base rate's 95 % CI lower bound
  exceeds the in-scope sources' median, it becomes a candidate for scope, and that is an operator decision.

## 6. Drift monitoring

Label-free signals, computed weekly from existing tables (display on `/knowledge`, next to #825's `relevance_pause`):

| signal | source | alarm |
|---|---|---|
| discovery volume per source | `external_events` | outside 0.5×–2× the 4-week median, or a 36 h gap (already in stall watch) |
| A admit rate per source | recomputed A | moves > 2× the 4-week median, or the taxonomy table changed (hash) |
| C class mix per source (when unpaused) | `judgments` | `uncertain` share moves > 15 points |
| B score distribution (when built) | stored vectors | population-stability index > 0.2 |
| AL disagreement rate ψ | A vs C\* | moves > 10 points: the N_eval sizing is stale |

Label-based signal: the 20 % random share gives a rolling precision of the live admission rule. If its 95 % CI drops
below the protected-sample estimate's lower bound for 2 consecutive weeks, the alarm fires.

An alarm opens a decisions-inbox item. It changes nothing on its own.

## 7. Bounded human review

The hard budget is **30 operator minutes/day**, enforced by a daily quota (≈ 30 cards at 1 min; re-cut once timing is
measured).

| phase | quota per day | content |
|---|---|---|
| 1. evaluation (≈ 12 days) | 30 | protected sample, shuffled |
| 2. overlap re-label (from day 8) | 10–20 inside the 30 | 68 protected refs, blind, ≥ 7 days later |
| 3. active learning (≈ 5 days) | 30 | §4 mix |
| steady state | 10 | 5 random audit (drift) + 5 AL |

- Ranking within the quota reuses the decisions-inbox `RankedItem` score. `operator_minutes` stays a stated assumption
  until it is measured.
- Unfinished cards roll over and do not accumulate: the quota is fixed, and the backlog is a count, not a debt.

## 8. jev reactivation rule

jev (C) for discovery relevance stays paused (#825) until **all** of the following hold. The same rule, run in reverse,
pauses it again.

1. **Incremental value.** On the protected sample, C (or C restricted to the UNCERTAIN cell) beats the best cheap
   alternative among A, B and D. That means a non-overlapping 95 % CI on precision at a budget-matched admission count,
   or a session-bootstrap CI on the loss difference (default weights) lying entirely above 0 with every grid cell
   better (PREREG §5). The comparison must be evaluable: ≥ 50 labels, ≥ 10 positives, ≥ 10 negatives, ≥ 10
   disagreements.
2. **Label reliability.** The lower CI bound of κ is ≥ 0.4, reported under its correct name (intra-annotator
   consistency for one operator, inter-annotator agreement for two or more humans).
3. **An operational consumer that acts.** FE2 units from C `yes` that reach VERIFIED at a rate above A's admitted units
   (protected sample), or N4 terms whose yield beats the static baseline. Without a consumer the value of information is
   0, whatever the accuracy.
4. **Cost ceiling.** Tokens per *additional* verified discovery (over the cheap alternative) stays under an
   operator-set ceiling. At about 850 tokens per call and 7.9 % errors, the ceiling is measured, not assumed.
5. **Selective scope.** Reactivation covers only the cell where (1) holds, most likely the UNCERTAIN cell (A admits
   and B is near its threshold). It is never a blanket re-enable, and it is never used as a label.

If (1) fails with the comparison evaluable, C is REJECTED for that cell, and the result goes into the negative evidence
registry as a sibling of NE-001.

## 9. What is not proposed

- No new table: the state is derived.
- No new scheduler, no automated relabel, and no automated promotion past `CAPABILITY_INFERRED` (I06 is unchanged).
- No embedding is computed until the operator approves B's offline cost: 340 protected refs plus the AL pool, about
  500 calls on local nemotron.
