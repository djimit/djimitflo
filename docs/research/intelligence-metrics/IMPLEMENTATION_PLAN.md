# Implementation plan (§16.18): smallest first

Every step uses existing tables, judgments rows, the evidence builder and health endpoints. No new framework, database, bus or
orchestration layer. Each step is read-only or shadow first, and acting steps need operator approval.

**Standing constraints (apply to every step).**
- A candidate (genome, memory rule, skill, maker species, forecaster) never changes its own evaluator, holdout, risk limits, gates,
  attribution rules or promotion criteria. Changes to those are separate, operator-approved PRs, made between experiments.
- Hard floors (gates, security checker, human merge, auth/deploy/secrets, the ≥ 5 % exploration floor) are never selected away.
- `INSUFFICIENT_EVIDENCE` is a first-class status, never rendered as 0.

| # | Change | Size | Unblocks | Acceptance criteria | Rollback |
| --- | --- | --- | --- | --- | --- |
| 1 | **`intelligence` section in `buildEvolutionEvidence`**: per contract in `METRIC_CONTRACTS.yaml`, emit `{metric_id, version, status (ok / INSUFFICIENT_EVIDENCE / UNDEFINED / NOT_MONITORED), value, ci, n, reason}` from queries that already exist (memory_holdout, effort_x1, graded, trials, attribution, efficiency, forecasts_v2, hack_rate). Read-only. | S (one function + tests) | §16.14 dashboard, §16.15 tests | Vitest: (a) below minimum n → status INSUFFICIENT_EVIDENCE and value `null`, never 0; (b) denominator equals the eligible count of the same snapshot; (c) duplicate requeue rows collapse per proposal; (d) a missing table → INSUFFICIENT_EVIDENCE with reason; (e) contract version stamped. Prod: the section renders with today's numbers matching this doc's scorecard. | revert the PR (pure read path, no schema) |
| 2 | **Approval → goal link**: write `goal_id` (and `improvement_id`) into `approvals.metadata` when an approval is created for a goal; read-side join for ADQ. | S | ADQ | New approvals carry `goal_id`; ADQ per class shows n with outcomes; a test checks autonomy actor_type matches the `autonomy:` prefix (guards the #725 fix) | revert; the field is additive JSON |
| 3 | **Attribution backfill report (read-only)**: run `attributionInputForRun` + `attributeOutcome` over pre-08-10 settled runs in memory and report class counts. No writes. Resolves the 64 unattributed regressed rule reads from F3. | S (script) | F3 refit, CAR frame | Report lists counts per class with n; zero rows written (verified by row counts before/after) | n/a (no writes) |
| 4 | **CAR audit sampler**: seeded stratified sample of computed attributions (10/class + rule-10 + large-diff strata), exported for blind adjudication; adjudications stored as `outcome_attribution_audit` judgments (mode `annotation`). The design is in `OUTCOME_ATTRIBUTION_DESIGN.md`. | S | CAR | Sample ids and seed recorded before adjudication; CAR per stratum with Wilson CI and an `unknown` count; computed class hidden from the export | delete the audit judgments (annotation only; learners do not read them) |
| 5 | **Failure signature at read time**: normalise `(class, first failed gate, failure_reason)` (strip ids, paths, numbers) in the evidence builder; remediation link via a `fixes-signature:<hash>` line in loop PR bodies / commits. | S–M | FRR, MTTx | Signature-level FRR per week with n; an observability guard (share of failures with a reason) shown beside it; a test proves an empty-reason failure does not lower FRR | revert (read path) |
| 6 | **Gym diff storage + weak-assertion check (in flight: `feat/gym-diff-weak-assert`)**: `GYM_STORE_DIFFS` (redacted) and `WEAK_ASSERTION_CHECK_MODE=shadow`. | M | SOUP data, EXP-5 | Diffs stored for new gym runs with the secret-pattern redaction test passing; shadow flags logged; EXP-5 stage-1 offline numbers reported | flags off; stored diffs deletable by run id |
| 7 | **Holdout epoch hygiene**: freeze the write_test holdout (`DREAM_TRIAL_WRITE_TEST_HOLDOUT`, already built) and record the decision count per epoch; the evidence builder flags an epoch with ≥ 3 decisions as `exposed`. Retiring an epoch is an operator action. | S | VIG, ESE | Evidence shows decisions per epoch; a trial on an exposed epoch is labelled `exposed` in its record | revert (read path); the flag already exists |
| 8 | **`policy_violations` writer (shadow)**: record post-hoc violations already detected today (reviewer wrote files, protected path touched, tool outside `allowed_tools`) as rows. No blocking. | S–M | SCIG monitors | Each known detection path writes a row in a test; `NOT_MONITORED` → monitored with n; zero behaviour change in gates (off-vs-shadow identical gate results test) | flag off |
| 9 | **Skill identity on the lease**: populate `skill_outcomes.skill_content_hash` / `skill_version` from the SKILL.md actually injected. | S | skill-evolution question | Every new maker outcome carries a hash; the evidence builder groups outcomes by hash | revert; columns already exist |
| 10 | **Operator-run experiments** EXP-1 (F2 offline), EXP-3 holdout-rate decision, EXP-4 preconditions, EXP-6 knowledge trace (after #727) | — | CIA, CLY, ESE, EII | Each registered with the template in `EXPERIMENT_PROTOCOL.md` before its first outcome | per registration |
| 11 | **Second repository** for gym mining and one prod oracle lane (an operator-owned repo, e.g. `roborev`), with tasks file-disjoint from the source holdout | M–L | GTI, generalisation in every contract | ≥ 20 tasks from repo 2 in a frozen epoch; GTI moves from UNDEFINED to a value with CI, or INSUFFICIENT_EVIDENCE with n | remove the repo from the generator config |

## Dependencies

```text
1 ──► (everything reads its statuses)
2 ──► ADQ          3 ──► 4 ──► CAR          5 ──► FRR
6 ──► EXP-5, training-data threshold        7 ──► EXP-4 ──► VIG / ESE
9 ──► skill question                         11 ──► GTI, RIR on unseen tasks
#727 deploy ──► EXP-6 ──► EII / CLY first trace
merge survival (~19-10) ──► Gate B, EXP-1 stage 2, durability term of U
```

## Explicitly not planned

- No composite "intelligence score" (§16.14).
- No fine-tuning until the SOUP threshold is met (≥ 300 stored rows, ≥ 200 tasks, ≥ 100 failures, file-split holdout ≥ 100).
- No new agent topologies, agent factory or evolutionary swarms until CIA cells 1–3 show positive marginal value (CR F6–F8 gate).
- No acting change to promotion rules, gates or attribution from a measured result without a separate operator decision.
