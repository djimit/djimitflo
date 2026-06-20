# Tasks

## Phase 0: CLI Contract Capture (HARD GATE — blocks all later phases)

> **DONE 2026-06-20** — live capture on workstation against Pi 0.79.8. Evidence: `docs/pi.md` + `evidence.md`. Open Questions resolved; the Codex-style event mapping assumption was corrected to Pi's real schema (session/agent_start/turn_*/message_*/tool_execution_*/agent_end).

- [x] T00.1 Install / locate the Pi binary on the workstation (`ssh workstation`).
- [x] T00.2 Capture `pi --help` and any subcommand help (`pi run --help`, `pi exec --help`, etc.) into `docs/pi.md`.
- [x] T00.3 Identify the headless / non-interactive invocation that accepts a prompt on stdin or as argv, suitable for a spawned child process.
- [x] T00.4 Determine structured output: does Pi emit NDJSON or a single JSON object? Capture at least three representative samples (a tool call, a text turn, a step finish) into `docs/pi.md`.
- [x] T00.5 Verify a working-directory flag (`--dir` / `--cd` equivalent) and a model-selection flag that can target an Ollama endpoint / model id.
- [x] T00.6 Determine approval behavior: can Pi's own permission prompts be bypassed by an env var / flag, or must they be piped through `approvalCallback`?
- [x] T00.7 Confirm AGENTS.md / instruction-file loading behavior and where Pi looks for them (so djimitflo can enforce instruction precedence).
- [x] T00.8 Record any version/commit captured, so the contract is reproducible.

Validation:

- [x] `docs/pi.md` exists with CLI help, invocation form, and ≥3 event samples.
- [x] A sovereign (local Ollama model) headless run produces captured output with zero external API egress.
- [x] Working-directory and model flags are confirmed or marked unsupported with a mitigation note.

## Phase 1: Type And Config Surface

- [x] T01.1 Add `'pi'` to `ExecutorKind` union in `packages/server/src/execution/types.ts`.
- [x] T01.2 Add `pi_path: string` to `packages/shared/src/types/config.ts`.
- [x] T01.3 Add `'pi'` to the `runtime` literal in `packages/shared/src/types/websocket.ts`.
- [x] T01.4 Add env knobs to executor-env where appropriate: `PI_BIN_PATH`, `PI_EXECUTION_TIMEOUT_MS`, `PI_SKIP_PERMISSIONS`, `PI_OUTPUT_FORMAT`.

Validation:

- [x] `npm run build` succeeds across `shared` and `server`.
- [x] `tsc --noEmit` passes; the new union members are referenced without runtime effect.

## Phase 2: PiExecutor Implementation

- [x] T02.1 Create `packages/server/src/execution/executors/pi-executor.ts` modelled on `codex-executor.ts`.
- [x] T02.2 Implement `buildPiArgs(task, options)` from the Phase 0 contract (working dir, model, format, prompt).
- [x] T02.3 Implement `mapJsonEventToExecutionEvent` for Pi's actual event shapes; fall back to the existing heuristic parser if JSON is absent (reuse the Codex heuristic pattern).
- [x] T02.4 Wire `start` / `events` (AsyncIterable) / `result` / `cancel` using the shared spawn+emitter pattern.
- [x] T02.5 Honor `options.skipPermissions` / `PI_SKIP_PERMISSIONS` with a security-override warning event, identical to the Codex precedent.
- [x] T02.6 Resolve the binary from `PI_BIN_PATH` (default `pi`).

Validation:

- [ ] `canExecute` returns true for code tasks.
- [ ] A JSON-mode run maps events to `TASK_STARTED` / `TOOL_CALL` / `LOG` / `TASK_COMPLETED` / `TASK_FAILED`.
- [ ] A non-JSON run falls back to heuristic parsing with an `EVIDENCE WARNING` event.
- [ ] `cancel()` SIGTERM-then-SIGKILL terminates the child, like the other executors.

## Phase 3: Registration And Docs

- [x] T03.1 Register `new PiExecutor()` in `execution-engine.ts` next to the other executors.
- [ ] T03.2 Add the Pi row to `docs/integrations.md` with status set by evidence (pending after Phase 0, verified after Phase 4).
- [x] T03.3 Ensure the executor is selectable via `executorKind` in `executeTask` / approval metadata.

Validation:

- [x] A task created with `executorKind: 'pi'` routes to `PiExecutor`.
- [ ] `docs/integrations.md` reflects the actual verified status.

## Phase 4: Sovereign End-To-End Verification

- [ ] T04.1 Run a real task through djimitflo policy engine → PiExecutor → local Ollama model on the workstation.
- [ ] T04.2 Verify zero external API egress (monitor network / use a local-only model id).
- [ ] T04.3 Confirm diff snapshot, risk classification, and audit trail are populated for the Pi run, matching OpenCode/Codex behavior.
- [ ] T04.4 Confirm approval-gate behavior: djimitflo is the authoritative approval source; Pi's own approvals are bypassed or piped.
- [ ] T04.5 Confirm AGENTS.md precedence is enforced (workspace > project > djimitflo injection).

Validation:

- [ ] End-to-end run completes with artifacts, metrics, and audit events.
- [ ] No external egress observed during the sovereign run.
- [ ] Approval and instruction-precedence behavior matches the documented contract.
- [ ] `docs/integrations.md` Pi status updated to `Verified`.

## Phase 5: Removal / Rollback Path

- [ ] T05.1 Document that disabling is: unregister `PiExecutor`, drop `'pi'` from the three union literals, remove `pi_path`. No other code depends on Pi at runtime.

Validation:

- [ ] Reverting the Phase 1 + Phase 2/3 changes restores prior behavior with no orphaned references.
