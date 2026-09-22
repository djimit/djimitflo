#!/usr/bin/env bash
# deploy-vps.sh — deploy a commit of djimitflo to the agentical production VPS.
#
# Replaces a 4-step manual procedure whose easiest-to-forget step (chown of the fresh
# checkout to the container user, needed for objective-mode git worktrees) silently
# broke autonomy once. Steps, all on the VPS: clone -> checkout -> docker build ->
# chown 1001 -> back up compose.yml -> rewrite image/commit/mount -> recreate ->
# wait for healthy; if the new container is not healthy, roll compose.yml back and
# recreate the previous one.
#
# Dry-run by default (prints the remote script). Usage:
#   scripts/deploy-vps.sh <40-char-sha>                # dry run
#   scripts/deploy-vps.sh <40-char-sha> --apply        # deploy
# Overrides (env): DEPLOY_HOST (root@100.86.47.122) DEPLOY_PORT (22122)
#   DEPLOY_KEY (~/.ssh/id_ed25519_vps) DEPLOY_ROOT (/srv/djimitflo) DEPLOY_REPO_URL
#
# ponytail: single host, no blue/green; a failed health check means ~20s of downtime
# before rollback. Add a second container + proxy switch if zero-downtime ever matters.
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-root@100.86.47.122}"
DEPLOY_PORT="${DEPLOY_PORT:-22122}"
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/id_ed25519_vps}"
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

# The script that runs on the VPS. Values are passed as positional args ($1..$4).
remote_script() {
  cat <<'REMOTE'
set -euo pipefail
ROOT="$1"; SHA="$2"; REPO="$3"; SHORT="${SHA:0:7}"
cd "$ROOT"
PREV_SHORT="$(sed -n 's/^ *image: djimitflo:main-\([0-9a-f]*\).*/\1/p' compose.yml | head -n 1)"
PREV_FULL="$(sed -n 's/^ *DJIMITFLO_COMMIT_SHA: \([0-9a-f]*\).*/\1/p' compose.yml | head -n 1)"
[ -n "$PREV_SHORT" ] && [ -n "$PREV_FULL" ] || { echo "cannot read current image/commit from compose.yml" >&2; exit 1; }
[ "$PREV_SHORT" != "$SHORT" ] || { echo "already deployed: $SHORT" >&2; exit 1; }
# Old builds (3 GB image + a clone each) filled the disk on 2026-09-21: SQLite hit disk I/O errors and the rollback target
# crash-looped too. Keep the newest 4 images/clones (plus the running and previous ones) and refuse to build without headroom.
prune_old_builds() {
  local keep_re="djimitflo:main-($SHORT|$PREV_SHORT)$"
  docker images --format '{{.Repository}}:{{.Tag}}' | grep '^djimitflo:main-' | grep -Ev "$keep_re" \
    | while read -r img; do echo "$(docker image inspect -f '{{.Created}}' "$img") $img"; done | sort -r | tail -n +5 | cut -d' ' -f2- \
    | while read -r img; do docker rmi "$img" >/dev/null 2>&1 || true; done
  ls -dt runtime-source-* 2>/dev/null | grep -Ev "runtime-source-($SHORT|$PREV_SHORT)$" | tail -n +5 | xargs -r rm -rf
  docker image prune -f >/dev/null 2>&1 || true
}
AVAIL_KB="$(df --output=avail -k "$ROOT" | tail -n 1 | tr -d ' ')"
if [ "$AVAIL_KB" -lt 8000000 ]; then prune_old_builds; AVAIL_KB="$(df --output=avail -k "$ROOT" | tail -n 1 | tr -d ' ')"; fi
[ "$AVAIL_KB" -ge 6000000 ] || { echo "not enough free disk to build (${AVAIL_KB} KB free); free space first" >&2; exit 1; }
if [ ! -d "runtime-source-$SHORT" ]; then git clone -q "$REPO" "runtime-source-$SHORT"; fi
(cd "runtime-source-$SHORT" && git checkout -q "$SHA" && git log -1 --oneline)
(cd "runtime-source-$SHORT" && docker build -t "djimitflo:main-$SHORT" . 2>&1 | tail -n 2)
# The container runs as uid 1001; objective-mode needs a writable .git for git worktrees.
chown -R 1001:1001 "runtime-source-$SHORT"
cp compose.yml "compose.yml.bak-$SHORT"
sed -i \
  -e "s|image: djimitflo:main-$PREV_SHORT|image: djimitflo:main-$SHORT|" \
  -e "s|DJIMITFLO_COMMIT_SHA: $PREV_FULL|DJIMITFLO_COMMIT_SHA: $SHA|" \
  -e "s|runtime-source-$PREV_SHORT:/workspace/djimitflo|runtime-source-$SHORT:/workspace/djimitflo|" compose.yml
grep -q "runtime-source-$SHORT:/workspace/djimitflo" compose.yml || { cp "compose.yml.bak-$SHORT" compose.yml; echo "compose rewrite failed" >&2; exit 1; }
docker compose up -d --force-recreate djimitflo 2>&1 | tail -n 1
for _ in $(seq 1 12); do
  sleep 5
  STATE="$(docker inspect -f '{{.State.Health.Status}}' djimitflo-live 2>/dev/null || true)"
  [ "$STATE" = "healthy" ] && { prune_old_builds; echo "deployed $SHORT (healthy)"; exit 0; }
done
echo "NOT healthy after 60s (state: ${STATE:-unknown}); rolling back to $PREV_SHORT" >&2
cp "compose.yml.bak-$SHORT" compose.yml
docker compose up -d --force-recreate djimitflo 2>&1 | tail -n 1
exit 1
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
  remote_script | ssh -o IdentitiesOnly=yes -i "$DEPLOY_KEY" -p "$DEPLOY_PORT" "$DEPLOY_HOST" bash -s -- "$DEPLOY_ROOT" "$sha" "$DEPLOY_REPO_URL"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
