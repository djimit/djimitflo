# G79 — Persisted Astra runtime dispatch

The task creation path already persisted `metadata.executor`, `metadata.model` and Codex `metadata.reasoningEffort`. The execute route ignored the persisted executor whenever the API body omitted `executor`, silently defaulting to OpenCode. That made direct API execution diverge from the dashboard's selected runtime.

## Correction

`POST /api/tasks/:id/execute` now resolves runtime in this order:

1. explicit non-empty request override;
2. persisted task metadata executor;
3. safe `opencode` default.

Malformed metadata remains under ExecutionEngine validation and cannot introduce a new runtime. Explicit overrides remain auditable and unchanged.

## Proof

- HTTP fixture creates a task with `executor: codex`, `model: gpt-6-astra`, `reasoningEffort: max`, submits an empty execute body, and observes `executor: codex`, exactly one Codex attempt, and the selected model/reasoning options at the executor boundary.
- Existing engine regression proves persisted model/reasoning/sandbox metadata reaches the selected executor.
- Existing Codex regression proves `gpt-6-astra`, `model_reasoning_effort="max"` and workspace sandbox become the exact native CLI arguments.
- Focused dispatch/Codex/HTTP tests: 58 passed.
- Full server regression after correction: 2,429 passed / 20 skipped; integrated workspace run: 2,716 passed / 20 skipped.

This proves configuration-to-dispatch-to-CLI argument propagation, not a live Astra provider run, computer-use session, model quality, or universal ToolBroker mediation. Provider credentials and live deployment identity remain outside the local fixture.
