# Design

## Failure taxonomy

- retryable: provider unavailable, transport/network error, timeout.
- terminal: task/content failure, cancellation, policy denial, incompatible
  executor, exhausted budget and unknown errors.

## Attempt lifecycle

`ExecutionEngine` owns the lifecycle because it already owns task policy,
provider selection, circuit state, sessions, events and outcomes.

For each attempt it:

1. selects an available provider from the existing fallback chain;
2. checks `canExecute`;
3. reruns risk classification and policy evaluation;
4. starts the session;
5. records an attempt event;
6. waits for the result;
7. records circuit success only after a completed result;
8. retries only a classified provider failure while budget remains.

Existing `execution_events.metadata` is the durable attempt ledger. No schema
change is required.

## Analysis evidence

Self-analysis derives:

- route file imports;
- imported production service modules;
- test files importing each service;
- direct route tests importing each route factory.

The output remains heuristic and says so explicitly. It no longer equates
matching filenames with functional coverage.

## Removal

`OpenMythosRealEvaluator` and `ClaimService` have no production or test callers.
They are deleted. Canonical equivalents remain `OpenMythosEvalService` and
`SwarmEvidenceService`.
