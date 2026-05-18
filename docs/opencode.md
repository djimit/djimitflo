# OpenCode Executor Integration

## Classification

**Status: Partially verified** — CLI flags and JSON output format verified against OpenCode 1.15.4 (live binary, 2026-05-18). Non-interactive execution with Djimitflo policy engine not yet verified end-to-end.

## CLI Contract

Verified flags for `opencode run`:

| Flag | Type | Default | Status |
|------|------|---------|--------|
| `--dir <path>` | string | — | Verified |
| `--format json\|default` | string | `default` | Verified |
| `--model <provider/model>` | string | — | Verified |
| `--agent <name>` | string | — | Verified |
| `--dangerously-skip-permissions` | boolean | `false` | Verified |
| `--continue` | boolean | — | Not yet supported |
| `--session <id>` | string | — | Not yet supported |
| `--variant <level>` | string | — | Not yet supported |
| `--file <path>` | array | — | Not yet supported |
| `--share` | boolean | — | Not yet supported |
| `--fork` | boolean | — | Not yet supported |

### Invalid flags (removed in Phase 5.1)

| Flag | Reason |
|------|--------|
| `--cwd <path>` | Invalid — use `--dir` instead |
| `--temperature <n>` | Not a valid `opencode run` flag |
| `--max-tokens <n>` | Not a valid `opencode run` flag |

## JSON Event Stream

When `--format json` is used, OpenCode emits NDJSON (one JSON object per line). Each line has:

```json
{
  "type": "<event_type>",
  "timestamp": 1779113530496,
  "sessionID": "ses_...",
  "part": { ... }
}
```

### Event types

| `type` | `part.type` | Maps to |
|---------|-------------|---------|
| `step_start` | `step-start` | `ExecutionEventType.TASK_STARTED` |
| `tool_use` | `tool` | `ExecutionEventType.TOOL_CALL` (with `part.tool`) |
| `text` | `text` | `ExecutionEventType.LOG` (with `part.text`) |
| `step_finish` | `step-finish` | `ExecutionEventType.TASK_COMPLETED` or `.TASK_FAILED` (based on `part.reason`) |

### Token usage

`step_finish` events include `part.tokens`:

```json
{
  "total": 10826,
  "input": 10823,
  "output": 3,
  "reasoning": 0,
  "cache": { "write": 0, "read": 0 }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_BIN_PATH` | `/Users/dlandman/.opencode/bin/opencode` | Path to OpenCode CLI binary |
| `OPENCODE_EXECUTION_TIMEOUT_MS` | `600000` (10 min) | Execution timeout in milliseconds |
| `OPENCODE_SKIP_PERMISSIONS` | `false` | Bypass OpenCode permission prompts. **WARNING**: Only enable when Djimitflo's policy engine has pre-approved the task. |
| `OPENCODE_OUTPUT_FORMAT` | `json` | Output format: `json` (structured NDJSON) or `default` (heuristic parsing) |

## Safety Considerations

### Permission bypass

When `OPENCODE_SKIP_PERMISSIONS=true` (or `options.skipPermissions=true`), the executor:

1. Adds `--dangerously-skip-permissions` to the CLI invocation
2. Emits a WARNING-level execution event documenting the security override
3. The `AuditEventType.SECURITY_OVERRIDE` event is available for audit logging

**Do not** set this to `true` in production without proper policy gating.

### Heuristic fallback

If `--format json` output contains non-JSON lines, the executor automatically:

1. Emits an EVIDENCE WARNING execution event
2. Falls back to heuristic line-by-line parsing (same logic as pre-5.1)
3. Marks all heuristically-parsed events with `parsing_mode: 'heuristic'` in metadata

## Known Limitations

- No session continuity (`--continue`, `--session` not yet supported)
- No MCP integration during execution
- No AGENTS.md injection into execution context
- No worktree management
- Long-running task execution with policy engine not yet verified end-to-end
- Agent kind is passed through but not validated against known OpenCode agents

## Troubleshooting

### Binary not found

```
Error: spawn /path/to/opencode ENOENT
```

Set `OPENCODE_BIN_PATH` to the correct path, or verify OpenCode is installed:

```bash
which opencode
opencode --version
```

### Permission hangs

If execution hangs (no output), OpenCode may be waiting for a permission prompt. Either:

1. Set `OPENCODE_SKIP_PERMISSIONS=true` (with proper policy gating)
2. Or ensure the task doesn't require dangerous operations

### JSON parsing errors

If structured parsing fails, the executor automatically falls back to heuristic mode. Check execution events for `parsing_mode: 'heuristic_fallback'` to identify degraded sessions.