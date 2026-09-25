# Nested Swarm Control Loop (L1–L4 MVP)

## Why

Djimitflo had a nested-spawn control plane on paper — `NestedSpawnService`, spawn trees, depth/budget/cycle gates — but the actual loop a spawned runtime child follows was structural, not real. A "nested" child never called back over HTTP to spawn its own sub-agent; the mock runtime only echoed. The control loop, the per-depth budget ceiling, and the token-or-user auth gate were unverified end-to-end, and the only loop runtimes were `mock`, `codex`, and `opencode`. Under parallel test load the proof-run path also surfaced an intermittent bare `500` from a shared `git worktree.lock` race.

This change makes the nested-spawn control loop genuinely functional and observable, hardens the flake deterministically, and extends the loop runtime fleet with `claude`, `gemini`, and `editor` (the `cline` autonomous editor-agent) — all behind the same default-deny security gates as `codex`/`opencode`. It also delivers L4 skill injection: a spawned child receives its validated capability manifest as read-only env metadata.

## What Changes

- **L1 — real HTTP control loop:** a spawned runtime child reads `DJIMITFLO_CONTROL_URL` + a per-child scoped `DJIMITFLO_SPAWN_TOKEN` + its lease/tree/depth identity from its env (injected by `LoopService.buildNestedSpawnEnv`) and does a real HTTP `POST /api/swarms/spawns` to spawn a sub-agent, then polls that child's status. The mock runtime became this real control-loop client (self-spawn is best-effort and non-fatal; the spawn-tree ledger is the proof).
- **L2 — per-depth budget ceiling:** each spawned child gets a bounded token/wall grant capped per depth (`SPAWN_PER_DEPTH_TOKEN_CAP` / `SPAWN_PER_DEPTH_WALL_CAP_MS`) inside the tree-wide `total_token_budget` / `total_wall_budget_ms` hard bound; the depth floor (`depth < depth_budget`) arms `allow_nested_spawn` cooperatively, with a `depth_budget_exceeded` backstop gate for non-cooperative runtimes.
- **L3 — token-or-user auth:** the spawn routes accept EITHER a user JWT OR a scoped spawn token (`requireAuthOrSpawnToken`); a token-only child can `POST /spawns` but cannot `POST /spawns/root` (operator-only via `write:swarm_action`).
- **L4 MVP — skill injection:** `LoopService.buildCapabilityManifest` serializes only LIVE capabilities (server-side gated, `live_route_allowed`) into a compact JSON manifest, injected as `DJIMITFLO_CAPABILITIES` in the child env and written into the assignment packet. Read-only metadata — it grants the child no new authority.
- **L4 MVP — new loop runtimes:** `claude`, `gemini`, `editor`(=`cline`) added to `buildRuntimeCommand`, `getRuntimeContract` (generalized probe table), `getRuntimeContracts()`, fleet pools, the spawn `VALID_RUNTIMES` set, and the scheduler/tick runtime unions. `skipPermissions` toggles `claude --dangerously-skip-permissions` / `gemini -y` / `cline --auto-approve true`, armed only via `RUNTIME_ALLOW_SKIP_PERMISSIONS=true` (default-deny, identical to `codex --dangerously-bypass-approvals-and-sandbox`).
- **Flake hardening:** `createWorktree` gained bounded retry (3 attempts, backoff) on git lock errors; `proof-run-service` test isolates `repository_path` to a per-test temp git repo + per-test `LOOP_WORKTREE_ROOT`/`LOOP_EVIDENCE_ROOT`; `mapProofRunError` maps `PROOF_RUN_RUNTIME_FAILED` → a stable `503` (not a bare `500`).

## Out Of Scope

- **L4 part 2 — discussion protocol** (`message_threads` + `thread_messages` + turn scheduler): deferred to a later change.
- **`ExecutionEngine` (tasks path) executors** for `claude`/`gemini`/`cline`: not extended this round; only the loop/lease path gained the new runtimes.
- **`proof-run-service` runtime bridge** for the new runtimes: proof runs stay `mock`/`codex`/`opencode` this round.
- **Real-CLI smoke runs** of `claude`/`gemini`/`cline` (token cost/time): manual/optional; the suite uses fake binaries.

## Success Criteria

- A mock root self-spawns a child over real HTTP, the child a grandchild, and the grandchild (at the depth floor) runs echo-only and exits 0 without spawning — all verified against real `worker_lease` / `sub_agent_spawns` rows.
- A control-plane outage is non-fatal: the mock exits 0, holds no runtime semaphore permit, and creates no child.
- A token-only child can `POST /spawns` (201) but cannot `POST /spawns/root` (401).
- A live capability bound to the root is injected into the maker env (`[mock-worker] capabilities=1`) and into the assignment packet.
- `claude`/`gemini`/`editor` runtime commands build the correct headless args (skip-permissions + model toggles) and their contracts probe available/drifted via fake binaries; a fake `claude` bin self-spawns a child over HTTP with `runtime: 'claude'`, proving a non-mock runtime follows the same control loop.
- `createWorktree` retries a git lock error then succeeds, and does not retry a non-lock error.
- `PROOF_RUN_RUNTIME_FAILED` maps to `503` with a stable code.
- The full suite is green deterministically across parallel and single-fork runs; `npm run type-check` and `npm run lint` are clean across all workspaces.