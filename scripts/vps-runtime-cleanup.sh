#!/usr/bin/env bash
# vps-runtime-cleanup.sh — prune leftover deploy/backup artifacts on the
# agentical production VPS (/srv/djimitflo). Found accumulating unbounded
# during a 2026-09-19 production audit: 66 leftover runtime-source-* clone
# dirs (~5GB+) and dozens of loose djimitflo*.sqlite backup/rollback files
# outside data/backups/ — no retention job existed. Root disk was 71% full.
#
# Safe by construction: dry-run by default (prints what WOULD be removed),
# never touches the runtime-source dir the live compose.yml currently
# points at, and always keeps the N most recent of everything else.
#
# Usage:
#   ./vps-runtime-cleanup.sh                # dry run (default)
#   ./vps-runtime-cleanup.sh --apply         # actually delete
#   ./vps-runtime-cleanup.sh --apply --keep-source 5 --keep-sqlite 10
#
# ponytail: mtime-based keep-N pruning, no age-based expiry, no config file.
# Add a --keep-days option if a fixed count ever stops being the right unit.
set -euo pipefail

DJIMITFLO_ROOT="${DJIMITFLO_ROOT:-/srv/djimitflo}"
APPLY=false
KEEP_SOURCE=5
KEEP_SQLITE=10

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --keep-source=*) KEEP_SOURCE="${arg#*=}" ;;
    --keep-sqlite=*) KEEP_SQLITE="${arg#*=}" ;;
    --self-test) exec "$(dirname "$0")/vps-runtime-cleanup.selftest.sh" ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

active_source_dir() {
  # compose.yml has: - /srv/djimitflo/runtime-source-<hash>:/workspace/djimitflo
  grep -oE "${DJIMITFLO_ROOT}/runtime-source-[a-zA-Z0-9]+:" "${DJIMITFLO_ROOT}/compose.yml" \
    | head -1 | tr -d ':'
}

prune_dir_set() {
  local pattern="$1" keep="$2" protect="${3:-}"
  local candidates
  candidates=$( { find $pattern -maxdepth 0 -type d 2>/dev/null || true; } | while read -r d; do
    printf '%s\t%s\n' "$(stat -c %Y "$d" 2>/dev/null || stat -f %m "$d")" "$d"
  done | sort -rn)

  local kept=0 total=0
  while IFS=$'\t' read -r mtime path; do
    [ -z "$path" ] && continue
    total=$((total + 1))
    if [ -n "$protect" ] && [ "$path" = "$protect" ]; then
      echo "KEEP  (active) $path"
      continue
    fi
    kept=$((kept + 1))
    if [ "$kept" -le "$keep" ]; then
      echo "KEEP  (recent) $path"
    else
      local size
      size=$(du -sh "$path" 2>/dev/null | cut -f1)
      if $APPLY; then
        echo "DELETE ($size) $path"
        rm -rf -- "$path"
      else
        echo "WOULD DELETE ($size) $path"
      fi
    fi
  done <<< "$candidates"
}

prune_file_set() {
  local pattern="$1" keep="$2"
  local candidates
  candidates=$( { find $pattern -maxdepth 0 -type f 2>/dev/null || true; } | while read -r f; do
    printf '%s\t%s\n' "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")" "$f"
  done | sort -rn)

  local kept=0
  while IFS=$'\t' read -r mtime path; do
    [ -z "$path" ] && continue
    kept=$((kept + 1))
    if [ "$kept" -le "$keep" ]; then
      echo "KEEP  (recent) $path"
    else
      local size
      size=$(du -sh "$path" 2>/dev/null | cut -f1)
      if $APPLY; then
        echo "DELETE ($size) $path"
        rm -f -- "$path"
      else
        echo "WOULD DELETE ($size) $path"
      fi
    fi
  done <<< "$candidates"
}

echo "=== runtime-source-* clone dirs (keep $KEEP_SOURCE + active) ==="
active="$(active_source_dir || true)"
prune_dir_set "${DJIMITFLO_ROOT}/runtime-source-*" "$KEEP_SOURCE" "$active"

echo
echo "=== data/backups/*.sqlite* (keep newest $KEEP_SQLITE) ==="
prune_file_set "${DJIMITFLO_ROOT}/data/backups/*.sqlite*" "$KEEP_SQLITE"

echo
echo "=== loose data/djimitflo.sqlite.pre-*.rollback (keep newest $KEEP_SQLITE) ==="
# ponytail: only this one precise, unambiguous rollback-snapshot pattern.
# /data root also has other loose, inconsistently-named legacy snapshots
# (djimitflo-pre-<name>-<date>.sqlite, no .rollback suffix) plus clearly-live
# named DBs (agent-catalog.sqlite, benchmark.sqlite, r21-canary.sqlite) with
# naming too similar to risk a broader glob. Left alone; widen this pattern
# only after a manual inventory confirms which of those are truly dead.
prune_file_set "${DJIMITFLO_ROOT}/data/djimitflo.sqlite.pre-*.rollback" "$KEEP_SQLITE"

$APPLY || echo -e "\nDry run only — pass --apply to actually delete."
