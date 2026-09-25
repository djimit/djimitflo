#!/usr/bin/env bash
# wiki-delta-emitter.sh — publish a `wiki.page.changed` event to the Djimit event bus when the DjimitKBWiki repo has new
# commits. Runs where the wiki lives (the workstation), from a systemd timer or cron. Djimitflo ingests the event and its
# scheduled `wiki_delta` job turns it into a "re-project the wiki delta" work item. It replaces the Paperclip routine
# "DjimitKBWiki knowledge drift review", whose agent could not read the workstation filesystem from the VPS.
#
# First run only records a baseline (no event flood). State: last published commit, in WIKI_EMITTER_STATE.
# Env: WIKI_DIR (/home/djimit/djimit/DjimitKBWiki)  DJIMIT_EVENT_BUS_URL (http://100.86.47.122:8083)
#      DJIMIT_EVENT_STREAM (djimit.events)  WIKI_EMITTER_STATE (~/.local/state/wiki-delta-emitter/last-commit)
#      CURL_BIN (curl)  --dry-run prints the event instead of posting it.
# ponytail: git-commit granularity, one event per run listing up to 200 pages; add per-page events if consumers need them.
set -euo pipefail

WIKI_DIR="${WIKI_DIR:-/home/djimit/djimit/DjimitKBWiki}"
BUS_URL="${DJIMIT_EVENT_BUS_URL:-http://100.86.47.122:8083}"
STREAM="${DJIMIT_EVENT_STREAM:-djimit.events}"
STATE="${WIKI_EMITTER_STATE:-$HOME/.local/state/wiki-delta-emitter/last-commit}"
CURL_BIN="${CURL_BIN:-curl}"
DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

head="$(git -C "$WIKI_DIR" rev-parse HEAD)"
mkdir -p "$(dirname "$STATE")"
if [ ! -s "$STATE" ]; then echo "$head" > "$STATE"; echo "baseline recorded at ${head:0:7}"; exit 0; fi
last="$(cat "$STATE")"
[ "$last" = "$head" ] && { echo "no new commits"; exit 0; }

if git -C "$WIKI_DIR" cat-file -e "${last}^{commit}" 2>/dev/null; then
  pages="$(git -C "$WIKI_DIR" diff --name-only "$last" "$head" -- '*.md' | head -n 200)"
else
  pages="$(git -C "$WIKI_DIR" log -n 50 --name-only --pretty=format: -- '*.md' | sort -u | head -n 200)"
fi
[ -n "$pages" ] || { echo "$head" > "$STATE"; echo "commits without markdown changes"; exit 0; }

payload="$(HEAD_SHA="$head" LAST_SHA="$last" PAGES="$pages" HOST="$(hostname)" python3 - <<'PY'
import json, os, datetime
head = os.environ['HEAD_SHA']
print(json.dumps({
    'event_id': f"wiki:{os.environ['HOST']}:{head[:12]}", 'event_type': 'wiki.page.changed', 'source': 'djimitkb-wiki',
    'occurred_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'dedupe_key': f"wiki:{head}",
    'from_commit': os.environ['LAST_SHA'], 'to_commit': head, 'pages': [p for p in os.environ['PAGES'].split('\n') if p],
}))
PY
)"
if $DRY_RUN; then echo "$payload"; exit 0; fi
"$CURL_BIN" -sf --max-time 15 -X POST -H 'Content-Type: application/json' -d "$payload" "${BUS_URL%/}/events/${STREAM}" >/dev/null
echo "$head" > "$STATE"
echo "published wiki.page.changed for $(echo "$pages" | wc -l | tr -d ' ') page(s)"
