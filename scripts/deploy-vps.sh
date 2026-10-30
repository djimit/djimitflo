#!/usr/bin/env bash
# deploy-vps.sh — deploy a commit of djimitflo to the agentical production VPS.
#
# Replaces a 4-step manual procedure whose easiest-to-forget step (chown of the fresh
# checkout to the container user, needed for objective-mode git worktrees) silently
# broke autonomy once. Steps, all on the VPS: fetch of the exact commit into a fresh root-only dir -> git archive ->
# clone/checkout of the runtime-source mount -> docker build -> chown 1001 -> back up compose.yml -> rewrite
# image/commit/mount -> recreate -> wait for healthy; if the new container is not healthy, roll compose.yml back and
# recreate the previous one.
#
# Dry-run by default (prints the remote script). Usage:
#   scripts/deploy-vps.sh <40-char-sha>                # dry run
#   scripts/deploy-vps.sh <40-char-sha> --apply        # deploy
#   scripts/deploy-vps.sh <40-char-sha> --apply --local  # deploy from the VPS itself (scripts/auto-deploy.sh)
# Overrides (env): DEPLOY_HOST (root@100.86.47.122) DEPLOY_PORT (22122)
#   DEPLOY_KEY (~/.ssh/id_ed25519_vps) DEPLOY_ROOT (/srv/djimitflo) DEPLOY_REPO_URL
#
# ponytail: single host, no blue/green; a failed health check means ~20s of downtime
# before rollback. Add a second container + proxy switch if zero-downtime ever matters.
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-root@100.86.47.122}"
DEPLOY_PORT="${DEPLOY_PORT:-22122}"
DEPLOY_KEY="${DEPLOY_KEY:-${HOME:-/root}/.ssh/id_ed25519_vps}"  # systemd units have no HOME (set -u)
DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/djimitflo}"
DEPLOY_REPO_URL="${DEPLOY_REPO_URL:-https://github.com/djimit/djimitflo.git}"

# rewrite_compose <compose.yml> <prev_short> <prev_full> <new_short> <new_full>
# Points image, DJIMITFLO_COMMIT_SHA and the runtime-source mount at the new commit.
rewrite_compose() {
  local file="$1" prev_short="$2" prev_full="$3" new_short="$4" new_full="$5"
  sed -i.deploy-bak \
    -e "s|image: djimitflo:main-${prev_short}|image: djimitflo:main-${new_short}|" \
    -e "s|DJIMITFLO_COMMIT_SHA: ${prev_full}|DJIMITFLO_COMMIT_SHA: ${new_full}|" \
    -e "s|runtime-source-${prev_short}:/workspace/djimitflo|runtime-source-${new_short}:/workspace/djimitflo|" \
    "$file"
  rm -f "${file}.deploy-bak"
  grep -q "image: djimitflo:main-${new_short}" "$file" && grep -q "runtime-source-${new_short}:/workspace/djimitflo" "$file"
}

# --- build receipt (forensic 2026-10-26 ROOT-001) ---------------------------------------------------------------------
# One immutable JSON per built image in $DEPLOY_ROOT/build-receipts/<image id>.json (write-once, read-only): the commit,
# the build inputs (lockfile, Dockerfile, the base image DIGEST the build was given, the commit's git tree the context was
# exported from) and the content-addressed image id.
# The image itself declares the commit, lockfile hash and base (DJIMITFLO_BUILD_COMMIT / _LOCK_SHA256 / _BASE_IMAGE). The
# deploy verifies the receipt before switching and the running container's image against it after the health wait.
# ponytail: local images, no registry — the image id is the digest; add signing/attestation if images ever get pushed.
sha256_file() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
resolve_base_image() {   # resolve_base_image <tag> → <repo>@sha256:… of the local image under that tag (pulled when absent)
  local tag="$1" repo d
  [ -n "$tag" ] || { echo "no base image tag (ARG NODE_IMAGE) in the Dockerfile" >&2; return 1; }
  repo="${tag%:*}"
  for _ in 1 2; do
    d="$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$tag" 2>/dev/null | grep -m 1 "^$repo@sha256:" || true)"
    [ -n "$d" ] && { echo "$d"; return 0; }
    docker pull -q "$tag" >/dev/null 2>&1 || true   # same as the old behaviour: the local tag, pulled only when absent
  done
  echo "base image $tag has no registry digest — not building an unbound image" >&2; return 1
}
write_build_receipt() {   # write_build_receipt <dir> <src> <sha> <image> <base ref> <build_time> [tree id] → prints the receipt path
  local dir="$1" src="$2" sha="$3" image="$4" base="$5" built="$6" tree="${7:-}" id lock dfile f tree_field=""
  [[ "$base" == *@sha256:* ]] || { echo "base image $base is not a digest" >&2; return 1; }
  id="$(docker image inspect -f '{{.Id}}' "$image")" && [ -n "$id" ] || { echo "cannot read the image id of $image" >&2; return 1; }
  lock="$(sha256_file "$src/package-lock.json")" && dfile="$(sha256_file "$src/Dockerfile")" || return 1
  mkdir -p "$dir"; f="$dir/${id#sha256:}.json"
  if [ -e "$f" ]; then   # write-once: the same image keeps its receipt; another commit claiming it is refused
    grep -qF "\"commit\":\"$sha\"" "$f" || { echo "receipt $f belongs to another commit — refusing" >&2; return 1; }
    echo "$f"; return 0
  fi
  [ -z "$tree" ] || tree_field=",\"source_tree\":\"$tree\""   # OPS-002: the git tree the build context was exported from
  printf '{"schema":"djimitflo.build-receipt/v1","commit":"%s"%s,"image":"%s","image_id":"%s","lockfile_sha256":"%s","dockerfile_sha256":"%s","base_image":"%s","build_time":"%s","build_source":"deploy-vps.sh"}\n' \
    "$sha" "$tree_field" "$image" "$id" "$lock" "$dfile" "$base" "$built" > "$f.tmp.$$" && chmod 0444 "$f.tmp.$$" && mv "$f.tmp.$$" "$f" && echo "$f"
}
verify_build_receipt() {   # verify_build_receipt <receipt> <src> <sha> <image> [tree id]: the image and source still are what was built
  # Without a tree id an old receipt (no source_tree) verifies as before; with one, the receipt must carry exactly that tree.
  local f="$1" src="$2" sha="$3" image="$4" tree="${5:-}" id lock dfile envs base
  [ -f "$f" ] || { echo "no build receipt at $f" >&2; return 1; }
  id="$(docker image inspect -f '{{.Id}}' "$image")" || return 1
  envs="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$image")" || return 1
  lock="$(sha256_file "$src/package-lock.json")" && dfile="$(sha256_file "$src/Dockerfile")" || return 1
  base="$(sed -n 's/.*"base_image":"\([^"]*\)".*/\1/p' "$f")"
  grep -qF "\"commit\":\"$sha\"" "$f" || { echo "receipt is not for commit $sha" >&2; return 1; }
  [ -z "$tree" ] || grep -qF "\"source_tree\":\"$tree\"" "$f" || { echo "receipt does not bind source tree $tree" >&2; return 1; }
  grep -qF "\"image_id\":\"$id\"" "$f" || { echo "$image is $id, not the receipt's image" >&2; return 1; }
  grep -qF "\"lockfile_sha256\":\"$lock\"" "$f" || { echo "package-lock.json changed since the build" >&2; return 1; }
  grep -qF "\"dockerfile_sha256\":\"$dfile\"" "$f" || { echo "Dockerfile hash missing from the receipt or changed since the build" >&2; return 1; }
  [[ "$base" == *@sha256:* ]] || { echo "receipt has no base image digest" >&2; return 1; }
  printf '%s\n' "$envs" | grep -qxF "DJIMITFLO_BUILD_COMMIT=$sha" || { echo "$image does not declare commit $sha" >&2; return 1; }
  printf '%s\n' "$envs" | grep -qxF "DJIMITFLO_BUILD_LOCK_SHA256=$lock" || { echo "$image does not declare the receipt's lockfile" >&2; return 1; }
  printf '%s\n' "$envs" | grep -qxF "DJIMITFLO_BUILD_BASE_IMAGE=$base" || { echo "$image was not built from the receipt's base $base" >&2; return 1; }
}

# trusted_path dir|private|file <path>: this runs as root, so what it enters, reads and writes must be root's.
#   dir      <path> (absolute, no . or .. component) and every directory above it up to / (as written: no symlink
#            anywhere) are owned by root and not group/other-writable — a sticky /tmp included
#   private  as dir, and <path> itself is root's 0700 (no group/other access at all)
#   file     <path> is a regular file (not a link) of root, not group/other-writable, in a trusted dir
# AUTO_DEPLOY_TRUSTED_UID (default 0: the test user stands in for root) and AUTO_DEPLOY_TRUSTED_PREFIX (unset: the tmp base
# whose ancestors are not checked) are selftest seams; prod must leave them unset.
trusted_path() {
  python3 -c '
import os, stat, sys
T = int(os.environ.get("AUTO_DEPLOY_TRUSTED_UID") or "0"); kind, path = sys.argv[1], sys.argv[2]
def bad(msg): sys.exit(f"not trusted: {msg}")
# the path exactly as written: absolute, no '.' or '..' component (only repeated/trailing slashes are dropped)
if not path.startswith("/"): bad(f"{path} is not an absolute path")
comps = [c for c in path.split("/") if c]
if any(c in (".", "..") for c in comps): bad(f"{path} has a . or .. component")
path = "/" + "/".join(comps)
if kind == "file":
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode): bad(f"{path} is not a regular file (link or other)")
    if st.st_uid != T: bad(f"{path} is owned by uid {st.st_uid}, not root")
    if st.st_mode & 0o022: bad(f"{path} is writable by group or others")
    comps = comps[:-1]
elif kind == "private":
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != T or st.st_mode & 0o077: bad(f"{path} is not a root-only (0700) directory of root")
# AUTO_DEPLOY_TRUSTED_PREFIX: test-only seam (never set in prod) — that dir and its ancestors are not checked
tp = os.environ.get("AUTO_DEPLOY_TRUSTED_PREFIX") or ""
if tp and (not tp.startswith("/") or any(c in (".", "..") for c in tp.split("/"))): bad(f"AUTO_DEPLOY_TRUSTED_PREFIX {tp} is not a clean absolute path")
tpc = [c for c in tp.split("/") if c] if tp else None
for i in range(len(comps), -1, -1):  # every prefix as written, deepest first (lstat): a symlink is refused, never resolved
    if tpc is not None and i <= len(tpc) and tpc[:i] == comps[:i]: continue
    p = "/" + "/".join(comps[:i])
    st = os.lstat(p)
    if stat.S_ISLNK(st.st_mode): bad(f"{p} is a symbolic link")
    if not stat.S_ISDIR(st.st_mode): bad(f"{p} is not a directory")
    if st.st_uid not in (0, T): bad(f"{p} is owned by uid {st.st_uid}, not root")
    if st.st_mode & 0o022: bad(f"{p} is writable by group or others")
' "$1" "$2" || { echo "refusing to deploy: $2 must be root-owned and not group/other-writable, and so must every directory above it (chown root:root, chmod 0711 for the deploy root)" >&2; return 1; }
}

# src_git <dir> <git args...>: git inside a runtime-source clone. A reused clone is the container's /workspace mount, so its
# repo-local config and hooks are the container's: run as root, they would run as root. So when this runs as root and the
# clone belongs to another uid, git runs as that uid (setpriv, no supplementary groups); and every call turns hooks,
# fsmonitor and the file:// transport off and ignores the system config.
src_git() {
  local dir="$1" own; shift
  local as=()
  if [ "$(id -u)" = 0 ]; then
    own="$(ls -nd "$dir" | awk '{print $3":"$4}')"
    [ "${own%%:*}" = 0 ] || as=(setpriv --reuid="${own%%:*}" --regid="${own##*:}" --clear-groups)
  fi
  env GIT_CONFIG_NOSYSTEM=1 ${as[@]+HOME=/nonexistent XDG_CONFIG_HOME=/nonexistent} ${as[@]+"${as[@]}"} \
    git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.file.allow=never -C "$dir" "$@"
}

# The script that runs on the VPS. Values are passed as positional args ($1..$4).
remote_script() {
  declare -f rewrite_compose sha256_file resolve_base_image write_build_receipt verify_build_receipt src_git trusted_path
  cat <<'REMOTE'
set -euo pipefail
ROOT="$1"; SHA="$2"; REPO="$3"; SHORT="${SHA:0:7}"
# before anything else: the deploy root (and every dir above it) and compose.yml are root's and only root can write them
trusted_path dir "$ROOT" || exit 1
trusted_path file "$ROOT/compose.yml" || exit 1
mkdir -p "$ROOT/build-receipts" && trusted_path dir "$ROOT/build-receipts" || exit 1
# temp and build dirs live in a root-only work dir
WORK="$ROOT/.deploy-work"; [ -d "$WORK" ] || mkdir -m 0700 "$WORK"
trusted_path private "$WORK" || exit 1
cd "$ROOT"
PREV_SHORT="$(sed -n 's/^ *image: djimitflo:main-\([0-9a-f]*\).*/\1/p' compose.yml | head -n 1)"
PREV_FULL="$(sed -n 's/^ *DJIMITFLO_COMMIT_SHA: \([0-9a-f]*\).*/\1/p' compose.yml | head -n 1)"
[ -n "$PREV_SHORT" ] && [ -n "$PREV_FULL" ] || { echo "cannot read current image/commit from compose.yml" >&2; exit 1; }
[ "$PREV_SHORT" != "$SHORT" ] || { echo "already deployed: $SHORT" >&2; exit 1; }
# Old builds (3 GB image + a clone each) filled the disk on 2026-09-21: SQLite hit disk I/O errors and the rollback target
# crash-looped too. Keep the newest 4 images/clones (plus the running and previous ones) and refuse to build without headroom.
# Nothing to prune is normal: under `set -euo pipefail` an empty grep -v returned 1 and turned every healthy deploy into
# exit 1 after the container was already up (prod 2026-09-28: auto-deploy never logged 'done', P2 never got its baseline).
prune_old_builds() {
  local keep_re="djimitflo:main-($SHORT|$PREV_SHORT)$"
  docker images --format '{{.Repository}}:{{.Tag}}' | grep '^djimitflo:main-' | grep -Ev "$keep_re" \
    | while read -r img; do echo "$(docker image inspect -f '{{.Created}}' "$img") $img"; done | sort -r | tail -n +5 | cut -d' ' -f2- \
    | while read -r img; do docker rmi "$img" >/dev/null 2>&1 || true; done || true
  { ls -dt runtime-source-* 2>/dev/null | grep -Ev "runtime-source-($SHORT|$PREV_SHORT)$" | tail -n +5 | xargs -r rm -rf; } || true
  # The legacy builder's builder-stage layers are untagged ('dangling'): pruning them after every healthy deploy made the
  # next build cold (builder apt-get 11.5 min on a slow mirror) and every first attempt hit the build timeout on 2026-09-28.
  # Keep a week of build cache; a low-disk prune ('all') still clears it.
  if [ "${1:-}" = all ]; then docker image prune -f >/dev/null 2>&1 || true; else docker image prune -f --filter until=168h >/dev/null 2>&1 || true; fi
}
AVAIL_KB="$(df --output=avail -k "$ROOT" | tail -n 1 | tr -d ' ')"
if [ "$AVAIL_KB" -lt 8000000 ]; then prune_old_builds all; AVAIL_KB="$(df --output=avail -k "$ROOT" | tail -n 1 | tr -d ' ')"; fi
[ "$AVAIL_KB" -ge 6000000 ] || { echo "not enough free disk to build (${AVAIL_KB} KB free); free space first" >&2; exit 1; }
# The build input is exactly $SHA, fetched into a fresh root-only (0700) dir in $WORK: never the runtime-source clone,
# which is reused on a retry and is the container's writable /workspace mount (its objects and refs, e.g. replace refs,
# are the container's). The fetch verifies every object it receives; FETCH_HEAD must be $SHA; the receipt binds that
# commit's tree. DEPLOY_FILE_REMOTE is a selftest seam (a local repo as remote); prod fetches over https, file transport off.
BUILD_SRC="$(mktemp -d "$WORK/build-src-$SHORT.XXXXXX")"; CTX=""; trap 'rm -rf "$BUILD_SRC" ${CTX:+"$CTX"}' EXIT
bgit() { GIT_CONFIG_NOSYSTEM=1 git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.file.allow="${DEPLOY_FILE_REMOTE:-never}" -C "$BUILD_SRC" "$@"; }
bgit init -q
bgit fetch -q --depth 1 --no-tags "$REPO" "$SHA" || { echo "cannot fetch $SHA from $REPO — not deploying" >&2; exit 1; }
[ "$(bgit rev-parse --verify 'FETCH_HEAD^{commit}')" = "$SHA" ] || { echo "the fetched commit is not $SHA — not deploying" >&2; exit 1; }
TREE="$(bgit rev-parse --verify "$SHA^{tree}")"
CTX="$(mktemp -d "$WORK/build-context-$SHORT.XXXXXX")"
bgit archive "$SHA" | tar -x -C "$CTX"
rm -rf "$BUILD_SRC"
# The runtime-source clone is only the container's mount: created (root's until the chown below) or reused (the
# container's; src_git runs git in it as its owner) and checked out at $SHA. It is not read for the build or the receipt.
if [ ! -d "runtime-source-$SHORT" ]; then GIT_CONFIG_NOSYSTEM=1 git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.file.allow="${DEPLOY_FILE_REMOTE:-never}" clone -q "$REPO" "runtime-source-$SHORT"; fi
src_git "runtime-source-$SHORT" checkout -q "$SHA"
src_git "runtime-source-$SHORT" log -1 --oneline
# OPS-002: `git checkout` keeps local edits and untracked files of a reused clone; they are the mount's, not the build's
DIRTY="$(src_git "runtime-source-$SHORT" status --porcelain --untracked-files=all 2>&1)" || DIRTY="git status failed: $DIRTY"
[ -z "$DIRTY" ] || echo "WARNING: runtime-source-$SHORT has local changes; it is not used for the build (fetched $SHA instead)" >&2
# a hung build (0% CPU for 17-20 min, 2026-09-25 and 26) blocked every deploy until killed by hand: bound it.
# --network host: on this VPS the docker bridge network stalls apt (g++ install: bridge timed out at 349 s, host 10 s)
BUILT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; LOCK="$(sha256_file "$CTX/package-lock.json")"
# the base image is pinned to the digest its tag resolves to here; the build gets that digest, the receipt records it
BASE="$(resolve_base_image "$(sed -n 's/^ARG NODE_IMAGE=//p' "$CTX/Dockerfile" | head -n 1)")" || { echo "base image unresolved — not deploying" >&2; exit 1; }
(cd "$CTX" && timeout "${DEPLOY_BUILD_TIMEOUT_S:-1200}" docker build --network host --build-arg NODE_IMAGE="$BASE" --build-arg VCS_REF="$SHA" --build-arg BUILD_SOURCE=deploy-vps.sh --build-arg BUILD_TIME="$BUILT" --build-arg LOCKFILE_SHA256="$LOCK" -t "djimitflo:main-$SHORT" . 2>&1 | tail -n 2)
# the build receipt binds commit, inputs and image id; no receipt or a mismatch means no switch
RECEIPT="$(write_build_receipt "$ROOT/build-receipts" "$CTX" "$SHA" "djimitflo:main-$SHORT" "$BASE" "$BUILT" "$TREE")" || { echo "build receipt failed — not deploying" >&2; exit 1; }
# The container runs as uid 1001; objective-mode needs a writable .git for git worktrees.
chown -R 1001:1001 "runtime-source-$SHORT"
verify_build_receipt "$RECEIPT" "$CTX" "$SHA" "djimitflo:main-$SHORT" "$TREE" || { echo "build receipt does not match the image — not deploying" >&2; exit 1; }
echo "build receipt $RECEIPT"
rm -rf "$CTX"
cp compose.yml "compose.yml.bak-$SHORT"
rewrite_compose compose.yml "$PREV_SHORT" "$PREV_FULL" "$SHORT" "$SHA" || { cp "compose.yml.bak-$SHORT" compose.yml; echo "compose rewrite failed" >&2; exit 1; }
# From here on compose.yml selects the new build: EVERY failure (a failing compose call under set -e included) restores the
# previous compose.yml, recreates the previous container and waits until it is healthy again.
rollback() {
  trap - ERR; set +e
  echo "$1; rolling back to $PREV_SHORT" >&2
  cp "compose.yml.bak-$SHORT" compose.yml
  docker compose up -d --force-recreate djimitflo 2>&1 | tail -n 1
  for _ in $(seq 1 12); do
    sleep 5
    [ "$(docker inspect -f '{{.State.Health.Status}}' djimitflo-live 2>/dev/null)" = healthy ] && { echo "rolled back to $PREV_SHORT (healthy)" >&2; exit 1; }
  done
  echo "ROLLBACK to $PREV_SHORT NOT healthy after 60s — operator action needed" >&2; exit 1
}
set -E; trap 'rollback "command failed after the compose rewrite (exit $?, line $LINENO)"' ERR
docker compose up -d --force-recreate djimitflo 2>&1 | tail -n 1 || rollback "docker compose up failed for $SHORT"
for _ in $(seq 1 12); do
  sleep 5
  STATE="$(docker inspect -f '{{.State.Health.Status}}' djimitflo-live 2>/dev/null || true)"
  if [ "$STATE" = "healthy" ]; then
    # healthy is not enough: the container must run the image the receipt was written for
    RUNNING_ID="$(docker inspect -f '{{.Image}}' djimitflo-live 2>/dev/null || true)"
    if [ -n "$RUNNING_ID" ] && grep -qF "\"image_id\":\"$RUNNING_ID\"" "$RECEIPT"; then
      trap - ERR; prune_old_builds || true   # housekeeping never fails a healthy deploy
      echo "deployed $SHORT (healthy, receipt $RECEIPT)"; exit 0
    fi
    rollback "healthy, but running image ${RUNNING_ID:-unknown} is not the receipt's"
  fi
done
rollback "NOT healthy after 60s (state: ${STATE:-unknown})"
REMOTE
}

main() {
  local sha="${1:-}" apply=false
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: $0 <40-char-sha> [--apply]" >&2; exit 2; }
  [ "${2:-}" = "--apply" ] && apply=true
  if ! $apply; then
    echo "# dry run — would run on ${DEPLOY_HOST}:${DEPLOY_PORT} (root ${DEPLOY_ROOT}, sha ${sha}); use --apply"
    remote_script
    return 0
  fi
  if [ "${3:-}" = "--local" ]; then
    remote_script | bash -s -- "$DEPLOY_ROOT" "$sha" "$DEPLOY_REPO_URL"
    return
  fi
  remote_script | ssh -o IdentitiesOnly=yes -i "$DEPLOY_KEY" -p "$DEPLOY_PORT" "$DEPLOY_HOST" bash -s -- "$DEPLOY_ROOT" "$sha" "$DEPLOY_REPO_URL"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
