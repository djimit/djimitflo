#!/usr/bin/env bash
# maker-uid-probe.sh — S0 step 1 (MAKER_UID_SEPARATION): check, on a real djimitflo image, what a process can reach when it
# runs as the server uid (1001) and as the maker uid (1002). Builds nothing and touches no data: it starts a throwaway
# container from an EXISTING image with no network, no volumes and a canary JWT_SECRET, lays out a fixture
# /data/djimitflo.sqlite the way prod does (600, owned by the server uid), and runs the same probe the server runs per
# maker lease (packages/server/src/execution/executors/maker-uid-separation.ts PROBE_SCRIPT) as each uid.
#
# Usage (on a docker host that has the image, e.g. the VPS):
#   bash scripts/maker-uid-probe.sh djimitflo:main-<sha> [maker_uid]
# Exit 0: the server uid sees the exposure (control) AND the maker uid can neither write the DB nor read PID 1's
# environ. Exit 1: either claim failed (printed). Exit 2: usage / docker error.
set -euo pipefail

IMAGE="${1:-}"
MAKER_UID="${2:-1002}"
[ -n "$IMAGE" ] || { echo "usage: $0 <image> [maker_uid]" >&2; exit 2; }
NAME="djimitflo-uid-probe-$$"

# PID 1 = node as the image's USER (djimitflo, 1001), like the prod server; its env carries only the canary
docker run -d --rm --name "$NAME" --network none --memory 256m --pids-limit 64 \
  -e JWT_SECRET=uid-probe-canary-not-a-secret --entrypoint node "$IMAGE" -e 'setInterval(() => {}, 1 << 30)' >/dev/null \
  || { echo "docker run failed" >&2; exit 2; }
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

docker exec "$NAME" sh -c 'umask 077 && : > /data/djimitflo.sqlite'

# Keep in sync with PROBE_SCRIPT in maker-uid-separation.ts (the unit test compares the two).
# PROBE_SCRIPT_BEGIN
PROBE='db="$1"; e1=na; ep=na; [ -e /proc/1/environ ] && { e1=0; head -c 1 /proc/1/environ >/dev/null 2>&1 && e1=1; }; [ -e "/proc/$PPID/environ" ] && { ep=0; head -c 1 "/proc/$PPID/environ" >/dev/null 2>&1 && ep=1; }; dx=0; [ -e "$db" ] && dx=1; dw=0; [ -w "$db" ] && dw=1; dr=0; [ -r "$db" ] && dr=1; dd=0; [ -w "$(dirname "$db")" ] && dd=1; echo "uid=$(id -u) gid=$(id -g) db_exists=$dx db_writable=$dw db_readable=$dr db_dir_writable=$dd proc1_environ_readable=$e1 parent_environ_readable=$ep"'
# PROBE_SCRIPT_END

echo "image: $IMAGE"
echo "helpers: $(docker exec "$NAME" sh -c 'for b in setpriv runuser setcap; do command -v $b >/dev/null 2>&1 && printf "%s=yes " $b || printf "%s=no " $b; done')"
echo "server uid status: $(docker exec "$NAME" sh -c 'grep -E "^(NoNewPrivs|CapEff|CapBnd)" /proc/self/status | tr -s "\t " " " | tr "\n" " "')"

server="$(docker exec "$NAME" sh -c "$PROBE" probe /data/djimitflo.sqlite)"
maker="$(docker exec -u "$MAKER_UID:$MAKER_UID" "$NAME" sh -c "$PROBE" probe /data/djimitflo.sqlite)"
canary="$(docker exec -u "$MAKER_UID:$MAKER_UID" "$NAME" sh -c 'grep -c uid-probe-canary /proc/1/environ 2>/dev/null || echo denied')"
echo "as server (1001):        $server"
echo "as maker ($MAKER_UID):        $maker"
echo "maker reads canary:      $canary"

fail=0
case "$server" in *db_writable=1*proc1_environ_readable=1*) ;; *) echo "CONTROL FAILED: the server uid should see the exposure"; fail=1;; esac
case "$maker" in *db_writable=0*) ;; *) echo "FAIL: maker uid can write the DB"; fail=1;; esac
case "$maker" in *db_dir_writable=0*) ;; *) echo "FAIL: maker uid can write the DB directory"; fail=1;; esac
case "$maker" in *proc1_environ_readable=0*) ;; *) echo "FAIL: maker uid can read PID 1 environ"; fail=1;; esac
[ "$canary" = denied ] || { echo "FAIL: maker uid read the canary"; fail=1; }
[ "$fail" = 0 ] && echo "PASS: uid $MAKER_UID can neither write the DB nor read PID 1's environ in $IMAGE"
exit "$fail"
