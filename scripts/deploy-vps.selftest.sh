#!/usr/bin/env bash
# Self-check for deploy-vps.sh: the compose rewrite (pure function) and the shape of the
# remote script (chown before recreate, rollback present). Run: ./deploy-vps.selftest.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# resolved: the trust checks refuse a symlink on a path, and the temp dir can contain one (macOS /var → /private/var)
TMP="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$TMP"' EXIT
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
echo '{"lockfileVersion":3}' > "$SRC/package-lock.json"
# OPS-002: the receipt binds the commit's tree id; a wrong or missing tree fails when the caller states the expected tree
TREE_OK="$(printf 'e%.0s' $(seq 1 40))"; TREE_BAD="$(printf 'f%.0s' $(seq 1 40))"
RCPT2="$TMP/receipts-tree"
treercpt="$(write_build_receipt "$RCPT2" "$SRC" "$NEW_FULL" "djimitflo:main-$NEW" "$BASE" 2026-10-27T00:00:00Z "$TREE_OK")" || fail "write_build_receipt with a tree failed"
grep -qF "\"source_tree\":\"$TREE_OK\"" "$treercpt" || fail "receipt lacks the source tree id"
verify_build_receipt "$treercpt" "$SRC" "$NEW_FULL" "djimitflo:main-$NEW" "$TREE_OK" 2>/dev/null || fail "matching tree id rejected"
if verify_build_receipt "$treercpt" "$SRC" "$NEW_FULL" "djimitflo:main-$NEW" "$TREE_BAD" 2>/dev/null; then fail "receipt with a wrong tree id accepted"; fi
if verify_build_receipt "$receipt" "$SRC" "$NEW_FULL" "djimitflo:main-$NEW" "$TREE_OK" 2>/dev/null; then fail "receipt without a tree id accepted when a tree is expected"; fi
verify_build_receipt "$receipt" "$SRC" "$NEW_FULL" "djimitflo:main-$NEW" 2>/dev/null || fail "an old receipt (no tree id) must still verify without one"
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

# --- the remote script end to end against a stub host (stub docker, real git on a temp repo): healthy deploys, every
# failure rolls back
REPO_DIR="$TMP/repo"; mkdir -p "$REPO_DIR/packages/server/src"
cp "$SRC/Dockerfile" "$REPO_DIR/"; echo '{"lockfileVersion":3}' > "$REPO_DIR/package-lock.json"
echo 'export const v = "committed";' > "$REPO_DIR/packages/server/src/index.ts"
G() { git -C "$REPO_DIR" -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }
G init -q && G add -A && G commit -q -m init
NEW_FULL="$(G rev-parse HEAD)"; NEW="${NEW_FULL:0:7}"; NEW_TREE="$(G rev-parse "HEAD^{tree}")"
STUB="$TMP/stub"; BIN="$STUB/bin"; mkdir -p "$BIN"
printf '#!/usr/bin/env bash\nshift; exec "$@"\n' > "$BIN/timeout"
printf '#!/usr/bin/env bash\nprintf "Avail\\n99999999\\n"\n' > "$BIN/df"
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/chown"; cp "$BIN/chown" "$BIN/sleep"
# docker: build records its build args; the env of the built image is what was passed; compose/inspect consult the live
# compose.yml (cwd) and the knobs in \$STUB/{fail-compose-new,unhealthy-new,unhealthy-old,running-id}
cat > "$BIN/docker" <<EOF
#!/usr/bin/env bash
new() { grep -q "image: djimitflo:main-$NEW" compose.yml; }
case "\$1" in
  build) shift; for a in "\$@"; do case "\$a" in *=*) echo "\$a" >> "$STUB/build-args" ;; esac; done
    rm -rf "$STUB/ctx"; cp -R . "$STUB/ctx"; echo built ;;   # snapshot of the build context (cwd) as docker got it
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
  rm -rf "$STUB/ctx"; "${HOST_PREP:-true}" "$HOST"
  for k in "$@"; do case "$k" in running-id) echo "sha256:other" > "$STUB/running-id" ;; *) touch "$STUB/$k" ;; esac; done
  printf 'services:\n  djimitflo:\n    image: djimitflo:main-%s\n    environment:\n      DJIMITFLO_COMMIT_SHA: %s\n    volumes:\n      - %s/runtime-source-%s:/workspace/djimitflo\n' \
    "$PREV" "$PREV_FULL" "$HOST" "$PREV" > "$HOST/compose.yml"
  cp "$HOST/compose.yml" "$TMP/compose.before"
  # DEPLOY_FILE_REMOTE: seam — the stub host fetches from a local repo; prod fetches over https (file:// stays off)
  # AUTO_DEPLOY_TRUSTED_UID: seam — the test user stands in for root as the trusted owner of the deploy root
  RC=0; OUT="$(remote_script | AUTO_DEPLOY_TRUSTED_UID="${HOST_TRUSTED_UID:-$(id -u)}" DEPLOY_FILE_REMOTE=always PATH="${HOST_PATH_PREFIX:-}$BIN:$PATH" bash -s -- "$HOST" "$NEW_FULL" "$REPO_DIR" 2>&1)" || RC=$?
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

# --- OPS-002: the build context is an export of exactly $SHA, never the reused runtime-source checkout
SRC_FILE=packages/server/src/index.ts
committed() { cmp -s "$STUB/ctx/$SRC_FILE" "$REPO_DIR/$SRC_FILE"; }
# (3) clean exact-SHA checkout: accepted, the receipt carries the commit's tree id, no warning, the context is removed
host
[ "$RC" = 0 ] || fail "clean deploy failed ($RC): $OUT"
[ -d "$STUB/ctx" ] && committed || fail "clean deploy did not build the committed source"
grep -qF "\"source_tree\":\"$NEW_TREE\"" "$HOST/build-receipts/"*.json || fail "receipt lacks the commit tree id $NEW_TREE"
echo "$OUT" | grep -q "not used for the build" && fail "clean checkout reported as dirty: $OUT"
[ -z "$(ls -d "$HOST"/build-context-* "$HOST"/.deploy-work/* 2>/dev/null)" ] || fail "build context left behind"
[ ! -e "$STUB/ctx/.git" ] || fail "build context contains .git"
# a reused runtime-source-$SHORT (retry after a build timeout, or written to by a container) with local changes
reused() { git clone -q "$REPO_DIR" "$1/runtime-source-$NEW"; }
tracked_mod() { reused "$1"; echo 'export const v = "TAMPERED";' > "$1/runtime-source-$NEW/$SRC_FILE"; }
untracked() { reused "$1"; echo 'export const evil = 1;' > "$1/runtime-source-$NEW/packages/server/src/evil.ts"; }
# (1) a modified tracked file in the reused checkout is not built; the checkout is warned about and left as it is
HOST_PREP=tracked_mod host
[ "$RC" = 0 ] || fail "tracked-mod deploy failed ($RC): $OUT"
committed || fail "a modified tracked file in the reused checkout reached the build context"
grep -q TAMPERED "$HOST/runtime-source-$NEW/$SRC_FILE" || fail "the reused checkout was reset (user data must stay)"
echo "$OUT" | grep -q "runtime-source-$NEW .*not used for the build" || fail "dirty checkout not warned about: $OUT"
# (2) an untracked compilable file in the reused checkout is not in the build context
HOST_PREP=untracked host
[ "$RC" = 0 ] || fail "untracked deploy failed ($RC): $OUT"
[ ! -e "$STUB/ctx/packages/server/src/evil.ts" ] || fail "an untracked file in the reused checkout reached the build context"
[ -e "$HOST/runtime-source-$NEW/packages/server/src/evil.ts" ] || fail "the untracked file was deleted (user data must stay)"
echo "$OUT" | grep -q "not used for the build" || fail "untracked file not warned about: $OUT"
# --- git in a reused runtime-source clone (the container can write it) never runs repo-local hooks or fsmonitor, and when
# the deploy runs as root it runs as the clone's owner. Root is simulated: `id -u` says 0, setpriv records its call and
# execs the command as the (unchanged) test user.
MARK="$TMP/marker"; ROOTSIM="$TMP/rootsim"; mkdir -p "$ROOTSIM"
printf '#!/usr/bin/env bash\n[ "${1:-}" = -u ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n' > "$ROOTSIM/id"
printf '#!/usr/bin/env bash\necho "setpriv $*" >> "%s/setpriv-calls"\nwhile [ "${1#--}" != "$1" ]; do shift; done\nexec "$@"\n' "$STUB" > "$ROOTSIM/setpriv"
chmod +x "$ROOTSIM"/*
hooked() {
  reused "$1"; local r="$1/runtime-source-$NEW"
  printf '#!/bin/sh\necho hook >> "%s"\n' "$MARK" > "$r/.git/hooks/post-checkout"
  printf '#!/bin/sh\necho fsmonitor >> "%s"\n' "$MARK" > "$r/.git/fsmonitor.sh"
  chmod +x "$r/.git/hooks/post-checkout" "$r/.git/fsmonitor.sh"
  git -C "$r" config core.fsmonitor "$r/.git/fsmonitor.sh"; git -C "$r" config core.hooksPath "$r/.git/hooks"
}
rm -f "$MARK" "$STUB/setpriv-calls"
HOST_PATH_PREFIX="$ROOTSIM:" HOST_PREP=hooked host
[ "$RC" = 0 ] || fail "hooked-clone deploy failed ($RC): $OUT"
[ ! -e "$MARK" ] || fail "a repo-local hook or fsmonitor of the reused clone ran: $(tr '\n' ' ' < "$MARK")"
grep -q -- "--reuid=$(id -u) " "$STUB/setpriv-calls" 2>/dev/null || fail "git in the reused clone did not run as the clone's owner"
committed || fail "hooked clone: the build context is not the committed source"
# --- the build input never comes from the reused runtime-source clone: a replaced commit (git replace, a ref the container
# can write) makes $SHA resolve to other content there, but the build context and the receipt tree are the real commit's
replaced() {
  reused "$1"; local r="$1/runtime-source-$NEW" evil
  echo 'export const v = "REPLACED";' > "$r/$SRC_FILE"
  git -C "$r" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qam evil
  evil="$(git -C "$r" rev-parse HEAD)"; git -C "$r" reset -q --hard "$NEW_FULL"
  git -C "$r" replace "$NEW_FULL" "$evil"
  [ "$(git -C "$r" rev-parse "$NEW_FULL^{tree}")" != "$NEW_TREE" ] || fail "fixture: the replace did not take effect"
}
HOST_PREP=replaced host
[ "$RC" = 0 ] || fail "replaced-clone deploy failed ($RC): $OUT"
committed || fail "a replaced object in the reused clone reached the build context: $(cat "$STUB/ctx/$SRC_FILE")"
grep -qF "\"source_tree\":\"$NEW_TREE\"" "$HOST/build-receipts/"*.json || fail "the receipt tree came from the reused clone, not the commit"
[ -z "$(ls -d "$HOST"/.build-src-* "$HOST"/.deploy-work/* 2>/dev/null)" ] || fail "the fresh build clone was left behind"
# a fetch that does not yield exactly $SHA (here: the commit is not in the remote) stops before anything is built
NEW_SAVE="$NEW_FULL"; NEW_FULL="$(printf '1%.0s' $(seq 1 40))"; NEW="${NEW_FULL:0:7}"
host
[ "$RC" != 0 ] && [ ! -e "$STUB/ctx" ] || fail "a commit that cannot be fetched was built: $OUT"
cmp -s "$HOST/compose.yml" "$TMP/compose.before" || fail "a failed fetch touched compose"
NEW_FULL="$NEW_SAVE"; NEW="${NEW_FULL:0:7}"
# --- the deploy root must be trusted before anything happens: owned by root (the trusted uid) up to /, not group/other
# writable; compose.yml a regular file of root, not group/other-writable. Otherwise: refused before any git or build.
untouched() { [ ! -e "$STUB/build-args" ] && [ ! -e "$STUB/ctx" ] && [ ! -e "$STUB/compose-calls" ] && [ ! -e "$HOST/runtime-source-$NEW" ]; }
open_root() { chmod 0775 "$1"; }
HOST_PREP=open_root host
[ "$RC" != 0 ] && echo "$OUT" | grep -q "not trusted" && echo "$OUT" | grep -qF "$HOST" || fail "a group-writable deploy root was not refused: $OUT"
untouched || fail "a group-writable deploy root was acted on"
# another owner than root (in prod: the container's uid 1001); simulated by trusting a different uid than the test user
HOST_TRUSTED_UID=1001 host
[ "$RC" != 0 ] && echo "$OUT" | grep -q "owned by uid $(id -u)" || [ "$(id -u)" = 1001 ] || fail "a deploy root of another uid was not refused: $OUT"
untouched || fail "a deploy root of another uid was acted on"
HOST_PREP=true host; [ "$RC" = 0 ] || fail "baseline deploy failed: $OUT"
# compose.yml writable by group/others, or a link: refused
host_compose() {   # host_compose <prep on compose.yml> → like host, the prep runs after compose.yml was written
  HOST="$(mktemp -d "$TMP/host.XXXX")"; rm -f "$STUB"/build-args "$STUB"/compose-calls; rm -rf "$STUB/ctx"
  printf 'services:\n  djimitflo:\n    image: djimitflo:main-%s\n    environment:\n      DJIMITFLO_COMMIT_SHA: %s\n' "$PREV" "$PREV_FULL" > "$HOST/compose.yml"
  "$1" "$HOST/compose.yml"
  RC=0; OUT="$(remote_script | AUTO_DEPLOY_TRUSTED_UID="$(id -u)" DEPLOY_FILE_REMOTE=always PATH="$BIN:$PATH" bash -s -- "$HOST" "$NEW_FULL" "$REPO_DIR" 2>&1)" || RC=$?
}
gw() { chmod 0664 "$1"; }
linked() { mv "$1" "$1.real"; ln -s "$1.real" "$1"; }
for prep in gw linked; do
  host_compose "$prep"
  [ "$RC" != 0 ] && echo "$OUT" | grep -q "not trusted" || fail "$prep compose.yml was not refused: $OUT"
  untouched || fail "$prep compose.yml: acted on"
done
# a deploy root reached through a symlink in an untrusted dir is refused (the trusted target does not make it pass)
OPEN="$TMP/open"; mkdir -p "$OPEN"; chmod 0777 "$OPEN"
link_root() { ln -s "$1" "$OPEN/root-$(basename "$1")"; }
HOST_PREP=link_root host   # prepares a normal host, then runs the remote script on the link instead
RC=0; OUT="$(remote_script | AUTO_DEPLOY_TRUSTED_UID="$(id -u)" DEPLOY_FILE_REMOTE=always PATH="$BIN:$PATH" bash -s -- "$OPEN/root-$(basename "$HOST")" "$NEW_FULL" "$REPO_DIR" 2>&1)" || RC=$?
[ "$RC" != 0 ] && echo "$OUT" | grep -q "symbolic link" || fail "a deploy root behind a symlink was not refused: $OUT"
# the deploy root is checked as written: a '..' component or a relative path is refused, never normalised away
remote_on() {   # remote_on <root arg> [cwd] → runs the remote script on a fresh stub host addressed as <root arg>
  RC=0; OUT="$(cd "${2:-$TMP}" && remote_script | AUTO_DEPLOY_TRUSTED_UID="$(id -u)" DEPLOY_FILE_REMOTE=always PATH="$BIN:$PATH" bash -s -- "$1" "$NEW_FULL" "$REPO_DIR" 2>&1)" || RC=$?
}
fresh_host() { HOST="$(mktemp -d "$TMP/host.XXXX")"; mkdir "$HOST/sub"; rm -f "$STUB"/build-args "$STUB"/compose-calls; rm -rf "$STUB/ctx"
  printf 'services:\n  djimitflo:\n    image: djimitflo:main-%s\n    environment:\n      DJIMITFLO_COMMIT_SHA: %s\n' "$PREV" "$PREV_FULL" > "$HOST/compose.yml"; }
fresh_host; remote_on "$HOST/sub/.."
[ "$RC" != 0 ] && echo "$OUT" | grep -q ". or .. component" && untouched || fail "a deploy root with a .. component was not refused: $OUT"
fresh_host; remote_on "$HOST/../$(basename "$HOST")"
[ "$RC" != 0 ] && echo "$OUT" | grep -q ". or .. component" && untouched || fail "a /x/../x deploy root was not refused: $OUT"
fresh_host; remote_on "$(basename "$HOST")" "$TMP"
[ "$RC" != 0 ] && echo "$OUT" | grep -q "not an absolute path" && untouched || fail "a relative deploy root was not refused: $OUT"
echo "deploy-vps selftest OK"
