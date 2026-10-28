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
echo "$remote" | grep -q 'timeout "${DEPLOY_BUILD_TIMEOUT_S:-1200}" docker build --network host' || fail "docker build is not time-bounded"
if ( main not-a-sha ) >/dev/null 2>&1; then fail "invalid sha accepted"; fi

# --- build receipt (forensic 2026-10-26 ROOT-001): one immutable receipt per image, verified before and after the switch
SRC="$TMP/src"; mkdir -p "$SRC"; RCPT="$TMP/receipts"
printf 'ARG NODE_IMAGE=node:22-bookworm-slim\nFROM ${NODE_IMAGE} AS builder\nRUN npm ci\n' > "$SRC/Dockerfile"
echo '{"lockfileVersion":3}' > "$SRC/package-lock.json"
LOCK="$(sha256_file "$SRC/package-lock.json")"
BASE="node@sha256:$(printf 'b%.0s' $(seq 1 64))"
FAKE_ID="sha256:$(printf 'c%.0s' $(seq 1 64))"
FAKE_DIGESTS="$(printf 'other/node@sha256:0000\n%s' "$BASE")"
FAKE_ENV="$(printf 'DJIMITFLO_BUILD_COMMIT=%s\nDJIMITFLO_BUILD_LOCK_SHA256=%s\nDJIMITFLO_BUILD_BASE_IMAGE=%s' "$NEW_FULL" "$LOCK" "$BASE")"
# docker image inspect -f FMT REF: $4 = format, $5 = ref
docker() { case "$1 ${4:-}" in "image {{.Id}}") echo "$FAKE_ID" ;; "image "*RepoDigests*) printf '%s\n' "$FAKE_DIGESTS" ;; "image "*Config.Env*) printf '%s\n' "$FAKE_ENV" ;; "pull "*) return 0 ;; *) return 1 ;; esac; }
[ "$(resolve_base_image node:22-bookworm-slim)" = "$BASE" ] || fail "the base tag must resolve to the digest of its own repo"
if FAKE_DIGESTS="" resolve_base_image node:22-bookworm-slim >/dev/null 2>&1; then fail "a base without a registry digest was accepted"; fi
if resolve_base_image "" >/dev/null 2>&1; then fail "an empty base tag was accepted"; fi
if write_build_receipt "$RCPT" "$SRC" "$NEW_FULL" "djimitflo:main-$NEW" node:22-bookworm-slim x 2>/dev/null; then fail "a receipt with a tag, not a digest, as base"; fi
receipt="$(write_build_receipt "$RCPT" "$SRC" "$NEW_FULL" "djimitflo:main-$NEW" "$BASE" 2026-10-27T00:00:00Z)" || fail "write_build_receipt failed"
[ "$receipt" = "$RCPT/${FAKE_ID#sha256:}.json" ] || fail "receipt is not named by the image id: $receipt"
for want in "\"commit\":\"$NEW_FULL\"" "\"image_id\":\"$FAKE_ID\"" "\"lockfile_sha256\":\"$LOCK\"" \
  "\"dockerfile_sha256\":\"$(sha256_file "$SRC/Dockerfile")\"" "\"base_image\":\"$BASE\"" "\"image\":\"djimitflo:main-$NEW\""; do
  grep -qF "$want" "$receipt" || fail "receipt lacks $want"
done
[ ! -w "$receipt" ] || [ "$(id -u)" = 0 ] || fail "receipt must be read-only"
verify_build_receipt "$receipt" "$SRC" "$NEW_FULL" "djimitflo:main-$NEW" 2>/dev/null || fail "matching receipt rejected"
# immutable: a second receipt for the same image but another commit is refused, the first one stays
if write_build_receipt "$RCPT" "$SRC" "$PREV_FULL" "djimitflo:main-$NEW" "$BASE" x 2>/dev/null; then fail "receipt overwritten for another commit"; fi
grep -qF "\"commit\":\"$NEW_FULL\"" "$receipt" || fail "receipt was modified"
# each missing or mismatched input blocks the deploy
if verify_build_receipt "$receipt" "$SRC" "$PREV_FULL" "djimitflo:main-$NEW" 2>/dev/null; then fail "receipt accepted for another commit"; fi
if FAKE_ID="sha256:$(printf 'd%.0s' $(seq 1 64))" verify_build_receipt "$receipt" "$SRC" "$NEW_FULL" "djimitflo:main-$NEW" 2>/dev/null; then fail "re-pointed image tag accepted"; fi
drop() { printf '%s\n' "$FAKE_ENV" | grep -v "^$1="; }
for var in DJIMITFLO_BUILD_COMMIT DJIMITFLO_BUILD_LOCK_SHA256 DJIMITFLO_BUILD_BASE_IMAGE; do
  if FAKE_ENV="$(drop "$var")" verify_build_receipt "$receipt" "$SRC" "$NEW_FULL" "djimitflo:main-$NEW" 2>/dev/null; then fail "image without $var accepted"; fi
done
if FAKE_ENV="$(drop DJIMITFLO_BUILD_BASE_IMAGE; echo "DJIMITFLO_BUILD_BASE_IMAGE=node@sha256:other")" verify_build_receipt "$receipt" "$SRC" "$NEW_FULL" "djimitflo:main-$NEW" 2>/dev/null; then fail "image built from another base accepted"; fi
if verify_build_receipt "$RCPT/missing.json" "$SRC" "$NEW_FULL" "djimitflo:main-$NEW" 2>/dev/null; then fail "missing receipt accepted"; fi
sed 's/"base_image":"[^"]*"/"base_image":"unknown"/' "$receipt" > "$TMP/nobase.json"
if FAKE_ENV="$(drop DJIMITFLO_BUILD_BASE_IMAGE; echo DJIMITFLO_BUILD_BASE_IMAGE=unknown)" verify_build_receipt "$TMP/nobase.json" "$SRC" "$NEW_FULL" "djimitflo:main-$NEW" 2>/dev/null; then fail "receipt without a base digest accepted"; fi
# the Dockerfile hash binds the recipe: a receipt without it, or with another one, is refused (Codex re-review of #1061)
sed 's/"dockerfile_sha256":"[^"]*",//' "$receipt" > "$TMP/nodf.json"
if verify_build_receipt "$TMP/nodf.json" "$SRC" "$NEW_FULL" "djimitflo:main-$NEW" 2>/dev/null; then fail "receipt without a Dockerfile hash accepted"; fi
sed 's/"dockerfile_sha256":"[^"]*"/"dockerfile_sha256":"0000"/' "$receipt" > "$TMP/wrongdf.json"
if verify_build_receipt "$TMP/wrongdf.json" "$SRC" "$NEW_FULL" "djimitflo:main-$NEW" 2>/dev/null; then fail "receipt with a wrong Dockerfile hash accepted"; fi
cp "$SRC/Dockerfile" "$TMP/Dockerfile.orig"; echo 'RUN true' >> "$SRC/Dockerfile"
if verify_build_receipt "$receipt" "$SRC" "$NEW_FULL" "djimitflo:main-$NEW" 2>/dev/null; then fail "changed Dockerfile accepted"; fi
cp "$TMP/Dockerfile.orig" "$SRC/Dockerfile"
echo '{"lockfileVersion":3,"x":1}' > "$SRC/package-lock.json"
if verify_build_receipt "$receipt" "$SRC" "$NEW_FULL" "djimitflo:main-$NEW" 2>/dev/null; then fail "changed lockfile accepted"; fi
unset -f docker drop
bash -n <<<"$remote" || fail "the remote script (with the receipt functions) does not parse"
verify_line="$(echo "$remote" | grep -n 'verify_build_receipt "$RECEIPT"' | head -n 1 | cut -d: -f1)"
[ -n "$verify_line" ] && [ "$verify_line" -lt "$up_line" ] || fail "receipt must be verified before the first recreate"
grep -qx 'RUN npm ci' "$SCRIPT_DIR/../Dockerfile" || fail "builder stage must install strictly from the lockfile (npm ci)"
grep -qF 'npm ci --omit=dev' "$SCRIPT_DIR/../Dockerfile" || fail "runtime stage must install strictly from the lockfile (npm ci --omit=dev)"
grep -q 'npm install --omit=dev' "$SCRIPT_DIR/../Dockerfile" && fail "runtime stage still uses npm install"
[ "$(grep -c '^FROM ${NODE_IMAGE} AS' "$SCRIPT_DIR/../Dockerfile")" = 2 ] || fail "both stages must build FROM \${NODE_IMAGE} (the resolved digest)"
grep -qF 'ENV DJIMITFLO_BUILD_LOCK_SHA256=$LOCKFILE_SHA256' "$SCRIPT_DIR/../Dockerfile" || fail "Dockerfile must bake the lockfile hash"
grep -qF 'ENV DJIMITFLO_BUILD_BASE_IMAGE=$NODE_IMAGE' "$SCRIPT_DIR/../Dockerfile" || fail "Dockerfile must bake the base image reference"

# --- the remote script end to end against a stub host (no real docker/git): healthy deploys, every failure rolls back
STUB="$TMP/stub"; BIN="$STUB/bin"; mkdir -p "$BIN"
printf '#!/usr/bin/env bash\nshift; exec "$@"\n' > "$BIN/timeout"
printf '#!/usr/bin/env bash\nprintf "Avail\\n99999999\\n"\n' > "$BIN/df"
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/chown"; cp "$BIN/chown" "$BIN/sleep"
cat > "$BIN/git" <<EOF
#!/usr/bin/env bash
case "\$1" in clone) mkdir -p "\$4"; cp "$SRC/Dockerfile" "\$4/"; echo '{"lockfileVersion":3}' > "\$4/package-lock.json" ;; log) echo "$NEW stub" ;; esac
EOF
# docker: build records its build args; the env of the built image is what was passed; compose/inspect consult the live
# compose.yml (cwd) and the knobs in \$STUB/{fail-compose-new,unhealthy-new,unhealthy-old,running-id}
cat > "$BIN/docker" <<EOF
#!/usr/bin/env bash
new() { grep -q "image: djimitflo:main-$NEW" compose.yml; }
case "\$1" in
  build) shift; for a in "\$@"; do case "\$a" in *=*) echo "\$a" >> "$STUB/build-args" ;; esac; done; echo built ;;
  pull) exit 0 ;;
  images|rmi) exit 0 ;;
  image) case "\$2 \$4" in
      "inspect {{.Id}}") echo "$FAKE_ID" ;;
      "inspect "*RepoDigests*) echo "$BASE" ;;
      "inspect "*Config.Env*) sed -n 's/^VCS_REF=/DJIMITFLO_BUILD_COMMIT=/p; s/^LOCKFILE_SHA256=/DJIMITFLO_BUILD_LOCK_SHA256=/p; s/^NODE_IMAGE=/DJIMITFLO_BUILD_BASE_IMAGE=/p' "$STUB/build-args" ;;
      prune*) exit 0 ;; *) exit 1 ;; esac ;;
  compose) echo "up \$(sed -n 's/^ *image: //p' compose.yml)" >> "$STUB/compose-calls"; if new && [ -f "$STUB/fail-compose-new" ]; then echo "compose failed" >&2; exit 1; fi ;;
  inspect) case "\$3" in
      *Health*) if new && [ -f "$STUB/unhealthy-new" ]; then echo starting; elif ! new && [ -f "$STUB/unhealthy-old" ]; then echo unhealthy; else echo healthy; fi ;;
      *Image*) cat "$STUB/running-id" 2>/dev/null || echo "$FAKE_ID" ;; esac ;;
esac
EOF
chmod +x "$BIN"/*
host() {   # host [knob...] → runs the remote script on a fresh stub host; sets OUT, RC, HOST
  HOST="$(mktemp -d "$TMP/host.XXXX")"; rm -f "$STUB"/build-args "$STUB"/compose-calls "$STUB"/fail-compose-new "$STUB"/unhealthy-* "$STUB"/running-id
  for k in "$@"; do case "$k" in running-id) echo "sha256:other" > "$STUB/running-id" ;; *) touch "$STUB/$k" ;; esac; done
  printf 'services:\n  djimitflo:\n    image: djimitflo:main-%s\n    environment:\n      DJIMITFLO_COMMIT_SHA: %s\n    volumes:\n      - %s/runtime-source-%s:/workspace/djimitflo\n' \
    "$PREV" "$PREV_FULL" "$HOST" "$PREV" > "$HOST/compose.yml"
  cp "$HOST/compose.yml" "$TMP/compose.before"
  RC=0; OUT="$(remote_script | PATH="$BIN:$PATH" bash -s -- "$HOST" "$NEW_FULL" repo 2>&1)" || RC=$?
}
host
[ "$RC" = 0 ] || fail "healthy deploy failed ($RC): $OUT"
grep -q "image: djimitflo:main-$NEW" "$HOST/compose.yml" || fail "healthy deploy did not select the new image"
grep -qx "NODE_IMAGE=$BASE" "$STUB/build-args" || fail "the build was not given the resolved base digest"
ls "$HOST/build-receipts/"*.json >/dev/null 2>&1 || fail "healthy deploy wrote no receipt"
for knob in fail-compose-new unhealthy-new running-id; do
  host "$knob"
  [ "$RC" != 0 ] || fail "$knob: deploy reported success"
  cmp -s "$HOST/compose.yml" "$TMP/compose.before" || fail "$knob: compose.yml not restored to the previous build"
  [ "$(tail -n 1 "$STUB/compose-calls")" = "up djimitflo:main-$PREV" ] || fail "$knob: the previous container was not recreated"
  echo "$OUT" | grep -q "rolled back to $PREV (healthy)" || fail "$knob: rollback health not verified: $OUT"
done
host fail-compose-new unhealthy-old
[ "$RC" != 0 ] && echo "$OUT" | grep -q "ROLLBACK to $PREV NOT healthy" || fail "an unhealthy rollback must be reported: $OUT"
# an unresolvable base stops before anything is switched
FAKE_SAVE="$(cat "$BIN/docker")"; sed -i.bak 's|"inspect "\*RepoDigests\*) echo .*|"inspect "*RepoDigests*) exit 0 ;;|' "$BIN/docker"; rm -f "$BIN/docker.bak"
host
[ "$RC" != 0 ] && echo "$OUT" | grep -q "base image unresolved" || fail "unresolved base was not refused: $OUT"
cmp -s "$HOST/compose.yml" "$TMP/compose.before" && [ ! -e "$STUB/compose-calls" ] || fail "unresolved base touched compose"
printf '%s\n' "$FAKE_SAVE" > "$BIN/docker"
echo "deploy-vps selftest OK"
