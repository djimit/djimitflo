# ADR-001: Single policy decision path

Status: accepted.

`PolicyDecisionService` fed by `CommandRiskClassifier` is the only active policy-decision path. The unused `ToolBroker` class and its decision table writer were removed; `tool_broker_decisions` remains read-only historical data so existing audit evidence is not destroyed.

Deferred, named follow-ups:

- Default-deny unknown tool names before MCP catalog execution.
- Reusable, scoped capability tokens after a verified consumer exists.

Governance feedback may create approvals, but future dispatch must call `ExecutionEngine.executeTask`; direct process, spawn, or worktree dispatch is forbidden.
