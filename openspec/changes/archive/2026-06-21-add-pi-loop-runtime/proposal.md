## Why

Pi is currently reachable only via the *manual* `executeTask` API path
(`/api/tasks/:id/execute` → `PiExecutor`). Djimitflo's real execution plane is the
`LoopService` fleet: worker leases, worktree isolation, maker/checker, budgets,
gates, spawn tokens, nested-spawn lineage, and `runtime` dispatch via
`buildRuntimeCommand`/`executeRuntimeCommand`. The loop `runtime` union is
`codex | opencode | claude | gemini | editor | manual | mock` — **`pi` is absent**,
so a loop run cannot request Pi as its runtime. Pi therefore bypasses the fleet
infrastructure (leases, semaphore, gates, maker/checker) that the other runtimes use.

This change makes Pi a first-class **one-shot, per-lease execution-plane runtime**,
consistent with how codex/opencode already work — no new transport, no persistent
process, no SDK embedding.

## What Changes

- **Loop runtime union**: add `'pi'` to the `runtime` literals in `LoopService`
  (`packages/server/src/services/loop-service.ts` lines ~152/157/186/206) and the
  `RuntimeContract` `runtime` field.
- **Runtime contract**: `getRuntimeContract('pi')` probes the Pi binary
  (`PI_BIN_PATH`, default `pi`) and reports availability + status.
- **Runtime command**: a `'pi'` case in `buildRuntimeCommand(runtime, worktreePath,
  prompt, skipPermissions)` emitting `pi --mode json -p --no-session --no-approve
  --no-context-files --no-extensions --no-skills --offline --tools <PI_TOOLS>
  --provider <PI_PROVIDER> --model <PI_MODEL> <prompt>`, spawned with
  `cwd = worktreePath` (Pi uses the process cwd; file tools are cwd-scoped — the
  loop worktree is the isolation unit, no extra workingDirectory plumbing needed).
- **Shared helper**: extract `buildPiArgs` + `mapPiEvent` from `pi-executor.ts` into
  a shared module (`packages/server/src/execution/executors/pi-shared.ts` or
  `pi-args.ts`) used by **both** `PiExecutor` (manual path) and the loop runtime
  adapter. One source of truth for Pi flags + NDJSON→event mapping.
- **Token usage**: parse Pi `message.usage` from `runtime_stdout` into the worker
  lease/runtime metrics, matching codex/opencode's `usage_source: 'runtime_stdout'`.
- **Docs**: a `pi` row in the loop runtime docs / `docs/integrations.md` Pi section
  noting loop-runtime support.

## Non-Goals

- **No persistent Pi worker process** and **no `pi --mode rpc`**. Measured 2026-06-21:
  Pi startup is ~615 ms (~33 % of a small coding task) but overlaps under concurrency
  (4 parallel → 3.52× speedup), so it is **not** a loop-throughput bottleneck; the
  ceiling is the worker-concurrency budget and, at scale, ollama GPU. A worker pool
  would add a component to operate without lifting the ceiling.
- **No Pi SDK embedding** in djimitflo (would add a runtime dependency to the
  control plane). Pi stays an external child process.
- **No changes to codex/opencode/other runtimes.**
- **No mid-run steering/governance injection** in this change (that is a separate,
  capability-driven Phase if ever needed).
- **No new transport or protocol.** Reuse existing `executeRuntimeCommand` +
  stdout NDJSON.
- **No deprecation of the manual `PiExecutor` path** in this change (it stays; the
  shared helper keeps both consistent). De-preferencing it is a later cleanup.

## Success Criteria

- A loop run can request `runtime: 'pi'`; `assertRuntimeAvailable('pi')` passes when
  the Pi binary is present and fails with `RUNTIME_UNAVAILABLE` when not.
- A maker lease with `runtime:'pi'` spawns Pi in the lease's worktree, streams
  NDJSON events into the loop's event/trace handling, and records token usage from
  `message.usage` on the worker lease.
- Maker/checker separation, diff snapshot, risk classification, and audit/trace
  spans are populated identically to codex/opencode runs.
- A sovereign loop run (local Ollama, `PI_OFFLINE=1` + `PI_TELEMETRY=0` +
  `PI_SKIP_VERSION_CHECK=1`, `PI_TOOLS` without `bash`) completes with zero external
  egress and the artifact inside the worktree.
- `buildPiArgs`/`mapPiEvent` are shared by `PiExecutor` and the loop adapter (no
  duplicated Pi logic).
