#!/usr/bin/env bash
# Periodic benchmarks — the one-command operator runner for SEC-F1 and F1 (packages/server/src/services/benchmark-schedule.ts).
# Run it on the VPS host when the stall watch raises `benchmark:due:<id>` (BENCHMARK_SCHEDULE_MODE=on). It repeats the SEC-F1
# harness path (docs/research/eco/SEC-F1_RUN.md) unattended:
#   - a depth-1 fetch of djimit/djimitflo at the prod build (DJIMITFLO_BUILD_COMMIT of --container; --ref overrides) holds the
#     harness and the frozen items, mounted read-only — the harness is the code the prod image runs;
#   - throwaway containers on the prod image (the image of --container): no /data mount, no DB, not on the compose network;
#   - the reviewer is the prod checker prompt + prod OpenCodeExecutor (scripts/sec-f1-run.mjs --benchmark --role <role>), the
#     prod opencode env (OPENCODE_* / OLLAMA_* / DJIMITFLO_OPENCODE_MODEL / LOOP_REVIEWER_TIMEOUT_MS, never DB_PATH or a token);
#   - hard token cap per run: BENCHMARK_TOKEN_CAP from the prod env (benchmark-cli.js plan; default 6 M);
#   - it does not start while a real lease runs, and stops the reviewer (docker stop) as soon as one starts; the reason is recorded;
#   - one directory per month ($ROOT/<id>-YYYY-MM): a rerun resumes (finished items are skipped, the token total carries over);
#   - the result reaches the prod DB only through `benchmark-cli.js ingest --apply` inside the prod container, which writes one
#     benchmark_runs row and nothing else.
# Default is a DRY RUN that prints every command and changes nothing; --apply acts. An unknown flag fails (exit 64).
# Usage: scripts/benchmark-run.sh <sec-f1|f1> [--apply] [--container djimitflo-live] [--root /var/tmp/djimitflo-bench]
#          [--ref <sha|branch>] [--opencode-auth <host file>] [--poll <seconds>]
# Exit: 0 done (or dry run), 5 a real lease is running (not started), 64 usage, other = the failing step.
set -euo pipefail

usage() { echo "usage: $0 <sec-f1|f1> [--apply] [--container <name>] [--root <dir>] [--ref <ref>] [--opencode-auth <file>] [--poll <s>]" >&2; exit 64; }
[ $# -ge 1 ] || usage
BENCH=$1; shift
case "$BENCH" in
  sec-f1) ROLE=security_checker; ITEMS=docs/research/eco/sec-f1 ;;
  f1) ROLE=checker; ITEMS=docs/research/eco/f1 ;;
  *) usage ;;
esac
APPLY=0; C=djimitflo-live; ROOT=/var/tmp/djimitflo-bench; REF=; AUTH=; POLL=30
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --container) C=${2:?--container needs a value}; shift ;;
    --root) ROOT=${2:?--root needs a value}; shift ;;
    --ref) REF=${2:?--ref needs a value}; shift ;;
    --opencode-auth) AUTH=${2:?--opencode-auth needs a value}; shift ;;
    --poll) POLL=${2:?--poll needs a value}; shift ;;
    *) echo "unknown flag: $1" >&2; exit 64 ;;
  esac
  shift
done
case "$POLL" in ''|*[!0-9]*) echo "--poll must be whole seconds" >&2; exit 64 ;; esac

CLI="node /app/packages/server/dist/scripts/benchmark-cli.js"
DIST=/app/packages/server/dist
SLOT_DIR="$ROOT/$BENCH-$(date -u +%Y-%m)"
SRC="$SLOT_DIR/src"; OUT="$SLOT_DIR/out"; ENVF="$SLOT_DIR/run.env"; NAME="djimitflo-bench-$BENCH"
x() { printf '+ %s\n' "$*"; if [ "$APPLY" = 1 ]; then "$@"; fi; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if [ "$APPLY" != 1 ]; then
  echo "DRY RUN (no --apply): prints what $BENCH would run; nothing is executed. Slot dir $SLOT_DIR, container $C, ref ${REF:-<prod build sha>}."
fi

# 1. plan (read-only in the prod container): due state, token cap, idle
CAP='<token_cap from plan>'
echo "+ docker exec $C $CLI plan $BENCH"
if [ "$APPLY" = 1 ]; then
  PLAN=$(docker exec "$C" $CLI plan "$BENCH") && rc=0 || rc=$?
  echo "$PLAN"
  if [ "$rc" = 5 ]; then echo "a real lease is running: not starting $BENCH (the stall watch alerts again when idle)" >&2; exit 5; fi
  [ "$rc" = 0 ] || exit "$rc"
  CAP=$(printf '%s' "$PLAN" | sed -n 's/.*"token_cap":\([0-9][0-9]*\).*/\1/p')
  [ -n "$CAP" ] || { echo "no token_cap in the plan" >&2; exit 1; }
fi

# 2. source (harness + frozen items) and the output dir; a rerun in the same month reuses both (resume)
if [ "$APPLY" = 1 ]; then umask 022; mkdir -p "$SLOT_DIR"; fi
if [ -z "$REF" ]; then
  echo "+ docker exec $C printenv DJIMITFLO_BUILD_COMMIT"
  if [ "$APPLY" = 1 ]; then REF=$(docker exec "$C" printenv DJIMITFLO_BUILD_COMMIT || true); [ -n "$REF" ] && [ "$REF" != unknown ] || { echo "no DJIMITFLO_BUILD_COMMIT in $C: pass --ref" >&2; exit 1; }
  else REF='<prod build sha>'; fi
fi
if [ "$APPLY" != 1 ] || [ ! -d "$SRC/.git" ]; then
  x git init -q "$SRC"
  x git -C "$SRC" fetch -q --depth 1 https://github.com/djimit/djimitflo.git "$REF"
  x git -C "$SRC" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
fi
SHA='<source sha>'; MANIFEST_SHA='<manifest sha256>'; IMG='<prod image>'
if [ "$APPLY" = 1 ]; then
  SHA=$(git -C "$SRC" rev-parse HEAD)
  MANIFEST_SHA=$(sha256sum "$SRC/$ITEMS/manifest.json" | cut -d' ' -f1)
  IMG=$(docker inspect -f '{{.Config.Image}}' "$C")
fi
x mkdir -p "$OUT"
x chown 1001:1001 "$OUT"
echo "source $SHA, items $ITEMS (manifest $MANIFEST_SHA), image $IMG, role $ROLE, token cap $CAP"

RUN=(docker run --rm --entrypoint "" --user 1001:1001 -v "$SRC/scripts:/bench/scripts:ro" -v "$SRC/docs/research/eco:/bench/docs/research/eco:ro" -v "$OUT:/out" -w /tmp)
RUNNER=(node /bench/scripts/sec-f1-run.mjs --items "/bench/$ITEMS" --role "$ROLE" --benchmark --dist "$DIST" --work /out/work)

# 3. prepare (GitHub only, no model) and, for SEC-F1, the deterministic baseline (offline)
if [ "$BENCH" = sec-f1 ]; then x "${RUN[@]}" --network none "$IMG" cmp /bench/scripts/finding-fix-gate.mjs /app/scripts/finding-fix-gate.mjs; fi
x "${RUN[@]}" --network bridge "$IMG" "${RUNNER[@]}" --prepare-only
if [ "$BENCH" = sec-f1 ] && { [ "$APPLY" != 1 ] || [ ! -s "$OUT/baseline.jsonl" ]; }; then
  x "${RUN[@]}" --network none "$IMG" node /bench/scripts/sec-f1-baseline.mjs --dist "$DIST" --work /out/work --out /out/baseline.jsonl
fi

# 4. the reviewer run (the spend): prod opencode env only, detached, watched for real leases
echo "+ docker exec $C env | grep -E '^(OPENCODE_[A-Z_]*|OLLAMA_[A-Z_]*|DJIMITFLO_OPENCODE_MODEL|LOOP_REVIEWER_TIMEOUT_MS|RUNTIME_ENV_PASSTHROUGH)=' > $ENVF"
if [ "$APPLY" = 1 ]; then
  trap 'rm -f "$ENVF"' EXIT
  (umask 077; docker exec "$C" env | grep -E '^(OPENCODE_[A-Z_]*|OLLAMA_[A-Z_]*|DJIMITFLO_OPENCODE_MODEL|LOOP_REVIEWER_TIMEOUT_MS|RUNTIME_ENV_PASSTHROUGH)=' > "$ENVF" || true)
  rm -f "$OUT/abort.json"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
fi
AUTH_MOUNT=(); if [ -n "$AUTH" ]; then AUTH_MOUNT=(-v "$AUTH:/home/djimitflo/.local/share/opencode/auth.json:ro"); fi
# prod opencode's provider list (Ollama base URL, models) lives in the bind-mounted /app/opencode.json, not in the image or
# the env: without the same file mounted read-only every reviewer call fails in seconds (2026-11-13: exit 4, 0 tokens)
CFG='<host-opencode.json>'
echo "+ docker inspect $C → host source of /app/opencode.json"
if [ "$APPLY" = 1 ]; then
  CFG=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/opencode.json"}}{{.Source}}{{end}}{{end}}' "$C")
  [ -n "$CFG" ] && [ -f "$CFG" ] || { echo "$C has no /app/opencode.json bind mount: the reviewer would run without a provider" >&2; exit 1; }
fi
x docker run -d --name "$NAME" --entrypoint "" --user 1001:1001 -v "$SRC/scripts:/bench/scripts:ro" -v "$SRC/docs/research/eco:/bench/docs/research/eco:ro" -v "$OUT:/out" -w /tmp \
  --network bridge --env-file "$ENVF" --tmpfs /home/djimitflo:uid=1001,gid=1001 -e HOME=/home/djimitflo -v "$CFG:/app/opencode.json:ro" ${AUTH_MOUNT[@]+"${AUTH_MOUNT[@]}"} \
  "$IMG" "${RUNNER[@]}" --cap "$CAP" --out /out/results.jsonl
echo "+ every ${POLL}s: docker exec $C $CLI idle — exit 5 (a real lease started) → docker stop $NAME, reason in $OUT/abort.json"
RC=0
if [ "$APPLY" = 1 ]; then
  while [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)" = true ]; do
    IDLE=$(docker exec "$C" $CLI idle 2>&1) && irc=0 || irc=$?
    if [ "$irc" != 0 ]; then
      if [ "$irc" = 5 ]; then WHY="real lease started: $(printf '%s' "$IDLE" | sed -n 's/.*"running":\[{"id":"\([^"]*\)","role":"\([^"]*\)","runtime":"\([^"]*\)".*/\1 (\2, \3)/p')"
      else WHY="idle check failed (exit $irc): the control plane may be restarting"; fi
      printf '{"reason":"%s","at":"%s"}\n' "$(printf '%s' "$WHY" | tr -d '"\\')" "$(now)" > "$OUT/abort.json"
      echo "aborting $BENCH: $WHY" >&2
      docker stop -t 10 "$NAME" >/dev/null || true
      break
    fi
    sleep "$POLL"
  done
  RC=$(docker wait "$NAME" 2>/dev/null || echo 1)
  docker logs --tail 20 "$NAME" 2>&1 || true
  docker rm "$NAME" >/dev/null 2>&1 || true
  if [ "$RC" != 0 ] && [ ! -f "$OUT/abort.json" ]; then printf '{"reason":"runner exit %s (4 = harness fault: more than 2 no-verdicts in the first 10 items)","at":"%s"}\n' "$RC" "$(now)" > "$OUT/abort.json"; fi
  rm -f "$ENVF"
fi

# 5. score (offline); a failed score is ingested as a failed run
if [ "$BENCH" = sec-f1 ]; then SCORE=(node /bench/scripts/sec-f1-score.mjs --items "/bench/$ITEMS" --results /out/results.jsonl --baseline /out/baseline.jsonl --json /out/score.json)
else SCORE=(node /bench/scripts/f1-score.mjs --items "/bench/$ITEMS" --results /out/results.jsonl --json /out/score.json); fi
if [ "$APPLY" = 1 ]; then rm -f "$OUT/score.json"; fi
x "${RUN[@]}" --network none "$IMG" "${SCORE[@]}" || echo "scoring failed: the run is ingested as failed" >&2

# 6. ingest: the only prod DB write (one benchmark_runs row)
TMPC=/tmp/djimitflo-bench-$BENCH
x docker exec "$C" mkdir -p "$TMPC"
for f in results.jsonl score.json abort.json results.jsonl.d/run-meta.json; do
  if [ "$APPLY" != 1 ] || [ -f "$OUT/$f" ]; then x docker cp "$OUT/$f" "$C:$TMPC/$(basename "$f")"; fi
done
ING=(--benchmark "$BENCH" --results "$TMPC/results.jsonl" --score "$TMPC/score.json" --meta "$TMPC/run-meta.json" --manifest-sha "$MANIFEST_SHA" --source-sha "$SHA")
if [ "$APPLY" != 1 ] || [ -f "$OUT/abort.json" ]; then ING+=(--abort "$TMPC/abort.json"); fi
x docker exec "$C" $CLI ingest "${ING[@]}" --apply
x docker exec "$C" rm -rf "$TMPC"

# 7. clean up: checkouts go once the run finished (an aborted run keeps them for the resume); results stay in $OUT
if [ "$APPLY" != 1 ] || [ ! -f "$OUT/abort.json" ]; then x rm -rf "$OUT/work"; fi
echo "$BENCH: done (runner exit $RC); results in $OUT"
