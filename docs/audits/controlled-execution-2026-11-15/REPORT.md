# Controlled execution — interim delivery and evidence

## What DjimitFlo can demonstrably do on the examined source

At baseline `7758d153e415177de8e977721011c9675482934c`, the nested-spawn API can accept a request and persist a prepared/requested child record (E1 code evidence; local service tests E2). The candidate branch adds durable request idempotency, nested budget reservation separate from measured/unknown usage, preparation reconciliation and normal settlement projection for covered service paths (E2). The existing execute-worker API is present, but no ordinary consumer of prepared nested spawn records was found in the inspected source path. Therefore the full normal dispatch chain is not established.

The route inventory is generated and retained in `capability-matrix.json` and `route-contracts.json`; these describe static declarations and references, not observed execution. The frozen critical-chain denominator remains 8; 0/8 chains reached E3 in this bounded session. Scope, frozen scenarios and test limitations are in `scope.json`, `scenarios.json`, `critical-chain-assessment.json` and `verification.json`.

## Problems reproduced and candidate fix

The baseline regression run used `7758d153e415177de8e977721011c9675482934c` with only the two regression test files, test database helper and additive migration overlaid. It failed as expected: 10 failed, 17 passed. The candidate at `3bff1c0d14f224040df9d3c1daf357d80e5032dc` passed the same focused command: 2 files, 27 tests. See `evidence/baseline-spawn-red.txt`; exact test and overlay hashes plus commands are in `verification.json`.

The product fix is commit `e7baf39fdca9c7602cbf3644e7ffb11cc448c473` on the existing review branch / draft PR #1272. It keeps grant, reservation, measured usage and unknown usage semantically separate in the tested code path and makes repeated admission idempotent. The branch also projects normal nested lease settlement into the spawn view for tested cases. No production flags were changed. Draft PR: https://github.com/djimit/djimitflo/pull/1272. The audit package was pushed to this draft PR at head `44838961a1bb8096996ebf39664b3e2da2d3565c`. Exact-head CI and `djimitflo-review` were pending when checked; earlier green checks belonged to the previous head and do not validate this update.

## Claims by evidence level

- E1: route/service call graph, runtime/tool boundary and integration-source inspection; generated route and MCP inventory.
- E2: baseline-red/candidate-green isolated SQLite/fake-runtime tests (27 candidate tests).
- E3+: none in this session. No local server journey, real runtime, browser, host or production observation.
- Static inventory reported 596 routes; 551 have static test references; four critical routes are unclassified. It reported 61 MCP tools; 60 referenced; one noncritical tool unclassified. `assurance:contracts` and `assurance:route-contracts` exit nonzero on these gaps. A static reference is not test execution.

## Exact-head CI follow-up

The published PR head `b11b716c6b014d502d5edd6c7280d17667e2c837` failed the full test step in `ace-001.test.ts` on Node 22 and 24. The two failures reproduce locally on both this candidate and frozen `origin/main` `7758d153e415177de8e977721011c9675482934c`: test cases assumed `Date.now()` was before `ACE_001_STOP_BY`, but the registered stop time (`2026-11-15T00:00:00Z`) had passed. The implementation intentionally permits the readout at/after that deadline. I changed only those tests to pass `STOP_BY - 1ms` when asserting pre-readout withholding; the ACE implementation and experiment protocol were not changed. The corrected focused set passed 53/53; server typecheck passed and workspace lint passed with one pre-existing unused-eslint-disable warning. Exact-head full CI must rerun after pushing this test-only correction.

## Value, reliability, cost and time

The verified improvement is narrower failure-resistant admission/accounting behavior in the covered local tests; no change in user outcome, runtime reliability, latency, throughput or monetary/token cost was measured. Session token and cost telemetry were unavailable, so cost is unknown, not zero. No value-per-success ratio is calculable.

## Historical hypotheses

See `findings.json` for traceable statuses. Summary: H1 BEVESTIGD (prepared child dispatch gap); H2 and H3 GEWIJZIGD in candidate code with E2 evidence only; H4 BEVESTIGD as an executor-boundary gap; H5/H6 NIET VERIFIEERBAAR; H7 GEWIJZIGD (open PR/source changes, live poller status unknown); H8 NIET VERIFIEERBAAR (the builder sets synthetic/source metadata, but downstream continuity was not tested); H9 NIET VERIFIEERBAAR; H10 BEVESTIGD as a measurement gap, with no current net-value measurement. These statuses do not claim production failure or production behavior.

## Limits and the one action that removes each blocker

- Normal child dispatch (S1/H1): implement or identify an authorized dispatcher/admission consumer, then test through normal HTTP intake to execution and settlement. Do not auto-start prepared leases without the existing gates.
- Real-runtime collaboration (S12): operator must authorize a runtime and bounded model budget; after that run two workers on the normal route and independently check the joined artifact.
- Production and poller/DjimitSec status (S7/S15/S16): operator must authorize the named read-only probes or isolated integrations; no probe was performed here.
- Evolution/holdout (S13/S14/H5/H6): operator-only holdout and experiment prerequisites remain; this session did not open/register either.
- UI journey: run the existing app with a permitted test database and browser; not done.
- Route assurance gaps: assign and classify the four critical unclassified routes and one MCP tool, then rerun the generated assurance commands.

## Milestone judgments (proposed, not independently approved)

- A. Work iteration complete: **partially complete**. M0 preflight, frozen denominators and baseline revalidation are packaged; the scoped M1 nested-accounting/idempotency improvement has red/green E2 proof. Independent read-only verification remains pending.
- B. Functional objective proven: **not proven**. Normal full execution, independent checker, UI, runtime and production evidence are absent; 0/8 critical chains reached E3.
- C. Evolutionary improvement proven: **not proven**. No candidate/holdout/task transfer, retained version or rollback evaluation was run.

## First follow-up investment (best-supported)

**Close the normal nested dispatch chain before adding autonomy.** Missing capability: durable, policy-admitted dispatch of a prepared child through existing leases and `executeWorker`, with unambiguous ownership and no duplicate starts. Goal: make a delegated task submitted through the normal API either start under current gates or remain visibly prepared with a reason. Reuse `NestedSpawnService`, `LoopService`, `LoopWorkerExecutorService`, existing leases/outbox and Mission Detail. Smallest slice: first establish whether a current scheduler/daemon is intended to consume prepared nested rows; if none, propose the smallest opt-in admission hook without changing protected defaults. Baseline: prepared receipt with no normal dispatch. Measure: one normal HTTP request’s child lease/attempt state, exact artifact, independent checker receipt, reservation/usage settlement and UI projection; include duplicate request and crash-before-dispatch cases. Cost ceiling: existing local test budget only; no model calls or production action. Acceptance: one route-level journey reaches actual mock runtime start and verified result without direct worker function calls or DB writes; duplicate request does not duplicate lease/reservation. Stop if existing authority cannot be established. Rollback: feature flag default off; retain durable intents/evidence; no merge/deploy in this session. First files to inspect/change only after admission design is approved: `routes/spawns.ts`, `services/nested-spawn-service.ts`, existing scheduler/dispatcher consumer, `services/loop-service.ts`, Mission Detail projection and focused route tests.

Other follow-up investments, in priority order:

1. Verify runtime containment by executor: absent capability is concrete shell/filesystem/network enforcement evidence. Reuse existing executor policy and sandbox; no new framework. Baseline each runtime’s enforced boundary. Stop if it requires protected runtime-admission edits without explicit authorization. Rollback is revert of an isolated adapter change.
2. Preserve evidence provenance end-to-end: trace a synthetic row to explainer/export and keep source, synthetic flag, commit, freshness and method. Baseline is the existing serializer path; acceptance is a fixture assertion at final export, not merely at source. Use local fixtures only.
3. Improve loop/value observability through existing metric contracts: eligible-task denominator, delivered result, cost coverage and repeated/no-new-information status. Baseline from existing contract and local synthetic data. Do not change operator-owned thresholds.
4. Run one preregistered skill/memory evaluation only after operator opens the experiment and protected holdout process; baseline vs candidate on untouched tasks, exact hashes, failures included, independent judge and rollback. No cost or improvement claim before that.

See `CHECKPOINT.md` for exact resumption command and worktree state. No protected file, runtime flag, production resource or deployment was changed.
