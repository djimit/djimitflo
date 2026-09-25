# Tasks

## G17.1 Real HTTP Control Loop (L1)

- [x] Mint a per-child scoped spawn token in `LoopService.buildNestedSpawnEnv` (leaf module `services/spawn-token.ts`) and inject `DJIMITFLO_CONTROL_URL`, `DJIMITFLO_SPAWN_TOKEN`, `DJIMITFLO_LEASE_ID`, `DJIMITFLO_SPAWN_TREE_ID`, `DJIMITFLO_DEPTH`.
- [x] Make the mock runtime a real control-loop client: `POST /api/swarms/spawns` to self-spawn one sub-agent, then poll the child's status; best-effort and non-fatal.
- [x] Add an Express-backed e2e (`nested-spawn-loop.test.ts`) where a mock root self-spawns a child over HTTP and the child a grandchild; assert real `worker_lease` parentage/tree/depth and exactly two HTTP-spawned children.
- [x] Add a control-plane-outage e2e: point the control URL at a closed port, assert the mock exits 0, creates no child, and holds no runtime semaphore permit.

## G17.2 Per-Depth Budget Ceiling And Depth Floor (L2)

- [x] Grant each spawned child a bounded token/wall grant capped per depth (`SPAWN_PER_DEPTH_TOKEN_CAP` / `SPAWN_PER_DEPTH_WALL_CAP_MS`) inside the tree-wide hard bound.
- [x] Arm `allow_nested_spawn` cooperatively when `depth < depth_budget`; keep a `depth_budget_exceeded` backstop gate for non-cooperative runtimes.
- [x] Assert the depth-floor child is not armed, runs echo-only, exits 0, and creates no great-grandchild.

## G17.3 Token-Or-User Auth (L3)

- [x] Mount the spawn routes with `requireAuthOrSpawnToken` so a user JWT OR a scoped spawn token authorizes `POST /spawns`.
- [x] Keep `POST /spawns/root` operator-only via `write:swarm_action`; a token-only caller gets 401.
- [x] Add an e2e asserting token-only `POST /spawns` -> 201, no-header -> 401 `AUTH_REQUIRED`, malformed bearer -> 401 `AUTH_INVALID`, token-only `POST /spawns/root` -> 401.

## G17.4 Skill Injection (L4 MVP)

- [x] Add `LoopService.buildCapabilityManifest` that serializes only LIVE capabilities (`live_route_allowed`) as a compact JSON manifest, returning `undefined` when empty.
- [x] Inject `DJIMITFLO_CAPABILITIES` into `buildNestedSpawnEnv` and write a `capabilities` field into `writeAssignmentPacket`.
- [x] Log `[mock-worker] capabilities=<count>` in the mock runtime so injection is observable end-to-end.
- [x] Add an e2e: register a live capability, bind it to the root, execute the maker, assert the env line `capabilities=1` and the assignment packet carries the manifest.

## G17.5 New Loop Runtimes (L4 MVP)

- [x] Add `claude`, `gemini`, `editor`(=`cline`) branches to `buildRuntimeCommand` with the correct headless args and skip-permissions/model toggles.
- [x] Generalize `getRuntimeContract` with a probe table covering all five real runtimes; mark `drifted` when the json/cwd/headless flag is missing.
- [x] Extend `RuntimeContract.runtime`, `getRuntimeContracts()`, fleet pools, `runtimeCommandAvailable`, `WorkerRuntime`, `tickScheduler`/`preparePlannedWorkItems`, `RuntimeKind`/`VALID_RUNTIMES`, the spawn error message, `ExecutorKind`, and the loop input runtime unions.
- [x] Add commented `CLAUDE_BIN_PATH` / `GEMINI_BIN_PATH` / `CLINE_BIN_PATH` and per-runtime model placeholders to `.env.example`.
- [x] Add unit tests for the three `buildRuntimeCommand` branches and the `getRuntimeContract` available/drifted/unavailable probes via fake binaries.
- [x] Add a fake-`claude` self-spawn e2e proving a non-mock runtime follows the same control loop and the spawn route accepts `runtime: 'claude'`.

## G17.6 Flake Hardening

- [x] Add bounded retry (3 attempts, backoff) on git lock errors in `createWorktree`; re-throw `WORKTREE_CREATE_FAILED` only after retries exhaust.
- [x] Isolate `proof-run-service` tests: per-test temp git repo (`process.cwd()`), per-test `LOOP_WORKTREE_ROOT`/`LOOP_EVIDENCE_ROOT`.
- [x] Map `PROOF_RUN_RUNTIME_FAILED` -> stable `503` in `mapProofRunError`.
- [x] Add unit tests for `createWorktree` lock-retry-then-success, non-lock no-retry, and the 503 mapping.

## G17.7 Discussion Turn Protocol (L4 Part 2)

- [x] Add a `discussion_turns` table (ordered `turn_index`, nullable `parent_turn_id`, `status` CHECK `open|committed|superseded`, FK cascade) to `schema.ts` so it applies on every boot via `CREATE TABLE IF NOT EXISTS`.
- [x] Add `DiscussionTurnService` (`appendTurn`, `listTurns`, `computeNextTurn`, `setTurnStatus`) with computed-on-read round-robin next-speaker selection over `discussions.metadata.participants`.
- [x] Add turn routes to `routes/discussions.ts`: `POST /:id/turns` (`create:task`, broadcasts `DISCUSSION_TURN_ADDED`), `GET /:id/turns`, `POST /:id/tick` (`write:swarm_action`, returns the next-speaker hint only), `PATCH /:id/turns/:turnId` (`create:task`, broadcasts `DISCUSSION_TURN_COMMITTED` on commit).
- [x] Wire `wsService` into `createDiscussionRoutes` and add `DISCUSSION_TURN_ADDED` / `DISCUSSION_TURN_COMMITTED` to the `WebSocketEventType` enum.
- [x] Add a route + service test (`discussion-turns.test.ts`) covering append, non-participant refusal, one-open-turn gate, tick round-robin + awaiting-commit, commit/supersede transitions, reply threading, permission gating, and a `computeNextTurn` unit test.

## G17.8 Tasks-Path Executor Parity

- [x] Add `ClaudeExecutor`, `GeminiExecutor`, `EditorExecutor` (`cline`) classes mirroring `CodexExecutor` (bin/timeout/skip env, `spawn`, SIGTERM->5s->SIGKILL, NDJSON + heuristic-fallback parsing).
- [x] Build per-runtime argv reusing the proven `buildRuntimeCommand` shapes (`claude -p <prompt> --output-format json`, `gemini -p <prompt> -o json`, `cline --json --auto-approve <bool> -c <worktree> --thinking <t>`), with `--dangerously-skip-permissions` / `-y` / `--auto-approve true` gated by the per-executor `*_SKIP_PERMISSIONS` env.
- [x] Register the three executors in `ExecutionEngine` via the open/closed `registerExecutor` map (no switch); they inherit the existing `execute:task` + risk-classifier + approval-policy gates.
- [x] Add arg-shape tests for each executor plus one fake-bin smoke proving `start()` yields a `completed` result on exit 0.
