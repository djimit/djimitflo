#!/usr/bin/env bash
# auto-deploy.sh — runs ON the VPS (systemd timer, scripts/systemd/) and deploys main when it is safe (plan WS-J / J2).
#
# Deploys only when ALL hold: main differs from what runs; every required context of main's branch protection has a
# success of its newest run on that commit (skipped/neutral/missing is not a pass) and no other check failed or runs;
# main has not moved for AUTO_DEPLOY_SETTLE_MIN minutes (a merge train becomes one deploy); no loop worker is running;
# no kill switch file; the commit's scripts/deploy-vps.sh matches the host-installed copy. The deploy itself is that
# host-installed copy of deploy-vps.sh (--local), with its health wait + rollback.
#   kill switch: touch /srv/djimitflo/AUTO_DEPLOY_DISABLED
#   deploy script: scripts/install-deploy-script.sh <sha> --apply (operator, as root on this host; /usr/local/lib/djimitflo)
# Every probe is overridable (AD_<NAME>, evaluated) so the decision logic is testable without a VPS (auto-deploy.test.ts).
set -euo pipefail
ROOT="${DEPLOY_ROOT:-/srv/djimitflo}"
REPO_SLUG="${AUTO_DEPLOY_REPO:-djimit/djimitflo}"
SETTLE_MIN="${AUTO_DEPLOY_SETTLE_MIN:-20}"
log() { echo "$(date -u +%FT%TZ) auto-deploy: $*"; }
# safe_fs: file operations of this root process next to directories other users can write (python3, *at() calls).
#   check <dir>                 every component of <dir> as given (no symlink anywhere) up to / is a directory owned by root
#                               (or AUTO_DEPLOY_TRUSTED_UID), not writable by group/others (a root-owned sticky dir such as
#                               /tmp is allowed)
#   copy <file> <dest>          <file> (owned by the trusted uid, not group/other-writable, regular, in a checked dir) is read
#                               once, without following a link, into <dest> (a new file in a private dir)
#   write <dir> <name> <keep> <stage>
#                               the last <keep> lines of <dir>/<name> plus stdin replace <dir>/<name>. A target that is a link
#                               or not a regular file is refused; the old content is read without following a link; the new
#                               content is written through an fd to a new file in <stage> (a 0700 dir of the trusted uid on the
#                               same filesystem, checked up to /) and renamed into <dir> with renameat(2), which replaces a
#                               name and never follows it. No pathname in <dir> is ever opened for writing or chmod-ed.
# AUTO_DEPLOY_TRUSTED_UID (default 0) and AUTO_DEPLOY_TEST_HOOK_AFTER_TEMP are test seams (auto-deploy.test.ts).
SAFE_FS_PY="$(cat <<'PY'
import os, secrets, stat, subprocess, sys
TRUSTED = int(os.environ.get("AUTO_DEPLOY_TRUSTED_UID") or "0")
def fail(msg):
    sys.stderr.write(msg); sys.exit(1)
def readall(fd):
    return b"".join(iter(lambda: os.read(fd, 1 << 16), b""))
def chain(path):
    # the path as given, component by component (lstat): a symlink anywhere on it is refused, never resolved
    p = os.path.abspath(path)
    while True:
        st = os.lstat(p)
        if stat.S_ISLNK(st.st_mode): fail(f"{p} is a symbolic link")
        if not stat.S_ISDIR(st.st_mode): fail(f"{p} is not a directory")
        if st.st_uid not in (0, TRUSTED): fail(f"{p} is owned by uid {st.st_uid}, not root")
        if st.st_mode & 0o022 and not (st.st_mode & stat.S_ISVTX and st.st_uid == 0): fail(f"{p} is writable by group or others")
        if p == "/": return
        p = os.path.dirname(p)
def opendir(path):
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
def main(cmd, *a):
    if cmd == "check":
        chain(a[0])
    elif cmd == "copy":
        src = os.path.abspath(a[0]); chain(os.path.dirname(src))
        fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK); st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode): fail(f"{src} is not a regular file")
        if st.st_uid != TRUSTED: fail(f"{src} is owned by uid {st.st_uid}, not root")
        if st.st_mode & 0o022: fail(f"{src} is writable by group or others")
        data = readall(fd)
        out = os.open(a[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600); os.write(out, data); os.close(out)
    elif cmd == "write":
        d, name, keep, stage = a[0], a[1], int(a[2]), a[3]
        if not name or "/" in name or name.startswith("."): fail(f"bad name {name!r}")
        if not os.path.lexists(stage): os.mkdir(stage, 0o700)
        chain(stage); sfd = opendir(stage); sst = os.fstat(sfd)
        if sst.st_uid != TRUSTED or sst.st_mode & 0o077: fail(f"{stage} is not a private (0700) directory of uid {TRUSTED}")
        dfd = opendir(d)
        if os.fstat(dfd).st_dev != sst.st_dev: fail(f"{stage} is not on the filesystem of {d}")
        try: cur = os.lstat(name, dir_fd=dfd)
        except FileNotFoundError: cur = None
        if cur is not None and not stat.S_ISREG(cur.st_mode): fail(f"{d}/{name} is not a regular file (link or other)")
        old = b""
        if keep > 0 and cur is not None:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
            if not stat.S_ISREG(os.fstat(fd).st_mode): fail(f"{d}/{name} is not a regular file")
            old = b"".join(readall(fd).splitlines(keepends=True)[-keep:])
        new = sys.stdin.buffer.read()
        tmp = f".{name}.{secrets.token_hex(8)}"
        tfd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=sfd)
        try:
            hook = os.environ.get("AUTO_DEPLOY_TEST_HOOK_AFTER_TEMP")
            if hook: subprocess.run(hook, shell=True, env={**os.environ, "TEMP_PATH": os.path.join(stage, tmp)})
            os.fchmod(tfd, 0o644); os.write(tfd, old + new); os.fsync(tfd)
            mine, there = os.fstat(tfd), os.lstat(tmp, dir_fd=sfd)
            if (mine.st_dev, mine.st_ino) != (there.st_dev, there.st_ino): fail(f"staged file in {stage} was replaced")
            os.rename(tmp, name, src_dir_fd=sfd, dst_dir_fd=dfd)
        except BaseException:
            try: os.unlink(tmp, dir_fd=sfd)
            except OSError: pass
            raise
    else:
        fail(f"unknown command {cmd}")
try:
    main(*sys.argv[1:])
except SystemExit:
    raise
except Exception as e:
    fail(f"{type(e).__name__}: {e}")
PY
)"
safe_fs() { python3 -c "$SAFE_FS_PY" "$@"; }
STAGE_DIR="${AUTO_DEPLOY_STAGE_DIR:-$ROOT/.auto-deploy-stage}"
# data_write <name> <keep>: stdin after the last <keep> lines of $ROOT/data/<name> (the container can write that dir)
data_write() {
  local err
  err="$(safe_fs write "$ROOT/data" "$1" "$2" "$STAGE_DIR" 2>&1 >/dev/null)" && return 0
  log "refusing to write $ROOT/data/$1: ${err:-failed} — left untouched"; return 1
}
# S1: deploy events for the operator cockpit, in the data dir the container mounts as /data (bounded to 1000 lines)
event() {
  [ -d "$ROOT/data" ] || return 0
  printf '{"at":"%s","event":"%s","sha":"%s","detail":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "${2:-}" "$(printf '%s' "${3:-}" | tr -d '"\\' | head -c 300)" \
    | data_write deploy-log.jsonl 999 || true
}

# Each probe runs $AD_<NAME> (eval) when set, the real command otherwise.
probe() { local name="$1"; shift; local override="AD_$name"; if [ -n "${!override:-}" ]; then eval "${!override}"; else "$@"; fi; }
main_sha()       { probe MAIN_SHA git ls-remote "https://github.com/$REPO_SLUG.git" refs/heads/main | cut -f1; }
current_sha()    { probe CURRENT_SHA sed -n 's/^ *DJIMITFLO_COMMIT_SHA: \([0-9a-f]*\).*/\1/p' "$ROOT/compose.yml" | head -n 1; }
check_runs()     { probe CHECKS curl -fsS "https://api.github.com/repos/$REPO_SLUG/commits/$1/check-runs?per_page=100"; }
commit_json()    { probe COMMIT curl -fsS "https://api.github.com/repos/$REPO_SLUG/commits/$1"; }
# required checks of main, one `context<TAB>app_id` per line (app_id empty = any source), from the public branch summary
# (no token needed); unreadable = empty = no deploy
required_from_github() {
  curl -fsS "https://api.github.com/repos/$REPO_SLUG/branches/main" | node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8")).protection?.required_status_checks ?? {};
    const out = new Map();
    for (const c of r.checks ?? []) if (c.context) out.set(c.context, typeof c.app_id === "number" && c.app_id >= 0 ? c.app_id : "");
    for (const n of r.contexts ?? []) if (n && !out.has(n)) out.set(n, "");
    console.log([...out].map(([c, a]) => `${c}\t${a}`).join("\n"));'
}
required_checks() { probe REQUIRED required_from_github; }
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
    log "post-deploy regression after ${dsha:0:8} (stalls: $(echo $blocking); restarts: $r) — auto-deploy paused"; event paused "$dsha" "stalls: $(echo $blocking); restarts: $r"; exit 0
  fi
  echo ok > "$ROOT/.deploy-verdict-$dsha"; log "post-deploy check ok for ${dsha:0:8}"; event verdict_ok "$dsha"
}
# S2 (DEP-01): this runs as root, so the deploy script it executes is the copy an operator installed on this host
# (scripts/install-deploy-script.sh) in a root-owned dir, never the one in the commit being deployed — that would make merge
# rights root. The installed copy and its record are trusted only when they and every directory above them are root's and
# not writable by group or others; each is read once into a private temp dir, and that copy is hashed and executed (a
# swap after the check reaches nothing). The commit's scripts/deploy-vps.sh is fetched only to compare: when it differs
# from the installed copy's record, or the installed copy no longer matches its record, auto-deploy pauses with the reason
# until the operator installs it.
INSTALL_DIR="${AUTO_DEPLOY_INSTALL_DIR:-/usr/local/lib/djimitflo}"
INSTALLED="$INSTALL_DIR/deploy-vps.installed.sh"
EXEC_STAGE=""
sha256_file() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
pause() { printf '%s\n' "$2" > "$ROOT/AUTO_DEPLOY_DISABLED"; log "$2 — auto-deploy paused"; event paused "$1" "$2"; exit 0; }
deploy_gate() { probe DEPLOY_GATE deploy_script_gate "$1"; }
deploy_script_gate() {
  local rec want err
  if [ ! -e "$INSTALLED" ] || [ ! -e "$INSTALLED.source" ]; then
    log "no host-installed deploy script ($INSTALLED) — not deploying $1. Review scripts/deploy-vps.sh at a commit, then as root on this host run: scripts/install-deploy-script.sh <sha> --apply"
    event refused "$1" "no host-installed deploy script"; exit 1
  fi
  EXEC_STAGE="$(mktemp -d)"; trap 'rm -rf "$EXEC_STAGE"' EXIT
  err="$(safe_fs copy "$INSTALLED" "$EXEC_STAGE/deploy-vps.sh" 2>&1 && safe_fs copy "$INSTALLED.source" "$EXEC_STAGE/deploy-vps.source" 2>&1)" || {
    log "host-installed deploy script is not trusted ($err) — not deploying $1. $INSTALL_DIR and every dir above it must be owned by root and not writable by group or others; reinstall with scripts/install-deploy-script.sh <sha> --apply"
    event refused "$1" "host-installed deploy script not trusted"; exit 1; }
  rec="$(sed -n 's/^sha256=//p' "$EXEC_STAGE/deploy-vps.source")"
  [ -n "$rec" ] && [ "$(sha256_file "$EXEC_STAGE/deploy-vps.sh")" = "$rec" ] || pause "$1" "$INSTALLED does not match its install record ($INSTALLED.source); reinstall it with scripts/install-deploy-script.sh <sha> --apply, then remove $ROOT/AUTO_DEPLOY_DISABLED"
  curl -fsS "https://raw.githubusercontent.com/$REPO_SLUG/$1/scripts/deploy-vps.sh" -o "$EXEC_STAGE/commit-deploy-vps.sh" || { log "cannot fetch scripts/deploy-vps.sh of $1 to compare — not deploying"; exit 1; }
  want="$(sha256_file "$EXEC_STAGE/commit-deploy-vps.sh")"
  [ "$want" = "$rec" ] || pause "$1" "scripts/deploy-vps.sh at $1 differs from the host-installed copy (installed from $(sed -n 's/^commit=//p' "$EXEC_STAGE/deploy-vps.source")); review it, then run scripts/install-deploy-script.sh $1 --apply and remove $ROOT/AUTO_DEPLOY_DISABLED"
}
deploy() { probe DEPLOY deploy_commit "$1"; }
# the verified private copy, not the installed pathname
deploy_commit() { [ -n "$EXEC_STAGE" ] || { log "no verified deploy script"; return 1; }; DEPLOY_ROOT="$ROOT" bash "$EXEC_STAGE/deploy-vps.sh" "$1" --apply --local; }

# S3 (fleet ≠ main): the event bus and agent registry under /srv are deployed by hand, outside the build receipt. Every run
# (also while paused) compares the sha256 of each service's deployed *.py with infra/<service>/*.py at the running commit
# (git objects of its runtime-source clone, read as the clone's owner: root never runs git in a repo the container can
# write) and writes $ROOT/data/fleet-drift.json for /health.fleet_drift.
# Services are `name=deployed_dir=repo_path`, space-separated; a service whose deployed dir is absent here is skipped.
# A check that cannot be made (no running commit, unreadable commit tree, no service here, a failing step) overwrites the
# file with {checked_at, commit, status:"unknown", reason}: a clean record is never left standing after a failed check.
FLEET_SERVICES="${AUTO_DEPLOY_FLEET_SERVICES:-event-bus=/srv/event-bus=infra/event-bus agent-registry=/srv/agent-registry=infra/agent-registry}"
sha256_stdin() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1; }
fleet_unknown() {   # fleet_unknown <commit> <reason>
  printf '{"checked_at":"%s","commit":"%s","status":"unknown","reason":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "$(printf '%s' "$2" | tr -d '"\\' | head -c 300)" \
    | data_write fleet-drift.json 0
}
# one "name sha256" line per *.py; every hash is run and checked before it is printed (a failure fails the whole list)
is_sha256() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }
deployed_lines() {
  local f h
  for f in "$1"/*.py; do
    [ -f "$f" ] || continue
    h="$(sha256_file "$f")" && is_sha256 "$h" || return 1
    printf '%s %s\n' "${f##*/}" "$h"
  done
}
main_lines() {   # uses the git command array g of fleet_drift
  local tree mode type oid f h
  tree="$("${g[@]}" ls-tree "$1" "$2/")" || return 1
  while read -r mode type oid f; do
    [ -n "$mode" ] && [ "$type" = blob ] && [[ "$f" == *.py ]] || continue
    h="$("${g[@]}" cat-file blob "$oid" | sha256_stdin)" && is_sha256 "$h" || return 1
    printf '%s %s\n' "${f##*/}" "$h"
  done <<<"$tree"
}
fleet_drift() {
  local commit="$1" repo="${AUTO_DEPLOY_FLEET_REPO:-$ROOT/runtime-source-${1:0:7}}" spec name dir src f deployed main json="" sep="" own
  [ -d "$ROOT/data" ] || return 0
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { fleet_unknown "" "running commit unreadable"; return 0; }
  local hard=(-c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.file.allow=never -C "$repo")
  local g=(env GIT_CONFIG_NOSYSTEM=1 git "${hard[@]}")
  if [ "$(id -u)" = 0 ] && [ -d "$repo" ]; then
    own="$(ls -nd "$repo" | awk '{print $3":"$4}')"
    [ "${own%%:*}" = 0 ] || g=(env HOME=/nonexistent XDG_CONFIG_HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 setpriv --reuid="${own%%:*}" --regid="${own##*:}" --clear-groups git "${hard[@]}")
  fi
  for spec in $FLEET_SERVICES; do
    IFS='=' read -r name dir src <<<"$spec"
    [ -d "$dir" ] || continue
    "${g[@]}" cat-file -e "$commit^{commit}" 2>/dev/null || { log "fleet drift: commit ${commit:0:8} not readable in $repo — unknown"; fleet_unknown "$commit" "commit not readable in $repo"; return 0; }
    deployed="$(deployed_lines "$dir")" && deployed="$(printf '%s\n' "$deployed" | sort | sha256_stdin)" && is_sha256 "$deployed" \
      || { fleet_unknown "$commit" "cannot hash $dir"; return 0; }
    main="$(main_lines "$commit" "$src")" && main="$(printf '%s\n' "$main" | sort | sha256_stdin)" && is_sha256 "$main" \
      || { fleet_unknown "$commit" "cannot read $src at the running commit"; return 0; }
    json+="$sep\"$name\":{\"deployed\":\"$deployed\",\"main\":\"$main\",\"match\":$([ "$deployed" = "$main" ] && echo true || echo false)}"; sep=","
    [ "$deployed" = "$main" ] || log "fleet drift: $name ($dir) differs from $src at ${commit:0:8}"
  done
  [ -n "$json" ] || { fleet_unknown "$commit" "no fleet service directory on this host"; return 0; }
  printf '{"checked_at":"%s","commit":"%s","status":"checked","services":{%s}}\n' "$(date -u +%FT%TZ)" "$commit" "$json" | data_write fleet-drift.json 0
}

# everything below writes into $ROOT as root (kill switch, verdicts, baseline) and trusts what it reads there
ROOT_ERR="$(safe_fs check "$ROOT" 2>&1)" || { log "$ROOT is not trusted ($ROOT_ERR) — not acting. It and every dir above it must be owned by root and not writable by group or others"; exit 1; }
FLEET_COMMIT="$(current_sha 2>/dev/null || true)"
fleet_drift "$FLEET_COMMIT" || { log "fleet drift check failed"; fleet_unknown "$FLEET_COMMIT" "check failed" || true; }
[ -e "$ROOT/AUTO_DEPLOY_DISABLED" ] && { log "disabled by kill switch"; exit 0; }
post_deploy_check
SHA="$(main_sha)"; CUR="$(current_sha)"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { log "cannot read main"; exit 1; }
[ "$SHA" = "$CUR" ] && { log "up to date ($SHA)"; exit 0; }

CHECKS="$(check_runs "$SHA")"
# forensic 2026-10-26 rank 9: a required check that was skipped never ran, so it is not a pass (it used to be: any
# success/skipped/neutral set deployed, even with a required check absent). Mirrors loop-auto-merge.ts / merge-train.sh.
REQUIRED="$(required_checks 2>/dev/null || true)"
[ -n "$REQUIRED" ] || { log "required checks unavailable for main — not deploying $SHA"; exit 0; }
WHY="$(REQUIRED="$REQUIRED" node -e '
  // checks that gate no code (the scheduled OpenWiki `update` job runs on main HEAD daily; prod 10-10 it held the deploy
  // of #738-#744 for its whole run, and when it fails — as on 08-10 and 09-10 — it would block every deploy until main moved)
  const ignore = new Set((process.env.AUTO_DEPLOY_IGNORE_CHECKS ?? "update").split(",").map((s) => s.trim()).filter(Boolean));
  // `context<TAB>app_id`: the required producer is part of the identity (a same-named run of another app never stands in)
  const required = process.env.REQUIRED.split("\n").filter((l) => l.trim()).map((l) => { const [context, app] = l.split("\t");
    return { context: context.trim(), app: /^\d+$/.test((app ?? "").trim()) ? Number(app) : null }; });
  const all = (JSON.parse(require("fs").readFileSync(0, "utf8")).check_runs || []).sort((a, b) => (a.id || 0) - (b.id || 0));
  // the newest run per producer and name decides (a rerun replaces the run it re-ran)
  const newest = new Map();
  for (const c of all) newest.set(`${c.app?.id ?? ""}\u0000${c.name}`, c);
  const of = (q) => all.filter((c) => c.name === q.context && (q.app === null || c.app?.id === q.app)).at(-1);
  const names = required.map((q) => q.context);
  const r = [...newest.values()].filter((c) => !ignore.has(c.name) || names.includes(c.name));
  const notSuccess = required.filter((q) => of(q) && of(q).status === "completed" && of(q).conclusion !== "success");
  const missing = required.filter((q) => !of(q)).map((q) => q.context);
  const bad = r.filter((c) => c.status !== "completed" || !["success", "skipped", "neutral"].includes(c.conclusion));
  const why = [notSuccess.length ? "required_not_success:" + notSuccess.map((q) => q.context + "=" + of(q).conclusion).join(",") : "",
    missing.length ? "required_missing:" + missing.join(",") : "", bad.length ? "not_green:" + bad.map((c) => c.name).join(",") : ""].filter(Boolean);
  console.log(why.join(" "));
  process.exit(why.length ? 1 : 0);' <<<"$CHECKS")" || { log "CI not green (yet) for $SHA: $WHY"; exit 0; }

AGE_MIN="$(commit_json "$SHA" | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(Math.floor((Date.now()-Date.parse(c.commit.committer.date))/60000))')"
[ "$AGE_MIN" -ge "$SETTLE_MIN" ] || { log "main is ${AGE_MIN} min old, settling until ${SETTLE_MIN}"; exit 0; }

RUNNING="$(running_leases)"
[ "$RUNNING" = "0" ] || { log "$RUNNING loop worker(s) running; not deploying mid-run"; exit 0; }

deploy_gate "$SHA"
log "deploying $SHA (was $CUR)"; event deploying "$SHA" "was $CUR"
deploy "$SHA" || { log "deploy of $SHA failed (deploy-vps.sh exited non-zero; it rolls back an unhealthy start)"; event failed "$SHA" "deploy-vps.sh exited non-zero"; exit 1; }
stalls | sed '/^$/d' > "$ROOT/.deploy-baseline"; echo "$SHA $(date +%s)" > "$ROOT/.last-deploy"
log "done $SHA"; event done "$SHA"
