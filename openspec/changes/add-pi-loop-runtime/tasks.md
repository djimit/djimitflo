# Tasks

## Phase 0: Locate The Loop Runtime Seams (read-only)

- [x] T00.1 Confirm the exact `runtime` union sites in `loop-service.ts` (~152/157/186/206) and `RuntimeContract`.
- [x] T00.2 Confirm `buildRuntimeCommand(runtime, worktreePath, prompt, skipPermissions)` signature + how `executeRuntimeCommand` sets `cwd` (expect `worktreePath`), captures stdout, parses token usage, records `runtimePid`.
- [x] T00.3 Confirm `getRuntimeContract` probe pattern (cached, TTL) so the Pi probe matches codex/opencode.
- [x] T00.4 Confirm the worker-lease fields that carry runtime/token-usage so Pi populates them identically.

Validation:

- [x] The four union sites and the command/contract/usage seams are documented with line refs before editing.

## Phase 1: Shared Pi Args/Mapping Helper

- [x] T01.1 Extract `buildPiArgs(task, options)` + env resolution from `pi-executor.ts` into `packages/server/src/execution/executors/pi-args.ts` (or `pi-shared.ts`).
- [x] T01.2 Extract `mapPiEvent` (NDJSON → `ExecutionEventCreateInput`) into the same shared module.
- [x] T01.3 Refactor `pi-executor.ts` to import from the shared helper (no behavior change).

Validation:

- [x] `pi-executor.ts` behavior unchanged; existing manual-path end-to-end still completes.
- [x] `npm run build --workspace=@djimitflo/server` green.

## Phase 2: Loop Runtime Union + Contract

- [x] T02.1 Add `'pi'` to the `runtime` literals at the four `loop-service.ts` sites and to `RuntimeContract.runtime`.
- [x] T02.2 Implement `getRuntimeContract('pi')`: probe `PI_BIN_PATH` (default `pi`) via `--version`/`which`; report `available` + `status: 'ok'`; honor the cache TTL.

Validation:

- [x] `assertRuntimeAvailable('pi')` passes when binary present, throws `RUNTIME_UNAVAILABLE` when absent.
- [x] `getRuntimeContract('pi')` returns a cached contract consistent with codex/opencode shape.

## Phase 3: buildRuntimeCommand 'pi' Case + Dispatch

- [x] T03.1 Add the `'pi'` case in `buildRuntimeCommand` using the shared `buildPiArgs`-equivalent flags (`--mode json -p --no-session --no-approve --no-context-files --no-extensions --no-skills --offline --tools <PI_TOOLS> --provider <PI_PROVIDER> --model <PI_MODEL>`).
- [x] T03.2 Map `skipPermissions` to a Pi-appropriate behavior (Pi has no permission popups; `skipPermissions` is effectively always-true for the runtime — record this, do not gate on it; risk control stays via `PI_TOOLS` + djimitflo approval before lease).
- [x] T03.3 Ensure the spawn `cwd` is `worktreePath` (Pi runs cwd-scoped in the worktree).

Validation:

- [x] `buildRuntimeCommand('pi', wt, prompt, false)` returns `{command, args}` that run Pi headless against a local model in `wt`.
- [x] A manual call to the dispatch path spawns Pi and streams NDJSON.

## Phase 4: Token Usage + Event Mapping In The Loop Path

- [ ] T04.1 Parse Pi `message.usage` from stdout into the worker-lease runtime usage (`usage_source: 'runtime_stdout'`), matching codex/opencode.
- [ ] T04.2 Route Pi NDJSON events through the loop's event/trace-span handling using the shared `mapPiEvent`.
- [ ] T04.3 Verify maker/checker, diff snapshot, risk classification, and audit/trace spans populate for a Pi lease.

Validation:

- [ ] A completed Pi maker lease has token usage and trace spans recorded.
- [ ] Checker lease runs in its own worktree, never the maker's.

## Phase 5: Sovereign End-To-End Loop Run

- [ ] T05.1 Run a loop with `runtime:'pi'` against a local Ollama model, `PI_OFFLINE=1`/`PI_TELEMETRY=0`/`PI_SKIP_VERSION_CHECK=1`, `PI_TOOLS` without `bash`.
- [ ] T05.2 Verify zero external API egress during the run.
- [ ] T05.3 Verify the artifact lands in the worktree and the diff snapshot captures it.

Validation:

- [ ] Loop run completes sovereign with audit trail + evidence bundle.
- [ ] No external egress observed.

## Phase 6: Docs + Rollback Path

- [ ] T06.1 Update `docs/integrations.md` Pi section to note loop-runtime support.
- [ ] T06.2 Document that removing Pi = revert the union additions + the `buildRuntimeCommand`/contract cases + the shared helper (re-inline into pi-executor if desired).

Validation:

- [ ] Reverting Phase 1–3 changes restores prior loop behavior with no orphaned `'pi'` references.
