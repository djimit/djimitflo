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
# an approved maker resumes inside the execution engine while its lease still says 'prepared' (prod 2026-09-25),
# so running loop-worker tasks count as busy too
running_leases() {
  probe LEASES docker exec -e NODE_PATH=/app/node_modules djimitflo-live node -e \
    "const D=require('better-sqlite3');console.log(new D('/data/djimitflo.sqlite',{readonly:true}).prepare(\"SELECT (SELECT COUNT(*) FROM worker_leases WHERE status='running') + (SELECT COUNT(*) FROM tasks WHERE status='running' AND id LIKE 'loop-worker-%') AS n\").get().n)"
}
# P2: what the stall watch reports now (one subsystem per line) and how often the container restarted
stalls() {
  probe STALLS docker exec -e NODE_PATH=/app/node_modules djimitflo-live node -e \
    "const D=require('better-sqlite3');const {detectStalls}=require('/app/packages/server/dist/services/stall-watch.js');console.log(detectStalls(new D('/data/djimitflo.sqlite',{readonly:true})).map((s)=>s.subsystem).join('\\n'))" 2>/dev/null || true
}
restarts() { probe RESTARTS docker inspect -f '{{.RestartCount}}' djimitflo-live 2>/dev/null || echo 0; }
# P2: deploy-vps.sh already rolls back an unhealthy start; this catches what only shows later. 15 min after a deploy
# (once per commit) a restart or a NEW structural stall (default: panel, goals — provider/host noise is only logged)
# pauses auto-deploy with the reason in the kill-switch file. Rollback stays a human decision.
post_deploy_check() {
  [ -f "$ROOT/.last-deploy" ] || return 0
  local dsha dts; read -r dsha dts < "$ROOT/.last-deploy"
  [ -f "$ROOT/.deploy-verdict-$dsha" ] && return 0
  [ $(( ($(date +%s) - dts) / 60 )) -ge "${AUTO_DEPLOY_VERDICT_MIN:-15}" ] || return 0
  local new blocking r
  new="$(comm -13 <(sort -u "$ROOT/.deploy-baseline" 2>/dev/null) <(stalls | sed '/^$/d' | sort -u))"
  blocking="$(printf '%s\n' "$new" | grep -xE "${AUTO_DEPLOY_REGRESSION_STALLS:-panel|goals}" || true)"
  r="$(restarts)"
  [ -n "$new" ] && log "new stalls since ${dsha:0:8}: $(echo $new)"
  if [ -n "$blocking" ] || [ "${r:-0}" != "0" ]; then
    printf 'post-deploy regression after %s: stalls [%s] restarts=%s\n' "$dsha" "$(echo $blocking)" "$r" > "$ROOT/AUTO_DEPLOY_DISABLED"
    echo regressed > "$ROOT/.deploy-verdict-$dsha"
    log "post-deploy regression after ${dsha:0:8} (stalls: $(echo $blocking); restarts: $r) — auto-deploy paused"; exit 0
  fi
  echo ok > "$ROOT/.deploy-verdict-$dsha"; log "post-deploy check ok for ${dsha:0:8}"
}
deploy() { probe DEPLOY deploy_commit "$1"; }
deploy_commit() {
  local tmp; tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
  # the deploy script of the commit being deployed, not whatever sits on the host
  curl -fsS "https://raw.githubusercontent.com/$REPO_SLUG/$1/scripts/deploy-vps.sh" -o "$tmp"
  DEPLOY_ROOT="$ROOT" bash "$tmp" "$1" --apply --local
}

[ -e "$ROOT/AUTO_DEPLOY_DISABLED" ] && { log "disabled by kill switch"; exit 0; }
post_deploy_check
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
deploy "$SHA" || { log "deploy of $SHA failed (deploy-vps.sh exited non-zero; it rolls back an unhealthy start)"; exit 1; }
stalls | sed '/^$/d' > "$ROOT/.deploy-baseline"; echo "$SHA $(date +%s)" > "$ROOT/.last-deploy"
log "done $SHA"
