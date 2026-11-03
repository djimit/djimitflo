#!/usr/bin/env bash
# Self-check for vps-runtime-cleanup.sh: builds fake runtime-source dirs and
# backup files with staggered mtimes in a throwaway temp dir, then asserts
# the script keeps the active + N most recent and deletes the rest. Not a
# full test suite — the smallest thing that fails if the keep/delete logic
# breaks. Run directly: ./vps-runtime-cleanup.selftest.sh
set -euo pipefail

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$TMP/data/backups"
cat > "$TMP/compose.yml" <<EOF
services:
  djimitflo:
    volumes:
      - $TMP/runtime-source-active:/workspace/djimitflo
EOF

# 4 runtime-source dirs: 1 active (must always survive) + 3 aged by mtime.
mkdir -p "$TMP/runtime-source-active" "$TMP/runtime-source-old1" "$TMP/runtime-source-old2" "$TMP/runtime-source-old3"
touch -t 202601010000 "$TMP/runtime-source-old3"
touch -t 202601020000 "$TMP/runtime-source-old2"
touch -t 202601030000 "$TMP/runtime-source-old1"
touch -t 202601040000 "$TMP/runtime-source-active"

# 3 backup files, keep newest 2 in this test.
touch -t 202601010000 "$TMP/data/backups/pre-a.sqlite"
touch -t 202601020000 "$TMP/data/backups/pre-b.sqlite"
touch -t 202601030000 "$TMP/data/backups/pre-c.sqlite"

out=$(DJIMITFLO_ROOT="$TMP" "$SCRIPT_DIR/vps-runtime-cleanup.sh" --apply --keep-source=1 --keep-sqlite=2)

fail() { echo "FAIL: $1"; echo "$out"; exit 1; }

[ -d "$TMP/runtime-source-active" ] || fail "active source dir was deleted"
[ -d "$TMP/runtime-source-old1" ] || fail "most recent non-active dir (old1, keep=1) was wrongly deleted"
[ -d "$TMP/runtime-source-old2" ] && fail "old2 should have been deleted (beyond keep=1 + active)"
[ -d "$TMP/runtime-source-old3" ] && fail "old3 should have been deleted (beyond keep=1 + active)"

[ -f "$TMP/data/backups/pre-c.sqlite" ] || fail "newest backup (pre-c) was wrongly deleted"
[ -f "$TMP/data/backups/pre-b.sqlite" ] || fail "2nd-newest backup (pre-b, keep=2) was wrongly deleted"
[ -f "$TMP/data/backups/pre-a.sqlite" ] && fail "oldest backup (pre-a) should have been deleted (beyond keep=2)"

echo "OK: vps-runtime-cleanup.sh keep/delete logic verified"
