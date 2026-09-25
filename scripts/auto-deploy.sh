#!/usr/bin/env bash
# auto-deploy.sh — runs ON the VPS (systemd timer, scripts/systemd/) and deploys main when it is safe (plan WS-J / J2).
#
# Deploys only when ALL hold: main differs from what runs; every CI check on that commit completed successfully;
# main has not moved for AUTO_DEPLOY_SETTLE_MIN minutes (a merge train becomes one deploy); no loop worker is running;
# no kill switch file. The deploy itself is deploy-vps.sh of THAT commit (--local), with its health wait + rollback.
#   kill switch: touch /srv/djimitflo/AUTO_DEPLOY_DISABLED
# Every probe is overridable (AD_<NAME>, evaluated) so the decision logic is testable without a VPS (auto-deploy.test.ts).
set -euo pipefail
ROOT="${DEPLOY_ROOT:-/srv/djimitflo}"
REPO_SLUG="${AUTO_DEPLOY_REPO:-djimit/djimitflo}"
SETTLE_MIN="${AUTO_DEPLOY_SETTLE_MIN:-20}"
log() { echo "$(date -u +%FT%TZ) auto-deploy: $*"; }

# Each probe runs $AD_<NAME> (eval) when set, the real command otherwise.
probe() { local name="$1"; shift; local override="AD_$name"; if [ -n "${!override:-}" ]; then eval "${!override}"; else "$@"; fi; }
main_sha()       { probe MAIN_SHA git ls-remote "https://github.com/$REPO_SLUG.git" refs/heads/main | cut -f1; }
current_sha()    { probe CURRENT_SHA sed -n 's/^ *DJIMITFLO_COMMIT_SHA: \([0-9a-f]*\).*/\1/p' "$ROOT/compose.yml" | head -n 1; }
check_runs()     { probe CHECKS curl -fsS "https://api.github.com/repos/$REPO_SLUG/commits/$1/check-runs?per_page=100"; }
commit_json()    { probe COMMIT curl -fsS "https://api.github.com/repos/$REPO_SLUG/commits/$1"; }
running_leases() {
  probe LEASES docker exec -e NODE_PATH=/app/node_modules djimitflo-live node -e \
    "const D=require('better-sqlite3');console.log(new D('/data/djimitflo.sqlite',{readonly:true}).prepare(\"SELECT COUNT(*) n FROM worker_leases WHERE status='running'\").get().n)"
}
deploy() { probe DEPLOY deploy_commit "$1"; }
deploy_commit() {
  local tmp; tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
  # the deploy script of the commit being deployed, not whatever sits on the host
  curl -fsS "https://raw.githubusercontent.com/$REPO_SLUG/$1/scripts/deploy-vps.sh" -o "$tmp"
  DEPLOY_ROOT="$ROOT" bash "$tmp" "$1" --apply --local
}

[ -e "$ROOT/AUTO_DEPLOY_DISABLED" ] && { log "disabled by kill switch"; exit 0; }
SHA="$(main_sha)"; CUR="$(current_sha)"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { log "cannot read main"; exit 1; }
[ "$SHA" = "$CUR" ] && { log "up to date ($SHA)"; exit 0; }

CHECKS="$(check_runs "$SHA")"
node -e '
  const r = JSON.parse(require("fs").readFileSync(0, "utf8")).check_runs || [];
  const bad = r.filter((c) => c.status !== "completed" || !["success", "skipped", "neutral"].includes(c.conclusion));
  process.exit(r.length > 0 && bad.length === 0 ? 0 : 1);' <<<"$CHECKS" || { log "CI not green (yet) for $SHA"; exit 0; }

AGE_MIN="$(commit_json "$SHA" | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(Math.floor((Date.now()-Date.parse(c.commit.committer.date))/60000))')"
[ "$AGE_MIN" -ge "$SETTLE_MIN" ] || { log "main is ${AGE_MIN} min old, settling until ${SETTLE_MIN}"; exit 0; }

RUNNING="$(running_leases)"
[ "$RUNNING" = "0" ] || { log "$RUNNING loop worker(s) running; not deploying mid-run"; exit 0; }

log "deploying $SHA (was $CUR)"
deploy "$SHA"
log "done $SHA"
