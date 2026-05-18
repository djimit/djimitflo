# Integration Compatibility

## Overview

Djimitflo integrates with external AI agent execution backends. This document summarizes the current compatibility status of each integration.

## Compatibility Summary

| Integration | Status | CLI Verified | JSON Output | Structured Events | Permission Bypass |
|-------------|--------|-------------|-------------|-------------------|-------------------|
| **OpenCode** | Partially verified | Yes (1.15.4) | Yes (NDJSON) | Yes | Yes (`--dangerously-skip-permissions`) |
| **Codex** | Not implemented | No | No | No | No |
| **Ruflo** | Conceptually mapped | N/A | N/A | N/A | N/A |

## OpenCode (Partially Verified)

- CLI contract captured and verified against OpenCode 1.15.4 live binary
- Structured JSON output (`--format json`) produces NDJSON event stream
- Permission bypass (`--dangerously-skip-permissions`) available with safety guardrails
- Working directory (`--dir`), model selection (`--model`), and agent selection (`--agent`) all verified
- See [docs/opencode.md](./opencode.md) for full details

**Not yet verified**: Long-running task execution with Djimitflo policy engine end-to-end

## Codex (Not Implemented)

- `ExecutorKind = 'codex'` exists in types but no `CodexExecutor` class
- Three potential integration paths: CLI, SDK, API
- CLI contract not yet captured
- Adding a stub without a working contract would overclaim capability
- See [docs/codex.md](./codex.md) for roadmap

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
- **Codex**: None (documented as not implemented)
- **Ruflo**: Concept mapping table, GitHub README references, zero code dependency

## Known Limitations

- OpenCode session continuity (`--continue`, `--session`) not yet supported
- OpenCode MCP integration during execution not yet supported
- OpenCode AGENTS.md injection into execution context not yet supported
- Codex integration requires CLI/SDK/API contract capture first
- Ruflo integration would require Claude Code runtime dependency

## Next Steps

1. End-to-end test: Execute a real task via Djimitflo policy engine → OpenCode executor → verify event stream
2. Capture Codex CLI contract (if Codex CLI is available)
3. Evaluate Ruflo hooks pattern for pre/post execution lifecycle
4. Session continuity support for OpenCode (`--continue`, `--session`)