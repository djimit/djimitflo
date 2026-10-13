# Outcome attribution design (§16.5, §16.6)

Source of truth for the code: `packages/server/src/services/outcome-attribution.ts` (#707, live since prod `cb026075`,
flag `OUTCOME_ATTRIBUTION_ENABLED=true` since 2026-10-08 22:07Z). Numbers: prod read-only 2026-10-09 21:38Z (see
`INTELLIGENCE_BASELINE.md`, Sources).

## Why it exists

Before #707, every learner read `verified`/`regressed`, but 30 of 45 regressions (30 d) were a missing reviewer verdict after a
**completed** maker. That is asymmetric label noise (ρ ≈ 0.32–0.42) on the maker's reward. The noise punished maker species,
memory rules and genomes for reviewer and infrastructure failures.

## How it works today

`attributeOutcome(run)` is a pure function, and the first matching rule wins:

1. **Annotation.** The newest `outcome_attribution` judgment on the run, or on its proposal when that judgment was made after the
   run started. Operator annotations win.
2. No failed gates → `verified`.
3. No maker lease → `environment_failure`.
4. Maker not completed: `maker_failure` if it had changed files (`regressed`), otherwise `environment_failure`.
5. Maker completed but its run was infra (missing tool or timeout), or it changed nothing → `environment_failure`. The operator kept
   "no change = environment" on 08-10 (EP5 not approved).
6. A maker gate failed (`tests_lint_typecheck`, `diff_threshold_all_makers`, `auto_approved_scope`) → `maker_failure`.
7. A reviewer that ran returned a rejecting verdict → `maker_failure`.
8. An environment gate failed (`worktree_isolation`, `assignment_file_present`, `run_not_cancelled`) → `environment_failure`.
9. A review gate failed with no verdict (timeout, token budget, unparsed, insufficient_evidence) → `reviewer_failure`.
10. Anything else → `maker_failure` ("unclassified gate", conservative: it does not forgive the maker).

**Recording.** Each settled run gets one `judgments` row (`judgment='outcome_attribution'`, mode `annotation`, `decision` = class,
`reason`). Verified runs also credit their contributors in `outcome_credits(run_id, kind, ref)`: the maker (`runtime@model`), the
model, the genome, accepted reviewers, the memory rules and examples in the assignment context, `kb:`/knowledge refs on the proposal,
and enforce-mode judgments that let the run through.

**Consumers.** `nonMakerRunSql()` / `outcomeAttributionEnabled()` let the maker-side learners skip reviewer and environment failures:
`runtime-bandit.ts`, `fitness-view.ts`, `assignment-context.ts` (memory-rule fitness), `earned-autonomy.ts`, `evolution-evidence.ts`
(genome evidence) and the cockpit. Only `maker_failure` counts as a maker failure.
`self_improvements.status` is never rewritten.

## Coverage today (30 d window)

| Quantity | Value | n | Note |
| --- | --- | --- | --- |
| Attribution judgments | 45 | — | first 2026-10-08 17:29Z (operator annotations), first computed 2026-10-09 08:21Z |
| verified | 8 | 45 | all computed |
| reviewer_failure | 32 | 45 | **30 operator annotations** (backfill of 08-10) + 2 computed |
| maker_failure | 4 | 45 | computed |
| environment_failure | 1 | 45 | computed |
| Settled proposals in the same window | 99 | — | 47 verified / 52 regressed |
| Coverage (attributed / settled) | 0.455 [0.360, 0.552] | 99 | runs before 08-10 have none; the window is mostly pre-attribution |
| Computed-only coverage | 15 / 99 | 99 | the rest are annotations |
| Credited verified runs | 8 / 8 | 8 | 42 credit rows: maker 8, reviewer 16, memory_rule 12, judgment 5, genome 1; **knowledge 0** |
| Survival labels | 0 yes / 0 no | — | merge survival attaches later (~19-10) |
| Memory-rule reads with an unattributed regression | 64 of 208 regressed reads | 208 | from F3; these runs predate #707, so their class is unknown |

**Caveat on the 64 "unattributed" reads.** These are rule reads whose regressed run predates attribution, not runs that attribution
failed on. A one-off backfill (read-only computation via `attributionInputForRun` + `attributeOutcome`, no writes) would show
how many are maker failures. It has not been run. The figure in F3 (15 maker / 129 reviewer-env / 64 unattributed) mixes computed
classes and missing ones.

## Known weaknesses

| Weakness | Effect | Mitigation |
| --- | --- | --- |
| Rules 9/10 are asymmetric by design: a missing verdict forgives the maker | If a maker's diff makes reviewers time out (huge diffs), the maker is forgiven | Audit stratum "reviewer_failure with a diff > p90"; graded score as a second signal |
| Operator annotations dominate `reviewer_failure` (30/32) | The class distribution reflects one backfill, not the classifier | Report computed and annotated rows apart (already in `by_source`) |
| Gate-name parsing (`split(':')[0]`) | A renamed gate silently falls to rule 10 | Validation test: every gate name in `loop_runs.metadata.failed_gates` in the last 30 d maps to a known set |
| `no_change` = environment | Learned laziness stays unpunished (EP5) | Operator decision stands; measure the no_change share per species as a monitor |
| Requeued runs | A proposal-level annotation covers only runs started before it | Already handled; cluster CIs by proposal |
| No independent check | CAR unknown | Audit below |

## CAR audit design (independent adjudication sample)

**Goal.** Estimate `CAR = correct / audited` per class, with coverage reported separately (§16.6), and without picking easy cases.

1. **Frame.** All settled runs with a computed attribution (source = computed; annotations are excluded because they are the
   reference, not the subject) from 2026-10-09 onward.
2. **Stratified random sample, seeded and fixed before adjudication.** Draw 10 per class (maker, reviewer, environment, verified),
   or all when fewer exist, plus 10 from rule-10 "unclassified gate" and 5 from "reviewer_failure with large diff". Target ≥ 40.
   The seed and sampled run ids are written to the audit record first, so the sample cannot be changed after looking.
3. **Adjudicator.** The operator, or a model of a different family than the checker (cross-family per F2), reading only the run's
   raw evidence: lease metadata, failed gates, check logs, verdict text, diff stat. The computed class and reason are **hidden**.
   The adjudicator picks one of the four classes or `unknown`.
4. **Controlled ground-truth cases.** Add 8 planted runs built in the F1 harness style (no prod writes): a maker that breaks
   tests (→ maker), a reviewer killed by the token cap on a small diff (→ reviewer), a missing tool (→ environment), and a clean
   pass (→ verified). Two of each. These measure the adjudicator as well as the classifier.
5. **Estimator.** CAR per stratum (Wilson), combined by class-frequency weights (Horvitz–Thompson), bootstrapped by proposal.
   `unknown` stays in the denominator as its own count and is reported (§16.6: do not exclude difficult cases).
6. **Decision rules (pre-registered).** CAR ≥ 0.85 with a lower bound ≥ 0.75 means learners keep consuming attribution. If
   reviewer_failure CAR < 0.7, revert reviewer forgiveness for maker-side learners (rollback = `OUTCOME_ATTRIBUTION_ENABLED=false`,
   which leaves the judgments rows as annotations). Disagreements become cases for a reason taxonomy fix, never for silent relabelling.
7. **Cadence.** Monthly, or after any change to `outcome-attribution.ts`. The audit record is stored as `outcome_attribution_audit`
   judgments (mode `annotation`) on the run, so no new table is needed.

**As built (§16 step 4, 2026-10-10).** A first, smaller version of the above runs on the Decisions inbox: 10 runs per week, seed
`car-audit:<monday>`, drawn round-robin over the four classes from computed attributions made before the week started (fixed for
the week; runs audited before the week leave the frame). The operator sees the computed class and reason and judges it
`correct` / `wrong` / `unclear` (so this audit is **not blind**; the blind four-class adjudication above stays the target).
Records are `judgments` rows `judgment='attribution_audit'`, `mode='operator_label'`, `state_hash` = the class judged, written
only through `POST /self-improve/attribution-audit/:runId` (write:governance). CAR = correct / audited with `unclear` in the
denominator; the rule-10 and large-diff strata and the planted cases are not built yet. The read-only backfill
(`attributionBackfill`) reports what `attributeOutcome` would say for unattributed settled runs, as CAR coverage context only.

**Cost.** About 40 adjudications. Operator time is ~2–3 min each (~2 h), or ~40 cross-family model calls (≈ 1.5 M tokens at
F1's 36 k tokens per call).

## Failure-classification → recurrence (§16.5)

Today the only stable signature is the gate class, and it is too coarse: 8 signatures cover 84 failures, and 90 % of failures are
"repeats". The proposed signature is `(attribution class, first failed gate, normalised failure_reason)` with the normaliser
stripping ids, paths and numbers. It is computed at read time from `worker_leases.metadata.failure_reason` and the attribution
reason, so no new table is needed. Recurrence counts a repeat only **after** a remediation for that signature is linked (a merged
PR whose body or commit cites the signature). Without remediation links, a "repeat" only shows that the failure is common, not that
nothing was learned. The observability guard (§16.5) applies: the share of failures with a non-empty reason must not drop when
FRR drops.
