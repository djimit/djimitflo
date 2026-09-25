# G16 No-Theater Swarm Proof

## Why

The current workstation truth is useful but not sellable yet:

- 2 registry agents exist.
- 0 goals exist.
- 0 loop runs exist.
- 0 worker leases exist.
- 0 capabilities exist.
- 0 claims exist.
- 0 runner manifests exist.
- 0 specialist panels exist.

That means Djimitflo has control-plane code, tests and OpenSpec plans, but the live workstation does not yet show a working swarm story. A customer, reviewer or external agent can reasonably say: "Where is the actual output?"

This change defines the next build as a proof-producing product slice. It fixes the concrete integration gaps found in review, then creates an accelerated live proof run that fills the missing state with auditable records and visible dashboard output. The result must be demonstrable without claiming prepared leases, registry agents or plans are active execution.

## What Changes

- Fix Codex CLI contract drift in the legacy executor path and add focused tests.
- Centralize runtime contract probing for Codex, OpenCode and mock so loop-service and execution-engine agree on supported flags.
- Repair G15 enforcement foundations: OKF root allowlist, scoped write permissions, unspoofable governance refs, runner-owned manifests and typed claim relationships.
- Add an OpenCode MCP/skills health path that detects local database lock, config gaps, per-agent MCP exposure and skill permission state without persisting credential values.
- Add optional OpenCode SDK integration for server/session/file/event inspection when available; keep CLI execution as the worker path until SDK execution semantics are explicitly proven.
- Add optional OpenAI Agents/Skills/MCP capability descriptors so Djimitflo can reason about OpenAI-hosted skills and MCP/connectors without pretending they are local workers.
- Add a live swarm proof-run command and API path that automatically creates rollback-scoped demo records:
  - capability contracts
  - specialist panel and reviews
  - typed claims
  - backlog item
  - goal
  - loop run
  - maker/checker leases
  - mock worker/checker execution
  - trace spans
  - checkpoints
  - runner manifests
  - memory candidate
  - dashboard proof snapshot
- Add a rollback path that deletes only proof-run records by `proof_run_id`.
- Add Mission Control proof cards that show live counts, latest proof-run id, runtime evidence and blocked/allowed decisions.

## Out Of Scope

- Release actions such as merge, push and deploy are not part of the proof runner; they require an explicit operator command.
- The proof runner may auto-start mock workers and auto-create operational demo memory evidence.
- Policy memory is outside the operational demo-memory promotion path.
- Credential values, cookies, password stores and provider tokens are not persisted.
- No claim that Ruflo bridge agent count is Djimitflo active execution.
- No claim that OpenAI Agents SDK or OpenCode SDK has replaced the local Codex/OpenCode worker adapters until a real adapter proof exists.

## Success Criteria

- OpenSpec validates strictly.
- Goal batch dry-run emits ordered G16 goals with dependencies and accelerated proof policy.
- CodexExecutor uses current local Codex flags and has tests.
- Runtime contract probe reports Codex and OpenCode status from actual binaries or explicit unavailable/drift reasons.
- OKF path escape, spoofed governance, spoofed runner manifest and claim false contradiction tests fail before the fix and pass after.
- OpenCode MCP health reports `ok`, `locked`, `unconfigured` or `unavailable` with remediation and without persisted credential values.
- Live proof run produces nonzero visible state:
  - `goals >= 1`
  - `loop_runs >= 1`
  - `worker_leases >= 2`
  - `swarm_capabilities >= 6`
  - `swarm_claims >= 3`
  - `swarm_runner_manifests >= 4`
  - `specialist_panels >= 1`
  - `specialist_reviews >= 3`
  - `work_items >= 1`
  - `memory_candidates >= 1`
  - `agent_trace_spans >= 4`
  - `loop_checkpoints >= 2`
- Live Mission Control shows the same proof-run id and counts through authenticated API and dashboard.
- Proof-run rollback returns those proof-run counts to zero without touching unrelated records.
