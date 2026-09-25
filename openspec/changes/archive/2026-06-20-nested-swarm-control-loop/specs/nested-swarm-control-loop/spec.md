## ADDED Requirements

### Requirement: A spawned runtime child follows a real HTTP control loop

Djimitflo SHALL arm a spawned runtime child with a per-child scoped spawn token and a control URL so it can spawn its own sub-agents by calling back to the server over HTTP, not by an in-process shortcut.

#### Scenario: The child env carries the control identity

- **WHEN** `LoopService` executes a nested-spawn-armed maker lease
- **THEN** the spawned process env contains `DJIMITFLO_CONTROL_URL`, a scoped `DJIMITFLO_SPAWN_TOKEN`, `DJIMITFLO_LEASE_ID`, `DJIMITFLO_SPAWN_TREE_ID`, and `DJIMITFLO_DEPTH`
- **AND** the token is minted from a shared HMAC secret and scoped to that lease and spawn tree

#### Scenario: A child self-spawns a sub-agent over HTTP

- **WHEN** an armed runtime child calls `POST /api/swarms/spawns` with its spawn token
- **THEN** the server prepares a real `worker_lease` row with the correct `parent_lease_id`, `spawn_tree_id`, and `depth`
- **AND** returns the child lease id to the caller

#### Scenario: A control-plane outage is non-fatal

- **WHEN** the control URL is unreachable or returns a non-2xx response
- **THEN** the runtime child logs the failure and exits 0
- **AND** does not hold a runtime semaphore permit and does not create a child

### Requirement: Spawn depth and budget are bounded per depth and per tree

Djimitflo SHALL enforce a depth floor and a tree-wide hard budget with a per-depth ceiling so a spawn tree cannot run away in depth, tokens, or wall time.

#### Scenario: The depth floor disarms the leaf child

- **WHEN** a child is prepared at `depth == depth_budget`
- **THEN** `allow_nested_spawn` is false
- **AND** a cooperative runtime runs echo-only, exits 0, and creates no great-grandchild

#### Scenario: A non-cooperative runtime is gated at the floor

- **WHEN** a non-cooperative runtime attempts a `depth + 1` spawn beyond `depth_budget`
- **THEN** the server rejects it with a `depth_budget_exceeded` gated-out response
- **AND** that is a legitimate terminal state, not a worker failure

#### Scenario: Each child receives a bounded grant

- **WHEN** a child is prepared
- **THEN** its token and wall grants are capped per depth by `SPAWN_PER_DEPTH_TOKEN_CAP` / `SPAWN_PER_DEPTH_WALL_CAP_MS`
- **AND** the cumulative tree consumption stays within `total_token_budget` / `total_wall_budget_ms`

### Requirement: Spawn authorization accepts a user JWT or a scoped spawn token

Djimitflo SHALL authorize spawn mutations with either a user JWT or a scoped spawn token, and SHALL keep root creation operator-only.

#### Scenario: A token-only child can spawn but not create a root

- **WHEN** a caller presents only a valid spawn token
- **THEN** `POST /spawns` is authorized (201)
- **AND** `POST /spawns/root` is rejected (401) because root creation requires the `write:swarm_action` permission

#### Scenario: Anonymous or malformed auth is rejected

- **WHEN** a caller presents no credential
- **THEN** the server returns 401 `AUTH_REQUIRED`
- **AND** when a caller presents a malformed bearer it returns 401 `AUTH_INVALID` without falling through to spawn-token auth

### Requirement: A spawned child receives its validated capability manifest as read-only metadata

Djimitflo SHALL deliver a spawned child's bound capabilities as a read-only manifest in its env and assignment packet, reflecting server-side gating and granting no new authority.

#### Scenario: Live capabilities are injected into the child env

- **WHEN** a lease is armed with `capability_ids` and the referenced capabilities are LIVE (`live_route_allowed`)
- **THEN** `buildNestedSpawnEnv` sets `DJIMITFLO_CAPABILITIES` to a JSON manifest of those capabilities
- **AND** the manifest contains only live capabilities with their `id`, `kind`, `owner`, `version`, `status`, `risk_ceiling`, `allowed_actions`, `forbidden_actions`, and `required_evidence`

#### Scenario: The assignment packet carries the manifest

- **WHEN** `writeAssignmentPacket` runs for an armed lease
- **THEN** the packet's `capabilities` field contains the same manifest
- **AND** a missing or non-live capability is silently skipped, not an error

### Requirement: The loop runtime fleet includes claude, gemini, and editor

Djimitflo SHALL support `claude`, `gemini`, and `editor` (the `cline` autonomous editor-agent) as loop runtimes with the same headless contract and security gates as `codex` and `opencode`.

#### Scenario: Headless commands are built per runtime

- **WHEN** `buildRuntimeCommand` builds a `claude` command
- **THEN** it emits `claude -p <prompt> --output-format json` and inherits the worktree as cwd
- **WHEN** `buildRuntimeCommand` builds a `gemini` command
- **THEN** it emits `gemini -p <prompt> -o json` and inherits the worktree as cwd
- **WHEN** `buildRuntimeCommand` builds an `editor` command
- **THEN** it emits `cline --json --auto-approve <bool> -c <worktree> --thinking <t> <prompt>`

#### Scenario: Approval/sandbox bypass is default-deny

- **WHEN** a maker/checker requests `skip_permissions`
- **THEN** the bypass flag (`--dangerously-skip-permissions` / `-y` / `--auto-approve true`) is added ONLY when `RUNTIME_ALLOW_SKIP_PERMISSIONS=true`
- **AND** otherwise the runtime runs without the bypass flag

#### Scenario: Runtime contracts probe available vs drifted

- **WHEN** `getRuntimeContract` probes a runtime binary
- **THEN** it runs `--version` and the runtime's help subcommand and marks the contract `ok` when the json, cwd, and headless flags are present
- **AND** marks it `drifted` with an actionable reason when a required flag is missing

#### Scenario: New runtimes are accepted by the spawn path

- **WHEN** a child is spawned with `runtime: 'claude'` (or `gemini` / `editor`)
- **THEN** the spawn route accepts it (it is in `VALID_RUNTIMES`)
- **AND** the prepared `worker_lease` records that runtime

### Requirement: Worktree creation is resilient to git lock contention

Djimitflo SHALL retry `git worktree add` on transient git lock errors before failing, and SHALL surface runtime/worktree failures as a stable error code.

#### Scenario: A git lock error is retried then succeeds

- **WHEN** `createWorktree` catches a lock-class git error (`worktree.lock` / `index.lock` / `another git process` / `File exists`)
- **THEN** it retries the same `git worktree add` up to a bounded number of attempts with backoff
- **AND** succeeds when the lock clears

#### Scenario: A non-lock error is not retried

- **WHEN** `createWorktree` catches a non-lock git error
- **THEN** it does not retry and throws `WORKTREE_CREATE_FAILED`

#### Scenario: A runtime/worktree failure maps to a stable 503

- **WHEN** a proof run fails with `PROOF_RUN_RUNTIME_FAILED`
- **THEN** the route returns `503` with the `PROOF_RUN_RUNTIME_FAILED` code
- **AND** does not return a bare `500 INTERNAL_ERROR`

### Requirement: Discussions support ordered multi-round turns with a computed-on-read next speaker

Djimitflo SHALL extend the `discussions` substrate with ordered, multi-round turns and a computed-on-read next-speaker selector that returns a hint only and spawns nothing.

#### Scenario: An ordered turn is appended to an open discussion

- **WHEN** a participant calls `POST /api/discussions/:id/turns` with `agent_id` and `content`
- **THEN** a turn row is created with a monotonic `turn_index`, `status = 'open'`, and the discussion's WS clients receive `DISCUSSION_TURN_ADDED`
- **AND** a turn from a non-participant is rejected (403) when `metadata.participants` is non-empty

#### Scenario: Only one open turn is pending at a time

- **WHEN** a participant appends a turn while another turn is still `open`
- **THEN** the append is rejected with `OPEN_TURN_PENDING`
- **AND** a reply (`parent_turn_id`) is allowed only to a committed turn

#### Scenario: The next speaker is computed on read via round-robin

- **WHEN** an operator calls `POST /api/discussions/:id/tick` (gated by `write:swarm_action`)
- **THEN** the response returns `next_agent_id = participants[committedTurnCount % len]` and `awaiting_commit = true` while a turn is open
- **AND** committing a turn via `PATCH .../turns/:turnId` broadcasts `DISCUSSION_TURN_COMMITTED` and advances the next-speaker selection on the following tick

### Requirement: The tasks path supports claude, gemini, and editor executors

Djimitflo SHALL register `claude`, `gemini`, and `editor` (the `cline` autonomous editor-agent) as `ExecutionEngine` executors that inherit the existing tasks-path gates and the established spawn/parse contract.

#### Scenario: Headless executors are registered and inherit tasks-path gates

- **WHEN** `ExecutionEngine` starts
- **THEN** `claude`, `gemini`, and `editor` executors are registered via the open/closed `registerExecutor` map (no switch)
- **AND** `executeTask` for those kinds passes through the same `execute:task` permission, risk classifier, and approval-policy gates as `opencode` and `codex`

#### Scenario: Executor argv matches the proven loop-runtime shapes

- **WHEN** `ClaudeExecutor.buildClaudeArgs` builds a command
- **THEN** it emits `claude -p <prompt> --output-format json` with `--dangerously-skip-permissions` only when armed
- **WHEN** `GeminiExecutor.buildGeminiArgs` builds a command
- **THEN** it emits `gemini -p <prompt> -o json` with `-y` only when armed
- **WHEN** `EditorExecutor.buildEditorArgs` builds a command
- **THEN** it emits `cline --json --auto-approve <bool> -c <worktree> --thinking <t> <prompt>`

#### Scenario: A fake-binary executor run completes on exit 0

- **WHEN** `start()` is invoked against a fake binary that exits 0
- **THEN** the executor emits `TASK_STARTED` and `TASK_COMPLETED` events and yields a `completed` result
- **AND** the skip-permissions / model toggles are controlled by the per-executor env gate, not the loop path's runtime allowlist