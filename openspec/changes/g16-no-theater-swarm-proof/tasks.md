# Tasks

## G16.1 Runtime Contract Repair

- [x] Fix CodexExecutor to use current Codex CLI flags: `exec --json --cd`.
- [x] Add `codex-executor.test.ts` covering JSON flag, working-directory flag, model flag, sandbox/approval options and timeout warning behavior.
- [x] Extract shared runtime contract probe used by loop-service and execution-engine.
- [x] Add contract fixtures for Codex available, Codex drifted, OpenCode available, OpenCode drifted and runtime unavailable.
- [x] Ensure runtime contract output includes command, version, required flags, status, reason, evidence and checked_at.

## G16.2 Enforcement Repair

- [x] Add canonical OKF/workspace root allowlist for OKF drift and sync.
- [x] Replace raw `okf_base` query with configured root id or allowlisted canonical path.
- [x] Replace broad `create:task` writes for capabilities, claims, governance, manifests and swarm actions with scoped permissions.
- [x] Require governance evaluation to resolve persisted refs instead of trusting request booleans for enforceable decisions.
- [x] Block direct public assertion of completed runner manifests.
- [x] Add typed claim predicate/object/scope fields and explicit `supports`, `refines`, `contradicts` relationships.
- [x] Add tests for OKF path escape, spoofed governance, spoofed runner manifest and same-subject non-contradiction.

## G16.3 OpenCode MCP And Skills Health

- [x] Add OpenCode config inspector for `opencode.jsonc`.
- [x] Detect missing `mcp`, `tools`, `agent` and `permission.skill` sections.
- [x] Run `opencode mcp list` with timeout and classify `ok`, `locked`, `unconfigured`, `unavailable` or `error`.
- [x] Add remediation text for `database is locked` that does not delete state automatically.
- [x] Add per-agent MCP exposure recommendations and avoid global heavy MCP enablement.
- [x] Add OpenCode skill permission scanner that produces capability candidates without activating skills.
- [x] Add tests for locked MCP DB output, missing config, per-agent enablement recommendation and credential-value redaction.

## G16.4 OpenAI Agent/Skill/MCP Capability Descriptors

- [x] Add capability descriptor kinds for OpenAI Agents SDK, OpenAI Skills and OpenAI MCP/connectors.
- [x] Require explicit approval and authorization refs for remote MCP/connectors.
- [x] Treat OpenAI hosted skills as privileged capability candidates until reviewed.
- [x] Add adapter boundary docs: local worker runtime remains Codex/OpenCode CLI until SDK runtime proof exists.
- [x] Add tests that OpenAI capability descriptors cannot route local workers without validated adapter proof.

## G16.5 Proof Run Service

- [x] Add `ProofRunService` or equivalent orchestration module.
- [x] Create proof run id and rollback group.
- [x] Register at least six capabilities: mock runtime, Codex runtime, OpenCode runtime, OKF skill, specialist profile, evidence harness.
- [x] Create one specialist panel with at least three reviews and dissent/evidence refs.
- [x] Create at least three typed claims, including one proposed, one supported and one review-required or contradicted.
- [x] Create one backlog item and one goal from the panel or claim evidence.
- [x] Create one loop run and at least two worker leases.
- [x] Execute maker/checker through mock runtime first.
- [x] Write trace spans, checkpoints, runner manifests and a governed memory candidate.
- [x] Attach proof-run metadata to every created record.

## G16.6 Proof Run API And CLI

- [x] Add authenticated `POST /api/swarms/proof-runs` to start a mock proof run.
- [x] Add authenticated `GET /api/swarms/proof-runs/:id` for status, counts, evidence refs and missing evidence.
- [x] Add authenticated `POST /api/swarms/proof-runs/:id/rollback` for demo-record rollback.
- [x] Add `npm run swarm:proof` or equivalent script that calls the API or service with safe defaults.
- [x] Add `npm run swarm:proof:rollback` or equivalent rollback command.
- [x] Ensure proof run auto-starts mock proof workers and creates rollback-scoped demo memory evidence; release actions remain explicit operator commands.

## G16.7 Mission Control Proof Output

- [x] Add proof-run summary section to Mission Control.
- [x] Show live counts versus required minimum counts.
- [x] Show latest proof-run id, status, runtime, created_at and rollback status.
- [x] Link to created goal, loop run, leases, claims, panel, traces, checkpoints, manifests and memory candidate.
- [x] Show missing evidence as blocking facts, not optimistic copy.
- [x] Add dashboard smoke test for proof section.

## G16.8 Live Workstation Proof Smoke

- [ ] Run database migration on workstation.
- [ ] Capture pre-run counts proving current zero-state for goals, loop runs, leases, capabilities, claims, manifests and panels.
- [ ] Run mock proof run.
- [ ] Capture post-run counts proving nonzero output across all required tables.
- [ ] Capture authenticated Mission Control API proof output.
- [ ] Capture dashboard screenshot or browser smoke evidence.
- [ ] Run rollback.
- [ ] Capture rollback counts for proof-run records.

## G16.9 Real Runtime Smokes

- [ ] Run bounded Codex proof smoke after mock proof passes.
- [ ] Run bounded OpenCode proof smoke after Codex proof passes.
- [ ] If either runtime blocks, record contract status and exact blocked reason.
- [ ] Store stdout/stderr/artifact refs, token usage parse result, wall-clock duration, trace spans and checkpoints.
- [ ] Keep real runtime smokes low-risk and non-mutating except temp worktree proof files.

## G16.10 Sellable Demo Pack

- [ ] Add runbook for demo flow: pre-counts, proof run, Mission Control, evidence graph, rollback.
- [ ] Add one-page product proof summary for reviewers.
- [ ] Include exact commands and expected output shapes.
- [ ] Include caveats: Ruflo is inspiration, registry is not execution, mock proof precedes real runtime.
- [ ] Include go/no-go checklist for external review.
