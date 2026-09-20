#!/usr/bin/env bash
# Self-check for deploy-vps.sh: the compose rewrite (pure function) and the shape of the
# remote script (chown before recreate, rollback present). Run: ./deploy-vps.selftest.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# shellcheck source=deploy-vps.sh
source "$SCRIPT_DIR/deploy-vps.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }

PREV=aaaaaaa; PREV_FULL=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
NEW=bbbbbbb;  NEW_FULL=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
cat > "$TMP/compose.yml" <<EOF
services:
  djimitflo:
    image: djimitflo:main-$PREV
    environment:
      DJIMITFLO_COMMIT_SHA: $PREV_FULL
    volumes:
      - /srv/djimitflo/runtime-source-$PREV:/workspace/djimitflo
      - /srv/djimitflo/data:/data
EOF
rewrite_compose "$TMP/compose.yml" "$PREV" "$PREV_FULL" "$NEW" "$NEW_FULL" || fail "rewrite_compose returned non-zero"
grep -q "image: djimitflo:main-$NEW" "$TMP/compose.yml" || fail "image not rewritten"
grep -q "COMMIT_SHA: $NEW_FULL" "$TMP/compose.yml" || fail "commit sha not rewritten"
grep -q "runtime-source-$NEW:/workspace/djimitflo" "$TMP/compose.yml" || fail "mount not rewritten"
grep -q "/srv/djimitflo/data:/data" "$TMP/compose.yml" || fail "unrelated mount was touched"
grep -q "$PREV" "$TMP/compose.yml" && fail "old sha still present"

# A rewrite that matches nothing must be reported, not silently accepted.
if rewrite_compose "$TMP/compose.yml" "ccccccc" "$PREV_FULL" "ddddddd" "$NEW_FULL"; then fail "no-op rewrite reported success"; fi

remote="$(remote_script)"
chown_line="$(echo "$remote" | grep -n 'chown -R 1001:1001' | head -n 1 | cut -d: -f1)"
up_line="$(echo "$remote" | grep -n 'docker compose up' | head -n 1 | cut -d: -f1)"
[ -n "$chown_line" ] && [ -n "$up_line" ] && [ "$chown_line" -lt "$up_line" ] || fail "chown must precede the first recreate"
echo "$remote" | grep -q 'rolling back' || fail "rollback missing"
if ( main not-a-sha ) >/dev/null 2>&1; then fail "invalid sha accepted"; fi
echo "deploy-vps selftest OK"
