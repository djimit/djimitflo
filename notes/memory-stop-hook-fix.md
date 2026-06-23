---
id: memory.stop-hook-fix
type: Memory
title: "Stop hook invalid JSON fix — security-guidance plugin disabled in Codex"
description: Codex's StopCommandOutputWire schema rejects the security-guidance plugin's {"metrics":{...}} output (Claude Code's SyncHookJSONOutput format). Plugin disabled in ~/.codex/config.toml. Patch script at notes/fix-stop-hook.sh for surgical re-enablement.
owner: djimit
status: active
confidence: validated
classification: internal
created_at: 2026-06-22T01:15:00Z
updated_at: 2026-06-22T01:15:00Z
timestamp: 2026-06-22T01:15:00Z
last_validated: 2026-06-22T01:15:00Z
review_cycle_days: 90
tags: [memory, fix, stop-hook, codex, security-guidance, plugin, json-schema]
related:
  - notes/fix-stop-hook.sh:RELATED_TO
  - notes/software-brain-problem-discussion.md:UNRELATED_TO
---

# Stop Hook Invalid JSON Fix

## Problem

Codex error: `Stop hook (failed): hook returned invalid stop hook JSON output`

## Root cause

The security-guidance plugin (v2.0.6, from `claude-plugins-official`) outputs
`{"metrics": {...}}` as its Stop hook JSON. This is Claude Code's
`SyncHookJSONOutput` format. Codex expects a `StopCommandOutputWire` schema
with fields: `decision`, `reason`, `continue`, `stopReason`, `suppressOutput`,
`systemMessage`. The `metrics` field is NOT in Codex's Stop hook schema, so
Codex rejects it as "invalid stop hook JSON output" on every Stop hook
invocation.

## Evidence

- Codex binary strings: exact error message `hook returned invalid stop hook
  JSON output`
- Codex schema: `StopCommandOutputWire` — no `metrics` field
- Hook output (test run): `{"metrics": {"pv": 20006, "skipped": true, ...}}`
- Debug log (`~/.claude/security/log.txt`): Stop hook runs successfully but
  output format doesn't match Codex's schema
- PostToolUse hooks work fine — they include `hookSpecificOutput` which IS
  in Codex's schema

## Fix applied (2026-06-22)

Disabled the security-guidance plugin entirely in `~/.codex/config.toml`:

```toml
[plugins."security-guidance@claude-plugins-official"]
enabled = false
```

Command used (macOS, perl one-liner for multiline TOML edit):
```bash
perl -i -0pe 's/(\[plugins\."security-guidance\@claude-plugins-official"\]\n)enabled = true/${1}enabled = false/' ~/.codex/config.toml
```

## Impact

- Stop hook error resolved
- PostToolUse pattern checks (hardcoded secrets, SQL injection, etc.) also
  disabled — these were producing valid Codex JSON and were NOT the problem
- SessionStart and UserPromptSubmit hooks also disabled

## Surgical re-enablement (if pattern checks are wanted back)

1. Run the patch script: `bash notes/fix-stop-hook.sh`
   - Patches `emit_metrics()` in `security_reminder_hook.py` to output
     `{}` for no-findings and `{"decision":"block","reason":"..."}`
     for findings (valid `StopCommandOutputWire`)
   - Drops `metrics` from stdout (Claude Code-specific, not in Codex schema)
   - Idempotent (checks for `CODEX_COMPAT_PATCH` marker)
   - Lives in plugin cache — overwritten on plugin update, re-run after
2. Re-enable the plugin:
   ```bash
   perl -i -0pe 's/(\[plugins\."security-guidance\@claude-plugins-official"\]\n)enabled = false/${1}enabled = true/' ~/.codex/config.toml
   ```
3. Restart Codex

## Upstream fix check

If the security-guidance plugin updates to a version that outputs
Codex-compatible Stop hook JSON, the patch becomes unnecessary. Check the
plugin changelog for "Codex" or "StopCommandOutputWire" compatibility
notes before re-enabling without the patch.

## Sandbox constraint

The `~/.codex/` directory is outside the workspace write boundary. Config
changes and plugin patches must be applied from the user's terminal, not
from inside the Codex sandbox.
