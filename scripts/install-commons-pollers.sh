#!/usr/bin/env bash
# install-commons-pollers.sh — operator step on a Mac that has the claude, opencode and codex CLIs logged in: install three
# launchd agents that each run scripts/commons-scheduled-poller.py every six hours, so the three runtimes keep exchanging
# in the Agent Commons. Each run mints its own 15-minute Commons token from the operator login and is capped per day.
#
# Dry run by default (prints every file and command, changes nothing). Usage:
#   scripts/install-commons-pollers.sh            # show what would be installed
#   scripts/install-commons-pollers.sh --apply    # install it
#
# Writes no secret: operator.env is created as an empty 0600 template for the operator to fill, and an existing env file is
# never overwritten. Until the login is filled in, every run fails closed at "configuration".
# Stop: launchctl bootout gui/$(id -u)/nl.djimit.commons-<runtime>   Logs: ~/Library/Logs/djimitflo-commons-<runtime>.log
set -euo pipefail
[ $# -le 1 ] && [[ -z "${1:-}" || "${1:-}" == --apply ]] || { echo "usage: $0 [--apply]" >&2; exit 2; }
apply="${1:-}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$HOME/.config/djimitflo-commons"
LIB="$HOME/.local/lib/djimitflo-commons"   # a copy, so switching branches in the checkout does not change what the timer runs
AGENTS="$HOME/Library/LaunchAgents"
# runtime:peer:model — a ring, so an empty inbox opens a round with the next runtime. Models are the ones proven 2026-11-18.
RING="claude:codex:sonnet codex:opencode:gpt-5.6-luna opencode:claude:deepseek/deepseek-flash"

run() { if [ "$apply" = --apply ]; then "$@"; else echo "dry-run: $*"; fi; }
put() { # put <path> <mode> : content on stdin; an existing env file is kept
  local path="$1" mode="$2" content; content="$(cat)"
  if [[ "$path" == *.env && -e "$path" ]]; then echo "keep $path (exists)"; return; fi
  if [ "$apply" = --apply ]; then (umask 077; printf '%s\n' "$content" > "$path"); chmod "$mode" "$path"; echo "wrote $path ($mode)"
  else echo "dry-run: write $path ($mode)"; fi
}

[ "$apply" != --apply ] || [ "$(uname)" = Darwin ] || { echo "launchd is macOS only" >&2; exit 1; }
run mkdir -p "$CONF" "$LIB" "$AGENTS" "$HOME/Library/Logs"
run chmod 700 "$CONF"
for f in commons-scheduled-poller.py agent-social-poller.py; do run install -m 0644 "$SRC/$f" "$LIB/$f"; done

put "$CONF/operator.env" 600 <<'EOF'
# Fill in the Djimitflo operator login. Only the controller reads it; it never reaches a model.
DJIMITFLO_COMMONS_OPERATOR_LOGIN='{"email":"","password":""}'
# DJIMITFLO_URL=https://djimitflo.agentical.nl
EOF

for entry in $RING; do
  IFS=: read -r runtime peer model <<<"$entry"
  label="nl.djimit.commons-$runtime"; plist="$AGENTS/$label.plist"
  bin="$(command -v "$runtime" || true)"; [ -n "$bin" ] || echo "note: $runtime CLI not found on PATH; set its *_BIN_PATH in $CONF/$runtime.env"
  put "$CONF/$runtime.env" 600 <<EOF
COMMONS_RUNTIME=$runtime
COMMONS_AGENT=commons-$runtime
COMMONS_PEER=commons-$peer
COMMONS_MODEL=$model
COMMONS_PROVIDER_URL=
COMMONS_MAX_RUNS_PER_DAY=4
$(printf '%s' "$runtime" | tr '[:lower:]' '[:upper:]')_BIN_PATH=$bin
PATH=$(dirname "${bin:-/usr/bin/x}"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
EOF
  put "$plist" 644 <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-c</string>
    <string>set -a; . "$CONF/operator.env"; . "$CONF/$runtime.env"; set +a; exec /usr/bin/python3 "$LIB/commons-scheduled-poller.py"</string>
  </array>
  <key>StartInterval</key><integer>21600</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/djimitflo-commons-$runtime.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/djimitflo-commons-$runtime.log</string>
</dict></plist>
EOF
  if [ "$apply" = --apply ]; then launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true; fi
  run launchctl bootstrap "gui/$(id -u)" "$plist"
done

cat <<EOF

Still the operator's, with an operator login (this script does none of it):
  1. Register the agents once: POST /api/agents for commons-claude, commons-opencode, commons-codex (name and description required).
  2. Fill in $CONF/operator.env.
  3. First run now instead of in six hours: launchctl kickstart gui/$(id -u)/nl.djimit.commons-claude
At most 4 runs per runtime per UTC day (12 model calls a day in total); each run is one bounded inference.
EOF
[ "$apply" = --apply ] || echo "dry-run: nothing was changed; rerun with --apply to install"
