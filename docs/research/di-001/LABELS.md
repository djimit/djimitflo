# DI-001 labels: which outcomes can count as independent evidence

Every number here comes from `results.json` (from `scripts/di-001/score.mjs`, manifest `rows_sha256 48d1f0aa…`, snapshot
`2026-10-13T22:28:27.395Z`). The rules are in PREREG.md §2–§3.

## 1. Four kinds of label

| kind | where it comes from | can it count? | on this population |
|---|---|---|---|
| **Executed oracle** | maker `deterministic_checks` (`test:changed`, `lint`, `type-check`, `test:mutation:grounded`, `test:assertion-strength`) and the `tests_lint_typecheck` gate in `loop_runs.gates_json` | **yes**. A program ran and either passed or failed. | The final maker ran checks for 107/128 proposals, mutation testing for 100, assertion strength for 26. **A final-attempt oracle never failed (0/128).** |
| **Deterministic policy** | gates `diff_threshold_all_makers`, `auto_approved_scope` | yes (A-class) | 0 failures decided a label. One run failed `auto_approved_scope`, but rule order put it in `ENV`. |
| **Checker / LLM reviewer verdict** | `checker` / `security_checker` lease `verdict` | **no, it is circular.** A checker rejection is not evidence that the checker was right. Using it as a negative label scores the reviewer against itself. | 3 `CHECKER_REJECT` (2 `needs_revision`, 1 `rejected`). Excluded. |
| **Missing reviewer verdict** | review gate failed, but no completed rejecting verdict (timeout, token budget, `insufficient_evidence`, dispatch) | **no.** Nothing was observed. | 27 `NO_VERDICT`. Excluded. |
| **Environment / runtime** | `maker_completion` ≠ pass, or no changed files | **no.** No change was evaluated. | 26 `ENV` (24 `maker_completion=fail`, 2 with no changed files). Excluded. |
| **Merge survival** (D-class) | `loop_runs.metadata.pr_outcome`: merged, then ≥ 14 d with the added lines kept | **yes**, and it is independent. | 65 PRs: 35 merged, 30 open, **2 settled** (both survived, both `ORACLE_PASS_VERIFIED`). n is far too small. |
| **Operator labels** | `operator_label` (D5: prescreen rejections), `attribution_audit` / `operator_label` (CAR) | yes (C-class) | 1 `operator_label` row on this population. **0** CAR audits exist in the whole DB. |

The positive class is `ORACLE_PASS_VERIFIED`, which means `status = verified`: every gate passed. That includes **checker
acceptance**. The data has no positive class that does not depend on a checker accept. Every table that uses this label
carries that caveat.

## 2. Exclusion counts (primary label)

| label class | n | primary role | reason |
|---|---|---|---|
| ORACLE_PASS_VERIFIED | 72 | positive | all gates passed |
| ORACLE_FAIL | **0** | negative | — |
| POLICY_FAIL | **0** | negative | — |
| NO_VERDICT | 27 | excluded | 13 had both review gates failed, 8 checker only, 6 security only; none had a completed rejecting verdict |
| ENV | 26 | excluded | 24 `maker_completion=fail` (maker runtime exit ≠ 0, a timeout, a cancelled sibling lease, or `diff_under_threshold`); 2 had no changed files |
| CHECKER_REJECT | 3 | excluded | circular |
| UNCLASSIFIED | 0 | — | — |

Label provenance completeness:
- 128/128 resolved by the pre-registered rule;
- 83/128 have an `outcome_attribution` judgment;
- 107/128 have recorded final-maker oracle checks. The rest are `ENV` rows, where the final maker never ran checks.

**Central finding: none of the 56 `regressed` proposals is an executed-oracle failure of the final attempt.**
- 27 are missing reviewer verdicts.
- 26 are runtime or environment failures.
- 3 are checker rejections.

Under the independent label the negative class is **empty**. Every predictor's false-accept count is 0 by construction,
and always-accept is trivially optimal. The pre-registered primary comparison is therefore **INSUFFICIENT**, not
INCONCLUSIVE. With no negatives there is nothing to discriminate.

Earlier attempts did fail oracles. In 13 proposals at least one maker attempt (often a superseded one) had a check exit
≠ 0 and ≠ 127. Those attempts were retried:
- 8 of the 13 ended `verified`;
- 3 ended `ENV`;
- 2 ended `NO_VERDICT`.

So the oracle signal exists at the **attempt** level, not at the proposal level. That is a candidate label for a future
protocol. It was not pre-registered here and is not scored.

## 3. Future-information leakage check

The rule is that a prediction counts only if `judgment.created_at < outcome_at` and (when present)
`answers_json.as_of < first goal.created_at` (PREREG §3.2). `outcome_at` is the run's `completed_at`.

| predictor | with a judgment | created at/after outcome | as_of ≥ goal (of the rest) | error | usable |
|---|---|---|---|---|---|
| `forecast:committee` | 69 | **49** | 17 | 0 | **3** |
| `proposal_prescreen` | 109 | 0 | 0 | 1 | 108 |

Committee timing, over all 69 forecasts:
- `created_at − outcome_at`: median +0.24 h, p95 +2.19 h.
- `as_of − outcome_at`: always negative (0/69 ≥ 0). The *question* was frozen before the outcome.
- `as_of − goal.created_at`: median +0.0001 h (~0.4 s). The committee job is queued in the same tick as the goal, so the
  `as_of ≥ goal` exclusions are mostly a timing technicality, not information leakage.

`created_at > outcome_at` is the real problem. Member context is assembled when the job is *claimed*
(`committee-swarm.ts:110`, `memberContext`), not at `as_of`. So the `as_of` stamp does not bound what the members could
read:
- the `skills` recipe reads verified examples of the same source at claim time;
- `kb` and `memory` are read live.

A direct read of the subject's own outcome is not shown: the `skills` recipe excludes the subject id. An indirect leak
through cluster-mates (requeue copies of the same target) is possible and **UNVERIFIED**. The frozen question's
`lane_recent` (`committee-swarm.ts:61`) also lists outcomes of same-source proposals. Those are known before `as_of`, so
they are legitimate history, not leakage.

The LOST/UNVERIFIED window `2026-10-11T04:16:22Z → 2026-10-12T16:43:39Z` overlaps no proposal's
`[created_at, outcome_at]` in the population (0 flagged). Proposals or judgments written inside the window are absent
from the DB. They are not counted, and their absence is never read as a zero or as "no forecast".

## 4. What would make a usable label

- **Attempt-level oracle labels.** One row per maker attempt, with check exits: available now, needs a new protocol.
- **Merge survival.** About 35 merged PRs will settle through roughly 2026-10-27. Still only positives-heavy, n ≲ 35.
- **CAR operator audits** of `outcome_attribution` (0 today). D5 labels cover prescreen rejections, not this population.
