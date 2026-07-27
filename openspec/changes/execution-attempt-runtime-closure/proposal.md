# Execution attempt runtime closure

## Problem

Provider fallback currently happens only when a circuit is already open before
execution. A provider that fails during `start()` or while producing its result
causes a final task failure even when the execution mode permits retries and a
fallback provider is available.

Separate cleanup gaps obscure the same runtime truth:

- `OpenMythosRealEvaluator` is an uncalled random simulator beside the canonical
  routed evaluator.
- self-analysis treats filenames as functional test coverage.
- `ClaimService` contains an unused, schema-divergent evidence graph copy.

## Outcome

1. `ExecutionEngine` performs bounded fallback attempts for retryable provider
   failures using the existing execution-mode retry budget.
2. Every fallback is rechecked against executor compatibility and task policy.
3. Attempts are recorded in existing execution events and trajectories.
4. Content rejection, policy denial, cancellation and restricted mode never
   trigger provider retry.
5. The legacy evaluator and unused ClaimService duplicate are removed.
6. Self-analysis reports route-to-service-to-test reachability rather than
   filename similarity.

## Non-goals

- No JudgeService dependency in recovery or provider selection.
- No new orchestrator, retry service, event bus, evidence table or graph store.
- No automatic deployment or production mutation.
