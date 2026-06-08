# Codex Integration Status

## Current Status: Implemented — CLI contract unverified against live binary

`CodexExecutor` exists in `packages/server/src/execution/executors/codex-executor.ts` and is registered in `execution-engine.ts`. The executor spawns a Codex-compatible CLI process and parses its structured NDJSON output.

## What Codex Provides

Codex (by OpenAI) offers:

- Desktop application with terminal and actions UI
- Worktree management for parallel task execution
- Skills and plugins system
- MCP (Model Context Protocol) integration
- Review/ship workflow
- Session management and continuity

## CLI Contract

The executor invokes the binary as:

```bash
codex exec --format json --dir <path> --model <model> <prompt>
```

- Binary: resolved from `CODEX_BIN_PATH` env var, defaulting to `codex` on PATH.
- Output: NDJSON stream with event types `step-start`, `tool`, `text`, `step-finish`.
- Permissions: `--dangerously-skip-permissions` is passed when `CODEX_SKIP_PERMISSIONS=true`.

## Remaining Work

1. **Live binary verification** — confirm CLI flags and event shape against an installed Codex CLI.
2. **Structured output verification** — capture real NDJSON samples from the binary.
3. **Review/ship flow mapping** — map Codex review concepts to Djimitflo's approval workflow.
4. **Worktree management** — integrate Codex worktree patterns with Djimitflo's repository intelligence.
5. **Permission model mapping** — map Codex permission prompts to Djimitflo's policy engine.
