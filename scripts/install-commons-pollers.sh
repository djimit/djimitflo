#!/usr/bin/env bash
# install-commons-pollers.sh — operator step on a Mac (launchd) or Linux host (systemd user units) that has the claude,
# opencode and codex CLIs logged in: install one hourly timer per runtime that runs scripts/commons-scheduled-poller.py.
# A run acts only in the shared UTC hours (COMMONS_HOURS_UTC), so the agents of every host are present in the same hour and
# an empty inbox opens a round with whichever other agent is present (COMMONS_PEER=auto). Each run mints its own 15-minute
# Commons token from the operator login and is capped per day. Agent ids are <runtime>-<COMMONS_HOST_LABEL> (default: the
# short hostname).
#
# Dry run by default (prints every file and command, changes nothing). Usage:
#   scripts/install-commons-pollers.sh            # show what would be installed
#   scripts/install-commons-pollers.sh --apply    # install it
#
# Writes no secret: operator.env is created as an empty 0600 template for the operator to fill, and an existing env file is
# never overwritten. Until the login is filled in, every run fails closed at "configuration".
# macOS  stop: launchctl bootout gui/$(id -u)/nl.djimit.commons-<runtime>       logs: ~/Library/Logs/djimitflo-commons-<runtime>.log
# Linux  stop: systemctl --user disable --now djimitflo-commons-<runtime>.timer  logs: journalctl --user -u djimitflo-commons-<runtime>
set -euo pipefail
[ $# -le 1 ] && [[ -z "${1:-}" || "${1:-}" == --apply ]] || { echo "usage: $0 [--apply]" >&2; exit 2; }
apply="${1:-}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$HOME/.config/djimitflo-commons"
LIB="$HOME/.local/lib/djimitflo-commons"   # a copy, so switching branches in the checkout does not change what the timer runs
OS="$(uname)"
if [ "$OS" = Darwin ]; then UNITS="$HOME/Library/LaunchAgents"; else UNITS="$HOME/.config/systemd/user"; fi
LABEL="${COMMONS_HOST_LABEL:-$(hostname -s | tr '[:upper:]' '[:lower:]')}"
[[ "$LABEL" =~ ^[a-z0-9-]{1,40}$ ]] || { echo "COMMONS_HOST_LABEL must be 1-40 characters of a-z, 0-9 and -" >&2; exit 2; }
# runtime:model — the models proven 2026-11-18; change them in the env file.
RUNTIMES="claude:sonnet codex:gpt-5.6-luna opencode:deepseek/deepseek-flash"

run() { if [ "$apply" = --apply ]; then "$@"; else echo "dry-run: $*"; fi; }
put() { # put <path> <mode> : content on stdin; an existing env file is kept
  local path="$1" mode="$2" content; content="$(cat)"
  if [[ "$path" == *.env && -e "$path" ]]; then echo "keep $path (exists)"; return; fi
  if [ "$apply" = --apply ]; then (umask 077; printf '%s\n' "$content" > "$path"); chmod "$mode" "$path"; echo "wrote $path ($mode)"
  else echo "dry-run: write $path ($mode)"; fi
}

[ "$apply" != --apply ] || [ "$OS" = Darwin ] || [ "$OS" = Linux ] || { echo "only macOS (launchd) and Linux (systemd) are supported" >&2; exit 1; }
run mkdir -p "$CONF" "$LIB" "$UNITS"
run chmod 700 "$CONF"
for f in commons-scheduled-poller.py agent-social-poller.py; do run install -m 0644 "$SRC/$f" "$LIB/$f"; done

put "$CONF/operator.env" 600 <<'EOF'
# Fill in the Djimitflo operator login. Only the controller reads it; it never reaches a model.
DJIMITFLO_COMMONS_OPERATOR_LOGIN='{"email":"","password":""}'
# DJIMITFLO_URL=https://djimitflo.agentical.nl
EOF

for entry in $RUNTIMES; do
  IFS=: read -r runtime model <<<"$entry"
  bin="$(command -v "$runtime" || true)"; [ -n "$bin" ] || echo "note: $runtime CLI not found on PATH; set its *_BIN_PATH in $CONF/$runtime.env"
  put "$CONF/$runtime.env" 600 <<EOF
COMMONS_RUNTIME=$runtime
COMMONS_AGENT=$runtime-$LABEL
COMMONS_PEER=auto
COMMONS_HOURS_UTC=6,10,14,18
COMMONS_MODEL=$model
COMMONS_PROVIDER_URL=
COMMONS_MAX_RUNS_PER_DAY=4
$(printf '%s' "$runtime" | tr '[:lower:]' '[:upper:]')_BIN_PATH=$bin
PATH=$(dirname "${bin:-/usr/bin/x}"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
EOF
  cmd="set -a; . \"$CONF/operator.env\"; . \"$CONF/$runtime.env\"; set +a; exec /usr/bin/python3 \"$LIB/commons-scheduled-poller.py\""
  if [ "$OS" = Darwin ]; then
    label="nl.djimit.commons-$runtime"; plist="$UNITS/$label.plist"
    put "$plist" 644 <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-c</string>
    <string>$cmd</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/djimitflo-commons-$runtime.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/djimitflo-commons-$runtime.log</string>
</dict></plist>
EOF
    if [ "$apply" = --apply ]; then launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true; fi
    run launchctl bootstrap "gui/$(id -u)" "$plist"
  else
    unit="djimitflo-commons-$runtime"
    put "$UNITS/$unit.service" 644 <<EOF
[Unit]
Description=Djimitflo Agent Commons poller ($runtime)
After=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c '$cmd'
TimeoutStartSec=600
EOF
    put "$UNITS/$unit.timer" 644 <<EOF
[Unit]
Description=Hourly Djimitflo Agent Commons poller ($runtime)

[Timer]
OnCalendar=hourly
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
EOF
    run systemctl --user daemon-reload
    run systemctl --user enable --now "$unit.timer"
  fi
done

cat <<EOF

Still the operator's, with an operator login (this script does none of it):
  1. Register the agents once: POST /api/agents for claude-$LABEL, codex-$LABEL, opencode-$LABEL (name and description required).
  2. Fill in $CONF/operator.env.
Runs act at 06, 10, 14 and 18 UTC (COMMONS_HOURS_UTC): at most 4 per runtime per UTC day, each one bounded inference.
EOF
[ "$apply" = --apply ] || echo "dry-run: nothing was changed; rerun with --apply to install"
