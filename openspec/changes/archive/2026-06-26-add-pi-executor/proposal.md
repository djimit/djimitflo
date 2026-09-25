## Why

Djimitflo's executor fan-out has an explicit gap: `codex` is listed as
"Implemented, unverified — CLI contract anticipated but not yet verified against
live binary" (`docs/integrations.md`). The workstation is the execution node in
Dennis's device-role matrix and runs local Ollama models (`qwen3-coder:30b`,
`gpt-oss:20b`, `qwen2.5-coder:14b`), yet no current djimitflo executor can drive a
**local, model-agnostic, sovereign** coding run with zero API egress. Pi
(`earendil-works/pi`, `packages/coding-agent`) is the only candidate that is
simultaneously (a) local-first / Ollama-capable, (b) AGENTS.md-native, and (c)
open-source and hackable — so its CLI contract can be captured live on the
workstation exactly the way OpenCode 1.15.4 was.

This is a capability add, not an architecture change. Pi drops into the existing
pluggable `TaskExecutor` seam; no new subsystem, MCP server, or runtime
dependency is introduced inside djimitflo. Pi is invoked as an external child
process, identical to the Codex/OpenCode pattern.

## What Changes

- **New executor**: `PiExecutor` in
  `packages/server/src/execution/executors/pi-executor.ts`, modelled on
  `codex-executor.ts`, registered in `execution-engine.ts`.
- **Type extension**: add `'pi'` to the `ExecutorKind` union
  (`packages/server/src/execution/types.ts`).
- **Config extension**: add `pi_path: string` to `packages/shared/src/types/config.ts`
  alongside `codex_path` / `opencode_path`.
- **WebSocket runtime union**: add `'pi'` to the `runtime` literal in
  `packages/shared/src/types/websocket.ts`.
- **Environment knobs** (mirroring Codex): `PI_BIN_PATH`,
  `PI_EXECUTION_TIMEOUT_MS`, `PI_SKIP_PERMISSIONS`, `PI_OUTPUT_FORMAT`.
- **Evidence**: `docs/pi.md` capturing the live Pi CLI contract and NDJSON samples,
  matching the `docs/opencode.md` evidence pattern.
- **Docs**: a new row in `docs/integrations.md` with status
  `Implemented, contract-capture pending` until Phase 0 evidence is in.

## Non-Goals

- No claim that Pi replaces Claude/Codex/OpenCode; it is one option in the
  executor fan-out, selected per task type.
- No auto-merge, auto-deploy, or unattended production mutation via Pi.
- No new MCP server, skill, or agent runtime inside djimitflo.
- No assumption of Pi's exact CLI flags or NDJSON schema before live capture
  (Phase 0 is a hard gate).
- No silent double-approval source: djimitflo's policy engine remains the
  authoritative approval layer.

## Success Criteria

- A live Pi binary on the workstation can be invoked headlessly and its
  output schema captured as evidence in `docs/pi.md`.
- A `PiExecutor` can spawn Pi, stream events into the existing
  `ExecutionEventCreateInput` model, and expose start/cancel/result like the
  other executors.
- A sovereign run completes against a local Ollama model with zero external
  API egress, behind djimitflo approval gates and diff risk-classification.
- Pi's native AGENTS.md reading is reconciled with djimitflo's instruction
  precedence (workspace > project > djimitflo injection) and documented.
- The executor is removable by reverting one file plus four type-config
  additions; no lasting runtime dependency is introduced.

## Open Questions (resolved in Phase 0 — see docs/pi.md)

- Headless invocation: `--mode json -p` (or `--mode rpc` for bidirectional). RESOLVED.
- Structured output: NDJSON, one JSON object per line. RESOLVED.
- Event shapes: NOT Codex-style step-start/tool/text/step-finish. Pi emits
  `session`/`agent_start`/`turn_start`/`message_*`/`tool_execution_*`/`turn_end`/
  `agent_end`; a dedicated mapper is required (see design.md and docs/pi.md). RESOLVED.
- Working-directory: no explicit `--dir` flag; Pi uses the child-process `cwd`. RESOLVED.
- Model targeting Ollama: `--provider ollama --model <id>` plus `~/.pi/agent/models.json`
  (OpenAI-compatible). RESOLVED.
- Approval bypass: N/A — Pi has NO permission popups and no `PI_SKIP_PERMISSIONS`.
  djimitflo's policy engine is the sole boundary; use `--tools` allowlisting and
  containerization for high-risk/`bash` tasks. RESOLVED.
- AGENTS.md load order: `~/.pi/agent/AGENTS.md` -> parent dirs (walking up) -> cwd,
  concatenated; disable with `--no-context-files`. RESOLVED.