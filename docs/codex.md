# Codex Integration Status

## Current Status: Not Implemented

The `ExecutorKind = 'codex'` type exists in `types.ts` but there is no `CodexExecutor` implementation. This is intentional — adding a stub without a working CLI contract would overclaim capability.

## What Codex Provides

Codex (by OpenAI) offers:

- Desktop application with terminal and actions UI
- Worktree management for parallel task execution
- Skills and plugins system
- MCP (Model Context Protocol) integration
- Review/ship workflow
- Session management and continuity

## Integration Paths

There are three potential paths for Codex integration:

### Codex CLI

If Codex provides a CLI with structured output (similar to `opencode run --format json`), an executor could be built that spawns the Codex CLI and parses its output. The CLI contract would need to be captured and verified first.

### Codex SDK

If Codex provides a programmatic SDK (Node.js/TypeScript), the executor could use the SDK directly instead of spawning a process. This would allow richer integration (worktree management, review flow, etc.) but requires dependency management.

### Codex API

If Codex exposes an HTTP API, the executor could make HTTP requests instead of spawning processes. This would enable remote execution and multi-user scenarios.

## Required Future Work

1. **CLI contract capture** — Run `codex --help`, `codex run --help`, etc. to document available flags
2. **Structured output verification** — Confirm whether Codex supports JSON output format
3. **CodexExecutor implementation** — Spawn process or call SDK based on contract
4. **Review/ship flow mapping** — Map Codex review concepts to Djimitflo's approval workflow
5. **Worktree management** — Integrate Codex worktree patterns with Djimitflo's repository intelligence
6. **Permission model mapping** — Map Codex permission prompts to Djimitflo's policy engine

No timeline commitment — this document serves as a roadmap only.