# G156 — expert swarm parallelism boundary

## Finding

`POST /api/swarms/expert/dispatch` passed `max_parallel` directly into `chunkArray`. A value of `0` made the loop increment by zero and could hang the request indefinitely; fractional, negative and non-numeric values also had undefined semantics.

## Correction

The HTTP boundary now requires an integer `max_parallel` between 1 and 10 and returns structured `400 VALIDATION_ERROR` before constructing or invoking the external expert swarm. The service repeats the invariant defensively for non-HTTP callers.

## Proof

`packages/server/src/__tests__/critical-http-contracts.test.ts` exercises `0`, `-1`, `1.5`, `NaN`, `null` and `11`; all return structured 400 responses. The focused suite passes 7/7 tests. The full workspace test run passes 2465 server tests/20 skipped, with catalog 26, dashboard 151, MCP 39, ransomware 40, shared 3 and Telegram 30. Build, type-check and lint pass.
