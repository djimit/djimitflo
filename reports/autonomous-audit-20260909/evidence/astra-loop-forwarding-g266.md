# G266 Astra loop forwarding

The existing Codex executor already accepts `model` and bounded `reasoningEffort`. G266 closes the loop boundary: `/loops/runs/:id/continue` and `/retry` validate explicit values before worktree creation, persist them on maker leases, and `LoopWorkerExecutorService` forwards them into the durable task metadata consumed by `ExecutionEngine`.

Evidence:

- `loop-routing-continuation.test.ts`: explicit `gpt-6-astra` + `max` persists on a lease; empty/oversized model and unsupported reasoning are rejected without leases/worktrees.
- `execution-engine.ts` validates the same metadata and passes it to `CodexExecutor`; no new executor or bypass was introduced.
- Focused loop/runtime suite: 153 passed, 2 skipped.

Selection remains explicit and governed. Advisory planning does not silently spend on Astra; callers choose `runtime: codex` and may provide model/reasoning.
