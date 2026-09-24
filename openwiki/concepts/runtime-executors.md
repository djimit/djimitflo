---
type: runtime-architecture
title: "Agent Runtimes & Executor Adapters"
description: The ExecutorKind taxonomy, TaskExecutor/ExecutionSession contract, the eight always-registered CLI adapters plus the opt-in deep-agent runtime, the DockerSandboxExecutor wrapping isolation layer, and the circuit breaker + fallback chain that route executions across providers.
tags: [executors, executor-kind, task-executor, docker-sandbox, circuit-breaker, fallback-chain, skip-permissions, runtimes, opencode, codex, claude]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-24T19:59:50.419Z
sources:
  - id: openwiki-source-bb1ebe868e35e9e500714501
    resource: repo://Dockerfile
  - id: openwiki-source-dc2b84213983d9f4541aff1e
    resource: repo://packages/server/src/__tests__/docker-sandbox-executor.test.ts
  - id: openwiki-source-d62b61b355627cf10af6de72
    resource: repo://packages/server/src/__tests__/execution-engine.test.ts
  - id: openwiki-source-d77928939568025601f76bb2
    resource: repo://packages/server/src/execution/execution-engine.ts
  - id: openwiki-source-99861e0d575ab3b523c675ce
    resource: repo://packages/server/src/execution/executor-output.ts
  - id: openwiki-source-74b516a517202c2d66b1fc24
    resource: repo://packages/server/src/execution/executors/deep-agent-executor.ts
  - id: openwiki-source-5c4d39f74a55fb1a7927eaea
    resource: repo://packages/server/src/execution/executors/docker-sandbox-executor.ts
  - id: openwiki-source-7e38592c3e48faf34127be02
    resource: repo://packages/server/src/execution/executors/executor-env.ts
  - id: openwiki-source-a5ee7cd85d802e6d855cea8c
    resource: repo://packages/server/src/execution/executors/runtime-process.ts
  - id: openwiki-source-0ecf5370c0c64700498da232
    resource: repo://packages/server/src/execution/executors/structured-runtime-event.ts
  - id: openwiki-source-9c6ae5ef1182c548f8c5a898
    resource: repo://packages/server/src/execution/types.ts
  - id: openwiki-source-6f8d484158955a76b057d482
    resource: repo://packages/server/src/routes/swarm-knowledge.ts
  - id: openwiki-source-bd0aa237d1204fcb36b72c86
    resource: repo://packages/server/src/services/circuit-breaker-service.ts
  - id: openwiki-source-474208115b4c7f8ecf317d03
    resource: repo://packages/server/src/services/execution-mode-policy-service.ts
  - id: openwiki-source-c4bb7e048f7015721e621edf
    resource: repo://packages/server/src/services/fallback-chain-service.ts
generated: { by: "openwiki/0.5.2", at: "2026-09-24T19:59:50.419Z" }
---

# Agent Runtimes & Executor Adapters

The server executes tasks by adapting external agent CLIs behind one uniform contract.
`packages/server/src/execution/types.ts` defines the boundary — one `ExecutorKind`
taxonomy, one `TaskExecutor` interface, one `ExecutionSession` handle — and the
`ExecutionEngine` registers, selects, guards, and supervises every implementation.
Everything the rest of the system knows about a run (events, result, failure
classification, cancellation) flows through these types, so adding a new runtime means
implementing the contract and registering it, not touching the orchestration spine.

## ExecutorKind taxonomy and registration

`ExecutorKind` enumerates every runtime the server can name:

```ts
export type ExecutorKind =
  'mock' | 'opencode' | 'codex' | 'claude' | 'hermes' | 'gemini' | 'editor' | 'pi'
  | 'docker' | 'deep-agent' | 'custom';
```

The `ExecutionEngine` constructor always registers eight default executors — `mock`,
`opencode`, `codex`, `claude`, `hermes`, `gemini`, `editor`, `pi` — and registers
`deep-agent` only when the operator sets `DJIMIT_DEEP_ENABLED=true`, also creating the
`DeepAgentContractIssuer` at that point (execution-engine.ts, constructor).
`docker` is never registered standalone: it appears only as the `kind` reported by a
`DockerSandboxExecutor` that wraps another executor at dispatch time. `custom` is the
extension slot for out-of-tree implementations registered via
`registerExecutor(executor)`, which indexes by `executor.kind`.

Executors are keyed by `kind` in a `Map`, so re-registering a kind replaces the previous
adapter. Dispatchers pass the desired `executorKind` to `executeTask()`; the engine then
looks it up, checks `executor.canExecute(task)`, and routes through the pre-execution
governance spine described in
[Governance Pipeline](./governance-pipeline.md) before any process starts.

## TaskExecutor, ExecutionSession, and the result/failure contract

The adapter interface is deliberately small (`types.ts`):

- `kind: ExecutorKind` — identity used for registration, circuit-breaker state, and
  metadata.
- `start(task, options?) → Promise<ExecutionSession>` — spawn/admit the run and return
  a live handle. The engine, not the executor, holds admission policy.
- `canExecute(task) → boolean` — a cheap capability probe. CLI adapters return `true`;
  `deep-agent` uses it to enforce contract binding (below).
- `buildCommand?(task, options?) → { command, args }` — the exact CLI invocation. This
  optional method is what makes Docker sandbox wrapping possible: the sandbox needs to
  re-host the command without re-implementing argument construction.

`ExecutionSession` is the engine's live view of a run:

- `events: AsyncIterable<ExecutionEventCreateInput>` — a streaming event source. The
  engine's `processEventStream()` persists each event to `execution_events` and
  broadcasts it over WebSocket; a stream that outlives
  `EXECUTION_EVENT_STREAM_TIMEOUT_MS` (default 5 minutes) is truncated with a
  `STREAM_TRUNCATED` event.
- `result: Promise<ExecutionResult>` — resolves once with the terminal
  status (`completed` | `failed` | `cancelled`), captured stdout/stderr, an optional
  `ExecutionFailure`, artifacts, and metrics.
- `closed?: Promise<void>` — resolves only after the owned OS child *and its stdio
  streams* close. The engine awaits `closed` before handling results, retries, or
  cancels so a "finished" task never leaves a live provider process behind. This is
  why the CLI adapters register `runtimeProcessClosed(child)` immediately after spawn:
  exit/error alone do not imply stream closure.
- `cancel()`, and optional `pause()`/`resume()` — cancellation is mandatory, pause/resume
  is advertised but not currently implemented by the built-in adapters.

`ExecutionResult.failure` is an `ExecutionFailure` — `code`, `message`, plus two
safety-critical booleans: `retryable` (may the engine try another provider?) and
`sideEffectsPossible` (did the failure happen after the provider might have mutated the
world?). A thrown failure is carried as `ExecutionFailureError`. When the engine
normalizes an unknown error it sets `retryable` by matching the message against a
provider-transient regex (`timeout | ECONN | 429 | 5xx | rate limit | exit code …`) and,
crucially, forces `retryable=false` whenever `sideEffectsPossible` is true:
`nextRetryExecutor()` refuses any retry if `attempt >= maxRetries`, `!failure.retryable`,
or `failure.sideEffectsPossible`.

## The default adapters

All eight always-on adapters implement `TaskExecutor` by spawning a CLI with
`stdio: ['ignore','pipe','pipe']`, parsing stdout into `ExecutionEventCreateInput`s, and
deciding the final result from exit code (with structured-event awareness where the CLI
provides it). They differ in binary, argument surface, and parsing strategy:

| Kind | Binary (env override) | Skip-permissions flag | Notes on CLI contract |
|---|---|---|---|
| `mock` | — (in-process) | — | Deterministic fake event stream for tests and `docker`-free development. |
| `opencode` | `opencode` (`OPENCODE_BIN_PATH`) | `--auto` | `run [--format json] [--dir] [--model] [--agent]`; NDJSON `step-start`/`tool`/`text`/`step-finish` with nested `part`; collects tokens/cost per `step_finish`. |
| `codex` | `codex` (`CODEX_BIN_PATH`) | `--dangerously-bypass-approvals-and-sandbox` | `exec [--json] [--cd] [--model] [-c model_reasoning_effort=…] [--sandbox]`; accepts `thread/turn/item.*` NDJSON plus legacy `step-*`/`tool`/`text`. |
| `claude` | `claude` (`CLAUDE_BIN_PATH`) | `--dangerously-skip-permissions` | `-p <prompt> --output-format json`; line-JSON then heuristic fallback. Worktree comes from spawn `cwd` (no `--cd`). |
| `hermes` | `hermes` (`HERMES_BIN_PATH`) | `--yolo` | Uses the programmatic `chat -q <prompt> --oneshot --quiet` surface instead of `hermes -z`, because `-z` bypasses approvals entirely — Djimitflo stays the approval boundary. |
| `gemini` | `gemini` (`GEMINI_BIN_PATH`) | `-y` | `-p <prompt> -o json [-m <model>]`; same line-JSON + heuristic pattern as Claude. |
| `editor` | `cline` (`CLINE_BIN_PATH`) | `--auto-approve true` | `editor` is the runtime name; the binary is `cline`. Worktree via `-c`. |
| `pi` | `pi` (`PI_BIN_PATH`) | `--no-approve` (default on via `PI_NO_APPROVE`) | `pi --mode json -p --no-session`; NDJSON `session`/`agent_start`/`tool_execution_*`/`turn_end`. Pi has no permission popups — djimitflo's policy engine is the sole boundary, so `PI_TOOLS`, `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` matter for sensitive runs. |

Every CLI adapter shares the same runtime-plumbing helpers:

- `runtime-process.ts` — `runtimeProcessClosed()` records the `close` promise per child
  in a `WeakMap`; `stopRuntimeProcess()` sends `SIGTERM`, escalates to `SIGKILL` after
  5 s, and resolves only when the process actually closes (so cancel/timeout never leak
  a half-dead child).
- `executor-env.ts` — `buildExecutorEnv()` builds the child environment from an
  allowlist (`PATH`, locale, `*_API_KEY`, model vars, `*_BIN_PATH`, …) plus
  `RUNTIME_ENV_PASSTHROUGH` extras, so server secrets never reach spawned CLIs by
  default.
- `captureExecutorOutput()` — keeps a rolling 5 MiB tail of stdout/stderr for the final
  result even when events were streamed incrementally.
- `structured-runtime-event.ts` — a shared normalizer that maps `tool_use`/`tool_result`
  /error/text-shaped JSON chunks from `claude`, `gemini`, `editor`, `codex`, `opencode`,
  and `pi` into `TOOL_CALL` / `TOOL_RESULT` / `ERROR` / `LOG` execution events with
  token-usage metadata when present.

Per-executor env vars (`<RUNTIME>_EXECUTION_TIMEOUT_MS`, `<RUNTIME>_SKIP_PERMISSIONS`,
`<RUNTIME>_OUTPUT_FORMAT`, model vars such as `DJIMITFLO_CODEX_MODEL` /
`DJIMITFLO_CLAUDE_MODEL`) configure the adapter at construction; per-call
`ExecutorOptions` override them.

## DockerSandboxExecutor: a wrapping isolation layer

`DockerSandboxExecutor` is **not** a runtime itself — it takes an *inner* `TaskExecutor`,
asks it for its `buildCommand()` invocation, and re-hosts that invocation inside a
throwaway Docker container. The engine creates it in `startExecutionAttempt()` when
`task.metadata.sandbox.enabled === true`, overriding image/cpu/memory/network/bind-mounts
from `sandbox.*` metadata on top of `DEFAULT_SANDBOX_CONFIG`. It reports `kind: 'docker'`
regardless of the wrapped executor, delegates `canExecute` to the inner executor, and
requires the inner to implement `buildCommand` — otherwise it fails closed with
`DOCKER_SANDBOX_INNER_COMMAND_UNAVAILABLE`.

Security invariants (all asserted by `docker-sandbox-executor.test.ts`):

- **Non-root user** — `--user 1000:1000` by default (`DOCKER_SANDBOX_USER`).
- **Drop all Linux capabilities** — `--cap-drop ALL`.
- **`no-new-privileges`** — enforced via `--security-opt no-new-privileges:true`.
- **Read-only root filesystem** + a bounded **`tmpfs` `/tmp` (64 MiB)**.
- **Network isolation by default** — `networkMode: 'none'` (`DOCKER_NETWORK_MODE`),
  with `bridge`/`host` opt-in.
- **Resource limits** — `--cpus` (`DOCKER_CPU_LIMIT`, default `1.0`) and `--memory`
  (`DOCKER_MEMORY_LIMIT`, default `512m`).
- **Digest-pinned image required** — `config.image` must contain `@sha256:`.
  `ensureImageIntegrity()` throws with remediation instructions unless the operator
  explicitly sets `DOCKER_SANDBOX_SKIP_DIGEST_CHECK=true` (logged warning; **not
  recommended for production**, since tag mutability is a supply-chain hole). Set
  `DOCKER_SANDBOX_IMAGE` to the pinned digest.
- **Automatic cleanup** — `docker run --rm` plus an explicit `docker rm -f` on
  completion/cancel; a `DOCKER_BIN_PATH` override locates the CLI.

Before starting, `start()` probes `docker --version` and fails with
`DOCKER_SANDBOX_UNAVAILABLE` if the daemon/CLI is absent. The host working directory is
bind-mounted `rw` at `/workspace` and the inner command is rebuilt with
`workingDirectory: '/workspace'`, so the inner adapter produces paths valid inside the
container. A wall-clock timeout (`DOCKER_TIMEOUT_MS`, default 10 min) terminates the
container with `SIGTERM` → `SIGKILL` after 5 s, resolving to exit code `124`.

Deep-agent tasks refuse sandboxing outright: sandboxing for `deep-agent` is controlled by
its sovereign runtime, not by djimitflo wrapping it in Docker.

## deep-agent: the opt-in contract-gated runtime

`DeepAgentExecutor` is registered only when `DJIMIT_DEEP_ENABLED=true`. Unlike the CLI
adapters it is gated on an explicit signed contract, not on task text:

- `canExecute(task)` — true only if `task.metadata.deep_agent_contract` exists, its
  `identity.task_id` equals this task, and its capabilities specify the
  `no-tool-canary` profile. `start()` throws `DEEP_AGENT_CONTRACT_INVALID_FOR_TASK`
  otherwise. The engine adds this contract at admission time via
  `DeepAgentContractIssuer.issue(parsedTask, dispatcherId)` and immediately strips it
  from the durable task metadata so the contract is per-attempt provenance.
- **Two transports**:
  - *Local*: spawns `<runtimeRoot>/.venv/bin/python -m djimit_deep run-no-tool` under
    `DJIMIT_DEEP_RUNTIME_ROOT`, feeding the contract over stdin
    (Ed25519-verified via `DJIMIT_DEEP_FEDERATION_PUBLIC_KEY`, or the canary key).
  - *Remote*: POSTs the contract to `DJIMIT_DEEP_URL` + `/v1/execute`, but only if the
    URL is an HTTP **loopback or literal Tailscale IPv4 origin** — anything else throws.
    Responses are capped at 1 MiB.
- **Fails closed**: non-zero exit, timeout, oversized response, or an unparseable final
  status yields `status: 'failed'` with `Contract-gated Deep Agents canary failed closed`.
- **Never falls back and never gets fallback**: the engine refuses a fallback when the
  breaker is open on `deep-agent`, and `nextRetryExecutor()` returns `null` for a failed
  deep-agent attempt — a contract-gated run is intentionally terminal.

## skip-permissions: operator-armed final boundary

Individual CLI flags (`--auto`, `--dangerously-bypass-approvals-and-sandbox`,
`--yolo`, `--auto-approve true`, `--dangerously-skip-permissions`) remove the provider's
own approval prompts. That power is guarded twice:

1. Per-executor env defaults (`OPENCODE_SKIP_PERMISSIONS`, `CODEX_SKIP_PERMISSIONS`,
   `CLAUDE_SKIP_PERMISSIONS`, `CLINE_SKIP_PERMISSIONS`, `GEMINI_SKIP_PERMISSIONS`).
2. **The final-boundary guard** — `resolveExecutorSkipPermissions(requested)` in
   `execution-engine.ts`:

```ts
return requested === true && process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS === 'true';
```

   A task may *request* `metadata.skipPermissions = true`, but the engine only forwards
   `skipPermissions: true` to the adapter when the **operator** set
   `RUNTIME_ALLOW_SKIP_PERMISSIONS=true`. This guard lives at the executor boundary so
   direct task execution cannot accidentally enable an unsandboxed CLI even when task
   metadata asks for it — **never bypass it in new code.**

## Circuit breaker and fallback chain

Provider resilience is split across two services:

**`CircuitBreakerService`** keeps per-`ExecutorKind` state machine:
`CLOSED` → `OPEN` → `HALF_OPEN` → `CLOSED`.
- `recordFailure` opens the circuit after `CIRCUIT_BREAKER_THRESHOLD` consecutive
  failures (default 3) inside a 60 s sliding window.
- While `OPEN`, `canExecute(kind)` returns `false` until
  `CIRCUIT_BREAKER_RECOVERY_MS` (default 30 s) elapses, then one probe is allowed in
  `HALF_OPEN`.
- `recordSuccess` in `HALF_OPEN` needs 2 consecutive successes to close again.
- The engine records failures on spawn/admission errors and on `failed` results, and
  successes on `completed` results — so the breaker reflects what the provider did, not
  the final task outcome.

**`FallbackChainService`** maps each `ExecutionMode` (`fast` | `standard` | `controlled` |
`restricted`) to an ordered provider list — `standard`, for example, tries
`claude → codex → gemini`, while `restricted` is `claude` only. `getNextAvailable()`
walks the chain after the current kind, skipping breakers that are open. Custom chains
can be injected via the constructor or `setChain()`.

`maxRetries` comes from `ExecutionModePolicyService` per mode (`fast:1`, `standard:2`,
`controlled:3`, `restricted:0`), so even a retryable failure does not chain-hop in
`restricted` mode. Fallbacks are themselves re-admitted through the policy gate
(`fallbackAdmitted`) before they start, and every hop is persisted as a `Retrying with
fallback executor <kind>` event carrying `failureCode`, `failureDomain`, `retryable`,
and `sideEffectsPossible`.

## Production worker surface and readiness

The production Dockerfile pins the two provider CLIs the server accepts for
non-mock production runs — `npm install --global @openai/codex@0.146.0
opencode-ai@1.18.10` — and verifies them at build time (`codex --version`,
`opencode --version`). At runtime the operator-facing probe is
`GET /swarms/runtime-readiness[?runtime=…]` which:

- only treats `codex` and `opencode` as production runtimes (others are blocked with
  `non_mock_supported_runtime_required`),
- checks the loop runtime contracts for binary availability/version,
- verifies provider credentials (`OPENAI_API_KEY`/`CODEX_API_KEY` or a live
  `codex login status` for codex; `DJIMITFLO_OPENCODE_MODEL` plus opencode config for
  opencode), and
- reports `ready` / `blocked_reasons` per runtime without starting any worker
  (`starts_workers: false`).

This keeps the deployable surface equal to what the `/swarms/runtime-readiness` contract
accepts: pinned, probed, certified runtimes rather than whatever happens to be on `PATH`.

## Related pages

- [Governance Pipeline](./governance-pipeline.md) — the policy/approval spine every
  executor start passes through.
- Security model — operator-armed skip-permissions, env allowlists, and runtime
  container isolation (see `/openwiki/concepts/security-model.md`).
- Configuration reference — the `*_BIN_PATH`, `*_EXECUTION_TIMEOUT_MS`, `DOCKER_*`,
  and `RUNTIME_*` env vars enumerated here.
- Test strategy — the executor contract tests under `packages/server/src/__tests__/`.
- Task execution lifecycle — how `executeTask()` reaches `startExecutionAttempt()`.
