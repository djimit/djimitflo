# Integration Compatibility

## Overview

Djimitflo integrates with external AI agent execution backends. This document summarizes the current compatibility status of each integration.

## Compatibility Summary

| Integration | Status | CLI Verified | JSON Output | Structured Events | Permission Bypass |
|-------------|--------|-------------|-------------|-------------------|-------------------|
| **OpenCode** | Partially verified | Yes (1.15.4) | Yes (NDJSON) | Yes | Yes (`--dangerously-skip-permissions`) |
| **Codex** | Implemented | No (contract anticipated) | Yes (NDJSON, same format as OpenCode) | Yes (step-start/tool/text/step-finish) | Yes (`CODEX_SKIP_PERMISSIONS` env var) |
| **Pi** | Implemented (contract verified) | Yes (0.79.8, `--mode json`) | Yes (NDJSON) | Yes (session/agent_*/turn_*/message_*/tool_execution_*) | N/A — Pi has no permission popups; djimitflo is the sole boundary; restrict via `--tools` |
| **Ruflo** | Conceptually mapped | N/A | N/A | N/A | N/A |

## OpenCode (Partially Verified)

- CLI contract captured and verified against OpenCode 1.15.4 live binary
- Structured JSON output (`--format json`) produces NDJSON event stream
- Permission bypass (`--dangerously-skip-permissions`) available with safety guardrails
- Working directory (`--dir`), model selection (`--model`), and agent selection (`--agent`) all verified
- See [docs/opencode.md](./opencode.md) for full details

**Not yet verified**: Long-running task execution with Djimitflo policy engine end-to-end

## Codex (Implemented, unverified)

- `ExecutorKind = 'codex'` and `CodexExecutor` class exists in `packages/server/src/execution/executors/codex-executor.ts`
- Registered in `execution-engine.ts`
- Structured NDJSON output (`--format json`) with event types `step-start`, `tool`, `text`, `step-finish`
- Permission bypass available via `CODEX_SKIP_PERMISSIONS=true` environment variable
- Binary resolved from `CODEX_BIN_PATH` environment variable, default: `codex`
- CLI contract anticipated but not yet verified against live binary
- See [docs/codex.md](./codex.md) for details

## Pi (Implemented, contract verified)

- `ExecutorKind = 'pi'` and `PiExecutor` class in `packages/server/src/execution/executors/pi-executor.ts`
- Registered in `execution-engine.ts`
- Invoked as an external child process: `pi --mode json -p` (no runtime dependency inside djimitflo)
- Structured NDJSON output with Pi's own event schema (`session`, `agent_start`, `turn_start/end`, `message_start/update/end`, `tool_execution_start/end`, `agent_end`) — see the mapping in [docs/pi.md](./pi.md)
- Working directory = child-process `cwd` (Pi has no `--dir` flag); model via `--provider`/`--model` (Ollama via `~/.pi/agent/models.json`)
- **No permission popups / no bypass flag**: Pi runs with the user's permissions; djimitflo's policy engine is the sole approval boundary. Risk is controlled per task via the `PI_TOOLS` allowlist (drop `bash` for low-risk); containerize for `bash`-enabled or sensitive-repo runs
- Sovereign/zero-egress runs require `PI_OFFLINE=1` + `PI_SKIP_VERSION_CHECK=1` + `PI_TELEMETRY=0` (else Pi phones home to pi.dev at startup)
- Env knobs: `PI_BIN_PATH`, `PI_EXECUTION_TIMEOUT_MS`, `PI_PROVIDER`, `PI_MODEL`, `PI_TOOLS`, `PI_THINKING`, `PI_NO_CONTEXT_FILES`, `PI_NO_APPROVE`, `PI_NO_EXTENSIONS`, `PI_NO_SKILLS`, `PI_OFFLINE`
- CLI contract verified 2026-06-20 against Pi 0.79.8 on the workstation (zero-egress Ollama smoke run captured)
- See [docs/pi.md](./pi.md) for the full contract and live event samples

**Not yet verified**: Long-running task execution through the Djimitflo policy engine end-to-end (Phase 4)

## Ruflo (Conceptually Mapped)

- No runtime dependency on Ruflo
- Zero Ruflo code in the Djimitflo codebase
- Djimitflo draws conceptual inspiration from Ruflo's orchestration patterns
- Key concepts mapped (task orchestration, approval, hooks, repository scanning)
- Key differences documented (Claude Code dependency, swarm vs. policy-gated, vector vs. SQL memory)
- See [docs/ruflo-compatibility.md](./ruflo-compatibility.md) for mapping table

## Evidence Paths

Each integration has an evidence trail:

- **OpenCode**: `opencode run --help` output, JSON event samples, live binary test results
- **Codex**: Structured event samples documented; live binary verification pending
- **Pi**: `pi --help` output, NDJSON event samples, zero-egress Ollama smoke run (docs/pi.md)
- **Ruflo**: Concept mapping table, GitHub README references, zero code dependency

## Known Limitations

- OpenCode session continuity (`--continue`, `--session`) not yet supported
- OpenCode MCP integration during execution not yet supported
- OpenCode AGENTS.md injection into execution context not yet supported
- Codex integration requires CLI/SDK/API contract capture first
- Ruflo integration would require Claude Code runtime dependency
- All OpenCode/execution API endpoints now require JWT authentication (Phase 5.2)

## Next Steps

1. End-to-end test: Execute a real task via Djimitflo policy engine → OpenCode executor → verify event stream
1b. End-to-end sovereign test: Djimitflo policy engine → Pi executor → local Ollama model (zero egress) → verify event stream, diff snapshot, risk classification, audit trail
2. Capture Codex CLI contract (if Codex CLI is available)
3. Evaluate Ruflo hooks pattern for pre/post execution lifecycle
4. Session continuity support for OpenCode (`--continue`, `--session`)