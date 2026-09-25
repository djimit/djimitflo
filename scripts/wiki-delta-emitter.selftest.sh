#!/usr/bin/env bash
# Self-check for wiki-delta-emitter.sh with a throwaway git repo and a fake curl. Run: ./wiki-delta-emitter.selftest.sh
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
git -C "$TMP" init -q wiki && cd "$TMP/wiki"
git config user.email t@t && git config user.name t
mkdir wiki && echo one > wiki/a.md && git add -A && git commit -q -m one
cat > "$TMP/fakecurl" <<'EOF'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do [ "$1" = "-d" ] && { printf '%s' "$2" > "$FAKE_BODY"; }; shift; done
EOF
chmod +x "$TMP/fakecurl"
export WIKI_DIR="$TMP/wiki" WIKI_EMITTER_STATE="$TMP/state" CURL_BIN="$TMP/fakecurl" FAKE_BODY="$TMP/body.json" DJIMIT_EVENT_BUS_URL=http://bus

"$DIR/wiki-delta-emitter.sh" | grep -q baseline || fail "first run must only record a baseline"
[ ! -e "$TMP/body.json" ] || fail "baseline run must not post"
"$DIR/wiki-delta-emitter.sh" | grep -q "no new commits" || fail "unchanged wiki must not post"

echo two > wiki/b.md && echo changed > wiki/a.md && echo note > README.txt && git add -A && git commit -q -m two
"$DIR/wiki-delta-emitter.sh" --dry-run > "$TMP/dry.json"
[ ! -e "$TMP/body.json" ] || fail "dry run must not post"
"$DIR/wiki-delta-emitter.sh" | grep -q "published wiki.page.changed for 2 page" || fail "expected 2 changed pages (txt ignored)"
python3 - "$TMP/body.json" <<'PY'
import json, sys
e = json.load(open(sys.argv[1]))
assert e['event_type'] == 'wiki.page.changed' and sorted(e['pages']) == ['wiki/a.md', 'wiki/b.md'], e
assert e['dedupe_key'].startswith('wiki:') and e['event_id'].startswith('wiki:'), e
PY
"$DIR/wiki-delta-emitter.sh" | grep -q "no new commits" || fail "state must advance after a successful post"

echo three > README.txt && git add -A && git commit -q -m three
"$DIR/wiki-delta-emitter.sh" | grep -q "without markdown" || fail "non-markdown commits must not post"
echo "wiki-delta-emitter selftest OK"
