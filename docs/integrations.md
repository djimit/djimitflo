# Integration Compatibility

## Overview

Djimitflo integrates with external AI agent execution backends. This document summarizes the current compatibility status of each integration.

## Compatibility Summary

| Integration | Status | CLI Verified | JSON Output | Structured Events | Permission Bypass |
|-------------|--------|-------------|-------------|-------------------|-------------------|
| **OpenCode** | Partially verified | Yes (1.15.4) | Yes (NDJSON) | Yes | Yes (`--dangerously-skip-permissions`) |
| **Codex** | Implemented | No (contract anticipated) | Yes (NDJSON, same format as OpenCode) | Yes (step-start/tool/text/step-finish) | Yes (`CODEX_SKIP_PERMISSIONS` env var) |
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
- **Ruflo**: Concept mapping table, GitHub README references, zero code dependency

## Known Limitations

- Codex integration requires CLI/SDK/API contract capture first
- All OpenCode/execution API endpoints now require JWT authentication (Phase 5.2)

## Supported Features

- **AGENTS.md injection**: Fully supported. AGENTS.md files are discovered during repository scanning and their effective instructions are injected into executor prompts using `[CONTEXT FROM AGENTS.md]...[END CONTEXT]` delimiters.
- **MCP passthrough**: Best-effort supported. MCP servers from the database are passed to executors as configuration. Actual CLI support depends on executor capabilities.

## Next Steps

1. End-to-end test: Execute a real task via Djimitflo policy engine → OpenCode executor → verify event stream
2. Capture Codex CLI contract (if Codex CLI is available)
3. Evaluate Ruflo hooks pattern for pre/post execution lifecycle