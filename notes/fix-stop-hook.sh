#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Fix: "Stop hook (failed): hook returned invalid stop hook JSON output"
# ──────────────────────────────────────────────────────────────────────────
#
# ROOT CAUSE
#   The security-guidance plugin (v2.0.6, from claude-plugins-official)
#   outputs {"metrics": {...}} as its Stop hook JSON. This is Claude Code's
#   SyncHookJSONOutput format. Codex expects a StopCommandOutputWire schema
#   with fields: decision, reason, continue, stopReason, suppressOutput,
#   systemMessage. The "metrics" field is NOT in Codex's Stop hook schema,
#   so Codex rejects it as "invalid stop hook JSON output" on every Stop
#   hook invocation.
#
# IMPACT
#   Non-fatal. The hook runs and the security review executes (confirmed by
#   debug logs at ~/.claude/security/log.txt), but Codex can't parse the
#   output to surface metrics or trigger asyncRewake. The PostToolUse
#   pattern-based checks still work (they include hookSpecificOutput which
#   IS recognized by Codex).
#
# EVIDENCE
#   - Codex binary strings: "hook returned invalid stop hook JSON output"
#   - Codex schema: StopCommandOutputWire (no "metrics" field)
#   - Hook output (test run): {"metrics": {"pv": 20006, "skipped": true, ...}}
#   - Debug log: Stop hook runs successfully but output format doesn't match
#
# THIS PATCH
#   Modifies emit_metrics() in security_reminder_hook.py to output
#   Codex-compatible JSON for Stop hooks:
#     - No findings: {} (valid empty StopCommandOutputWire)
#     - Findings: {"decision":"block","reason":"...","rewakeSummary":"..."}
#   Metrics are dropped from stdout (they're Claude Code-specific).
#
# RUN:   bash notes/fix-stop-hook.sh
# REVERT: the plugin cache re-downloads on update, reverting this patch.
# ──────────────────────────────────────────────────────────────────────────

HOOK_DIR="$HOME/.codex/plugins/cache/claude-plugins-official/security-guidance"
HOOK_FILE="$HOOK_DIR/2.0.6/hooks/security_reminder_hook.py"

# Find the hook file if the version changed
if [ ! -f "$HOOK_FILE" ]; then
    VERSION=$(ls -1 "$HOOK_DIR" 2>/dev/null | sort -V | tail -1)
    if [ -z "$VERSION" ]; then
        echo "ERROR: security-guidance plugin not found in ~/.codex/plugins/cache/"
        exit 1
    fi
    HOOK_FILE="$HOOK_DIR/$VERSION/hooks/security_reminder_hook.py"
    echo "Found version: $VERSION"
fi

if [ ! -f "$HOOK_FILE" ]; then
    echo "ERROR: security_reminder_hook.py not found"
    exit 1
fi

echo "Patching: $HOOK_FILE"

# Backup
BACKUP="$HOOK_FILE.bak.$(date +%Y%m%d%H%M%S)"
cp "$HOOK_FILE" "$BACKUP"
echo "Backup: $BACKUP"

# Check if already patched
if grep -q "CODEX_COMPAT_PATCH" "$HOOK_FILE"; then
    echo "Already patched. Skipping."
    exit 0
fi

# Apply patch using Python (reliable string matching)
python3 - "$HOOK_FILE" << 'PYEOF'
import sys, os

path = sys.argv[1]
with open(path, "r") as f:
    content = f.read()

OLD = '''    if additional_context:
        if hook_event_name in ("Stop", "SubagentStop"):
            # Stop is NOT in CC's hookSpecificOutput union — emitting it there
            # fails schema validation and drops metrics+rewakeSummary (#2159).
            # Clean pattern: guidance on stderr (the asyncRewake body channel,
            # delivered via `stderr || stdout`), top-level decision/reason for
            # the sync-fallback path. stdout JSON stays valid so metrics +
            # rewakeSummary survive.
            sys.stderr.write(additional_context)
            sys.stderr.flush()
            out["decision"] = "block"
            out["reason"] = additional_context
        else:
            # PostToolUse et al. — valid union member; modern protocol.
            out["hookSpecificOutput"] = {
                "hookEventName": hook_event_name,
                "additionalContext": additional_context,
            }'''

NEW = '''    if additional_context:
        if hook_event_name in ("Stop", "SubagentStop"):
            # CODEX_COMPAT_PATCH: output only valid StopCommandOutputWire fields.
            # "metrics" is not in Codex's Stop hook schema and causes
            # "invalid stop hook JSON output" on every invocation.
            # Guidance goes to stderr (asyncRewake body channel);
            # stdout gets ONLY decision + reason + rewakeSummary.
            sys.stderr.write(additional_context)
            sys.stderr.flush()
            out = {"decision": "block", "reason": additional_context}
            if rewake_summary:
                out["rewakeSummary"] = rewake_summary
        else:
            # PostToolUse et al. — valid union member; modern protocol.
            out["hookSpecificOutput"] = {
                "hookEventName": hook_event_name,
                "additionalContext": additional_context,
            }
    elif hook_event_name in ("Stop", "SubagentStop"):
        # CODEX_COMPAT_PATCH: no findings — output valid empty
        # StopCommandOutputWire instead of {"metrics": {...}} which Codex
        # rejects as "invalid stop hook JSON output".
        out = {}'''

if OLD not in content:
    print("ERROR: Could not find the exact code block to patch.")
    print("The plugin may have been updated. Manual inspection needed:")
    print(f"  grep -n 'Stop is NOT in CC' {path}")
    sys.exit(1)

content = content.replace(OLD, NEW)

with open(path, "w") as f:
    f.write(content)

print("OK — patched emit_metrics() for Codex Stop hook compatibility.")
print("  Stop hook (no findings):  {}  (valid empty StopCommandOutputWire)")
print("  Stop hook (findings):     {decision:block, reason:...}")
print("  metrics: dropped from stdout (Claude Code-specific, not in Codex schema)")
PYEOF

echo ""
echo "Done. Restart Codex to apply."
echo ""
echo "Verify: grep CODEX_COMPAT_PATCH \"$HOOK_FILE\""
echo "Revert: cp \"$BACKUP\" \"$HOOK_FILE\""
