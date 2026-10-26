#!/usr/bin/env bash
# merge-train.sh — idempotent merge train for djimitflo PRs (runbook: docs/runbooks/merge-train.md).
#
#   merge-train.sh run [--mark-ready] [--assertions F] LOG PR[@HEADSHA]...   apply: one PR after another (mutates GitHub)
#   merge-train.sh --dry-run [--assertions F] [--out F]                      read-only plan of every open loop PR
#   merge-train.sh rebase BRANCH OWN_N [PR]   rebuild BRANCH on main keeping its OWN_N top commits (stacked PRs)
#
# Incident #778 (2026-10-11): a queued `git rebase --onto origin/main HEAD~3 | tail -1 && git push -f` hit a
# conflict, the pipe hid the failure, HEAD was left at main and an EMPTY branch was force-pushed; GitHub closed the PR.
# Guarantees:
#  - live state (PR + main) is re-read before every action; the queue, the ledger and a patch-id are never proof alone:
#    SATISFIED requires the PR's net diff to be present on current main (reverse-applies, forward does not) and every
#    file the PR adds to exist there; anything else is FAIL_CLOSED.
#  - each merge intent (key = sha256(repo|pr|patch-id)) is claimed atomically (mkdir) and moves through
#    CLAIMED → RUNNING → MERGED | SATISFIED | FAIL_CLOSED | ESCALATED | SUPERSEDED | HOLD | CANCELLED in the ledger; a live
#    claim held by another worker makes this worker exit without acting; a stale claim (dead pid or older than
#    MT_CLAIM_TTL_S) is reclaimed only by a worker that then re-verifies live state.
#  - every mutation is preceded by a ledger entry; a ledger write that fails stops the worker (exit 8) before acting.
#  - drafts: draft→ready only with --mark-ready AND a READY policy verdict on the current head; otherwise HOLD.
#  - update-branch is pinned to the expected head; the NEW head is read back, CI eligibility of the old head is
#    discarded, CI is waited for on the new sha (bounded: MT_CI_TIMEOUT_S / MT_CI_POLL_S, TIMEOUT ⇒ HOLD), policy and
#    mergeability are re-read, and the merge is the REST merge with sha=<that head> (GitHub refuses any other head).
#  - a job queued for another head, or whose PR closed/reopened/moved meanwhile, exits SUPERSEDED — unless the ledger
#    shows the new head came from this intent's own update-branch (resume after a worker restart).
#  - --dry-run is read-only by construction: every gh call goes through ghx, which refuses anything but GET in that mode,
#    and the mutating wrappers refuse before reaching a probe.
#  - a rebuilt branch is pushed only if it reproduces the original change hunk for hunk and the remote still equals
#    its original head; a concurrent push is never overwritten and a refused push restores the local branch.
# Every external probe is overridable (MT_<NAME>, evaluated) so the logic is testable without GitHub
# (merge-train.test.ts, merge-train-correctness.test.ts).
set -euo pipefail
REPO_SLUG="${MERGE_TRAIN_REPO:-djimit/djimitflo}"
LEDGER="${MT_LEDGER:-$HOME/.djimit/merge-train.ledger.jsonl}"
CLAIMS="$(dirname "$LEDGER")/merge-train.claims"
BASE="${MT_BASE:-origin/main}"
BASE_BRANCH="${MT_BASE_BRANCH:-main}"
TTL="${MT_CLAIM_TTL_S:-7200}"
CI_TIMEOUT="${MT_CI_TIMEOUT_S:-3600}"; CI_POLL="${MT_CI_POLL_S:-45}"
SETTLE="${MT_HEAD_SETTLE_S:-30}"; SETTLE_POLL="${MT_HEAD_SETTLE_POLL_S:-5}"
GH_TIMEOUT="${MT_GH_TIMEOUT_S:-60}"
ASSERTIONS="${MT_ASSERTIONS:-}"
TEST_ONLY_DIFF_MAX=400                                     # loop-worker-executor-service.ts TEST_ONLY_DIFF_MAX
MARK_READY=0
READONLY=0
CUR_PR=""; CUR_HEAD=""; CUR_KEY=""
MT_TMP="$(mktemp -d)"
GH_CALL_LOG="$MT_TMP/gh-calls"

# --- the gh guard: the only door to GitHub ----------------------------------------------------------------------------
readonly_ok() {   # GET-only shapes: `gh api PATH [-q/--jq/--paginate]` and gh pr view|list|diff|checks
  case "${1:-}" in
    api) shift; local a
      for a in "$@"; do case "$a" in -X|-X*|--method|--method=*|-f|-f*|-F|-F*|--field|--field=*|--raw-field|--raw-field=*|--input|--input=*) return 1 ;; esac; done
      return 0 ;;
    pr) case "${2:-}" in view|list|diff|checks) return 0 ;; esac; return 1 ;;
    *) return 1 ;;
  esac
}
ghx() {
  if [ "$READONLY" = 1 ] && ! readonly_ok "$@"; then
    echo "REFUSED (read-only mode): gh $*" >&2
    if [ -n "${MT_REFUSED_LOG:-}" ]; then printf '%s\n' "$*" >> "$MT_REFUSED_LOG"; fi
    return 99
  fi
  printf '%s\n' "$*" >> "$GH_CALL_LOG" 2>/dev/null || true
  # bounded: a hung gh call is killed after MT_GH_TIMEOUT_S (SIGALRM survives exec), the caller sees a failure
  perl -e 'alarm shift @ARGV; exec @ARGV or exit 127' "$GH_TIMEOUT" gh "$@"
}
mutating() { if [ "$READONLY" = 1 ]; then echo "REFUSED (read-only mode): $1" >&2; return 99; fi; }

probe() { local name="$1"; shift; local override="MT_$name"; if [ -n "${!override:-}" ]; then ( eval "${!override}" ); else "$@"; fi; }   # override runs in a subshell, like the real command
# probe positional args keep the shape `<cmd> pr <verb> N --flag VALUE`: $4 = PR number, $6 = the sha
pr_view()   { probe PR_VIEW ghx pr view "$1" --repo "$REPO_SLUG" --json state,headRefOid,isDraft -q '"\(.state) \(.headRefOid) \(.isDraft)"'; }
pr_diff()   { probe PR_DIFF ghx pr diff "$1" --repo "$REPO_SLUG"; }
pr_checks() { probe CHECKS mt_gh pr checks-at "$1" --sha "$2"; }
pr_ready()  { mutating "pr ready $1" || return 99; probe READY ghx pr ready "$1" --repo "$REPO_SLUG"; }
pr_update() { mutating "update-branch $1" || return 99; probe UPDATE mt_gh pr update-branch "$1" --expected-head "$2"; }
pr_merge()  { mutating "merge $1" || return 99; probe MERGE mt_gh pr merge-at "$1" --sha "$2"; }
policy()    { probe POLICY policy_default "$1" "$2"; }
fetch_main(){ probe FETCH git fetch -q origin; }
main_sha()  { probe MAIN_SHA git rev-parse "$BASE"; }
push()      { mutating "git push $1" || return 99; probe PUSH git push --force-with-lease="refs/heads/$1:$2" -q origin "refs/heads/$1:refs/heads/$1"; }
pause()     { if [ -n "${MT_SLEEP:-}" ]; then probe SLEEP sleep "$1"; else sleep "$1" & wait $!; fi; }   # interruptible by a signal
post_rebuild() { probe POST_REBUILD true; }   # test hook only

mt_gh() {   # mt_gh pr <verb> N --flag VALUE: REST calls that gh has no pinned-sha subcommand for
  local verb="$2" n="$3" v="${5:-}"
  case "$verb" in
    update-branch) ghx api -X PUT "repos/$REPO_SLUG/pulls/$n/update-branch" -f "expected_head_sha=$v" ;;
    merge-at)      ghx api -X PUT "repos/$REPO_SLUG/pulls/$n/merge" -f merge_method=squash -f "sha=$v" ;;
    checks-at)     checks_verdict "$v" | jq -r 'if .verdict == "green" then "pass" elif .verdict == "red" then "fail red:\(.red|join(","))\(if .reason then " " + .reason else "" end)"
                     else "pending missing:\(.missing|join(",")) pending:\(.pending|join(","))\(if .reason then " " + .reason else "" end)" end' ;;
    *) echo "mt_gh: unknown verb $verb" >&2; return 64 ;;
  esac
}

now() { date -u +%FT%TZ; }
record() {
  printf '{"at":"%s","event":"%s","pr":"%s","head":"%s","key":"%s","detail":"%s"}\n' "$(now)" "$1" "$2" "${3:-}" "${4:-}" \
    "$(printf '%s' "${5:-}" | tr -d '"\\' | tr '\n' ' ' | head -c 200)" >> "$LEDGER" 2>/dev/null \
    || { echo "LEDGER WRITE FAILED ($LEDGER, event $1 #$2) — FAIL_CLOSED, stopping before any further action" >&2; exit 8; }
}
sha256() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1; }
intent_key() { printf '%s|%s|%s' "$REPO_SLUG" "$1" "$2" | sha256; }
superseded() { grep -q "\"event\":\"superseded\",\"pr\":\"$1\",\"head\":\"$2\"" "$LEDGER"; }
own_update() { grep -q "\"event\":\"branch_updated\",\"pr\":\"$1\",\"head\":\"$2\",\"key\":\"$3\"" "$LEDGER"; }

# --- CI on one exact sha (mirrors loop-auto-merge.ts checks() + the required contexts of branch protection) -----------
required_json() {   # unreadable protection is never replaced by a remembered list: source unavailable ⇒ HOLD, re-read next call
  local f="$MT_TMP/required.json"
  if [ ! -s "$f" ]; then
    local src ctx q='[(.contexts // [])[], ((.checks // [])[] | .context)] | unique | join(",")'
    if [ -n "${MT_REQUIRED_CHECKS:-}" ]; then src=env; ctx="$MT_REQUIRED_CHECKS"
    elif ctx="$(ghx api "repos/$REPO_SLUG/branches/$BASE_BRANCH/protection/required_status_checks" -q "$q" 2>/dev/null)" && [ -n "$ctx" ]; then src=branch_protection
    elif ctx="$(ghx api "repos/$REPO_SLUG/branches/$BASE_BRANCH" -q ".protection.required_status_checks // {} | $q" 2>/dev/null)" && [ -n "$ctx" ]; then src=branch_protection   # read access suffices
    else src=unavailable; ctx=""; fi
    jq -cn --arg c "$ctx" --arg s "$src" '{source: $s, contexts: ($c | split(",") | map(select(length > 0)))}' > "$f.new"
    if [ "$src" = unavailable ]; then cat "$f.new"; return 0; fi
    mv "$f.new" "$f"
  fi
  cat "$f"
}
json_or_null() { if printf '%s' "$1" | jq -e 'type == "object" or type == "array"' >/dev/null 2>&1; then printf '%s' "$1"; else printf 'null'; fi; }
checks_verdict() {   # → {verdict: green|pending|red, red, pending, missing, reason?}
  local sha="$1" runs st
  local d; d="$(mktemp -d "$MT_TMP/ci.XXXXXX")"
  runs="$(ghx api "repos/$REPO_SLUG/commits/$sha/check-runs?per_page=100" 2>/dev/null || true)"
  st="$(ghx api "repos/$REPO_SLUG/commits/$sha/status" 2>/dev/null || true)"
  json_or_null "$runs" > "$d/runs.json"; json_or_null "$st" > "$d/status.json"   # files, not argv: responses can be large
  jq -cn --slurpfile R "$d/runs.json" --slurpfile S "$d/status.json" --argjson req "$(required_json)" '
    def newest(k): group_by(k) | map(max_by([(.id // 0), (.completed_at // .updated_at // "")]));   # a rerun replaces the run it re-ran
    $R[0] as $runs | $S[0] as $st |
    if $req.source == "unavailable" then {verdict: "pending", red: [], pending: [], missing: [], reason: "required_checks_unavailable"}
    elif $runs == null then {verdict: "pending", red: [], pending: [], missing: $req.contexts, reason: "check_runs_unavailable"} else
    ($runs.check_runs // [] | newest(.name)) as $cr | (($st // {}).statuses // [] | newest(.context)) as $ss | (($st // {}).state // "") as $state |
    # a REQUIRED context is green only on success: skipped, neutral, cancelled, stale (any other completed conclusion) is red
    ([$cr[] | select(.status == "completed" and .conclusion != "success" and (.name | IN($req.contexts[]))) | {n: .name, c: .conclusion}]
      + [$ss[] | select((.state | IN("success", "pending") | not) and (.context | IN($req.contexts[]))) | {n: .context, c: .state}]) as $reqbad |
    ([$cr[] | select(.status == "completed" and (.conclusion | IN("failure", "timed_out", "action_required", "startup_failure"))) | .name]
      + [$ss[] | select(.state == "failure" or .state == "error") | .context] + [$reqbad[].n] | unique) as $red |
    ([$cr[] | select(.status != "completed" or .conclusion == "cancelled" or .conclusion == "stale") | .name]
      + [$ss[] | select(.state == "pending") | .context]) as $pend |
    ([$cr[].name] + [$ss[].context]) as $seen |
    [$req.contexts[] | . as $r | select(($seen | index($r)) == null)] as $missing |
    {verdict: (if ($red | length) > 0 or $state == "failure" or $state == "error" then "red"
               elif ($pend | length) > 0 or ($missing | length) > 0 or (($cr | length) + ($ss | length)) == 0 then "pending"
               else "green" end), red: $red, pending: $pend, missing: $missing}
    + (if ($reqbad | length) > 0 then {reason: ("required_not_success:" + ([$reqbad[] | "\(.n)=\(.c)"] | join(",")))} else {} end) end'
}

# --- eligibility (mirrors the #754 shadow: loop-auto-merge.ts runAutoMergeTick, applied to the CURRENT head) ---------
audit_sample() { local h; h="$(printf 'loop-auto-merge:%s' "$1" | sha256 | cut -c1-8)"; [ $(( 16#$h % 100 )) -lt 10 ]; }
classify_pr() {   # classify_pr N → one JSON object; never READY on missing data
  local n="$1" d="$MT_TMP/pr-$1"; mkdir -p "$d"
  local pr files reviews entry
  pr="$(json_or_null "$(ghx api "repos/$REPO_SLUG/pulls/$n" 2>/dev/null || true)")"
  files="[]"; local page batch
  for page in 1 2 3 4 5 6 7 8 9 10; do
    batch="$(json_or_null "$(ghx api "repos/$REPO_SLUG/pulls/$n/files?per_page=100&page=$page" 2>/dev/null || true)")"
    [ "$batch" = null ] && { files=null; break; }
    printf '%s' "$files" > "$d/acc.json"; printf '%s' "$batch" > "$d/batch.json"; files="$(jq -cs 'add' "$d/acc.json" "$d/batch.json")"
    [ "$(jq 'length' <<<"$batch")" -lt 100 ] && break
  done
  reviews="$(json_or_null "$(ghx api "repos/$REPO_SLUG/pulls/$n/reviews?per_page=100" 2>/dev/null || true)")"
  local sha="" ci='{"verdict":"pending","red":[],"pending":[],"missing":[],"reason":"no_head"}'
  [ "$pr" != null ] && sha="$(jq -r '.head.sha // ""' <<<"$pr")"
  [ -n "$sha" ] && ci="$(checks_verdict "$sha")"
  entry=null
  if [ -n "$ASSERTIONS" ]; then entry="$(jq -c --arg n "$n" '.prs[$n] // null' "$ASSERTIONS")"; fi
  local audit=false; audit_sample "$n" && audit=true
  printf '%s' "$pr" > "$d/pr.json"; printf '%s' "$files" > "$d/files.json"; printf '%s' "$reviews" > "$d/reviews.json"
  jq -cn --slurpfile p "$d/pr.json" --slurpfile f "$d/files.json" --slurpfile rv "$d/reviews.json" --argjson ci "$ci" \
    --argjson e "$entry" --argjson audit "$audit" --arg repo "$REPO_SLUG" --arg base "$BASE_BRANCH" --arg n "$n" \
    --argjson limit "$TEST_ONLY_DIFF_MAX" --arg assertions_given "${ASSERTIONS:+1}" '
    $p[0] as $pr | $f[0] as $files | $rv[0] as $reviews |
    def B(rank; cat; code): {rank: rank, cat: cat, code: code};
    def testfile: test("(^|/)__tests__/|\\.(test|spec)\\.[cm]?[jt]sx?$");
    (if $pr == null then [] else [$pr.labels[]?.name] end) as $labels |
    ([
      (if ($labels | index("gap-orphan")) then B(1; "GAP_ORPHAN"; "gap_orphan_label") else empty end),
      (if $pr != null and $pr.state != "open" then B(2; "POLICY_BLOCKED"; "not_open:\($pr.state)") else empty end),
      (if $pr != null and ((($pr.title // "") | startswith("loop:")) | not) then B(2; "POLICY_BLOCKED"; "not_loop_pr:title") else empty end),
      (if $pr != null and ((($pr.user.login // "") | test("dependabot"; "i")) or (($pr.head.ref // "") | startswith("dependabot/"))) then B(2; "POLICY_BLOCKED"; "not_loop_pr:dependabot") else empty end),
      (if $pr != null and ($pr.head.repo.full_name // "") != $repo then B(2; "POLICY_BLOCKED"; "not_loop_pr:head_repo") else empty end),
      (if $pr != null and ($pr.base.ref // "") != $base then B(2; "POLICY_BLOCKED"; "not_loop_pr:base") else empty end),
      (if $pr != null and ((($pr.head.ref // "") | startswith("agent/")) | not) then B(2; "POLICY_BLOCKED"; "not_loop_pr:branch") else empty end),
      (if $pr != null and $e != null and $e.maker_branch != null and $e.maker_branch != $pr.head.ref then B(2; "POLICY_BLOCKED"; "not_loop_pr:maker_branch") else empty end),
      (if $e != null and $e.run_verified == false then B(2; "POLICY_BLOCKED"; "not_verified") else empty end),
      (if $files != null and ($files | length) > 0 then
        ([$files[].filename | select(testfile | not)] as $nt | if ($nt | length) > 0 then B(2; "POLICY_BLOCKED"; "non_test_file:\($nt[0])") else empty end),
        ([$files[] | select(.status == "removed") | .filename] as $rm | if ($rm | length) > 0 then B(2; "POLICY_BLOCKED"; "removes_test:\($rm[0])") else empty end),
        (([$files[] | (.additions // 0) + (.deletions // 0)] | add) as $d | (if $e != null and (($e.diff_max // 0) > 0) then $e.diff_max else $limit end) as $lim
          | if $d > $lim then B(2; "POLICY_BLOCKED"; "diff_over_limit:\($d)>\($lim)") else empty end)
       else empty end),
      (if $reviews != null then
        (reduce ($reviews[] | select(.state != null and .state != "COMMENTED" and .state != "PENDING")) as $r ({}; .[($r.user.login // "?")] = $r.state)
          | if ([.[]] | index("CHANGES_REQUESTED")) then B(2; "POLICY_BLOCKED"; "changes_requested") else empty end)
       else empty end),
      (if $e == null then B(3; "ASSERTION_BLOCKED"; (if $assertions_given == "" then "assertion_input_not_given" else "assertion_verdict_absent_from_input" end))
       elif ($e.assertion_strength // "missing") != "pass" then B(3; "ASSERTION_BLOCKED"; "assertion_strength_\($e.assertion_strength // "missing")")
       else empty end),
      (if $ci.verdict == "red" then B(4; "CI_BLOCKED"; "checks_red:\($ci.red | join(","))") else empty end),
      (if $ci.verdict == "pending" and ($ci.missing | length) > 0 then B(4; "CI_BLOCKED"; "required_check_missing:\($ci.missing | join(","))") else empty end),
      (if $ci.verdict == "pending" and ($ci.pending | length) > 0 then B(4; "CI_BLOCKED"; "checks_pending:\($ci.pending | join(","))") else empty end),
      (if $ci.verdict == "pending" and ($ci.missing | length) == 0 and ($ci.pending | length) == 0 then B(4; "CI_BLOCKED"; "checks_not_reported\(if $ci.reason then ":" + $ci.reason else "" end)") else empty end),
      (if $pr != null and ($pr.mergeable == false or $pr.mergeable_state == "dirty") then B(5; "CONFLICTED"; "merge_conflict") else empty end),
      (if $audit then B(6; "POLICY_BLOCKED"; "audit_sample_10pct") else empty end)
    ]) as $blockers |
    ([
      (if $pr == null then "pr_unavailable" else empty end),
      (if $files == null then "files_unavailable" elif ($files | length) == 0 then "files_empty" else empty end),
      (if $reviews == null then "reviews_unavailable" else empty end),
      (if $pr != null and $pr.mergeable == null and $pr.mergeable_state != "dirty" then "mergeability_unknown" else empty end),
      (if $e != null and $e.run_verified == null then "run_verified_absent_from_input" else empty end),
      (if $e == null then "run_verified_absent_from_input" else empty end)
    ] | unique) as $unknowns |
    (($blockers | sort_by(.rank) | first | .cat) // (if ($unknowns | length) > 0 then "UNKNOWN" else "READY" end)) as $primary |
    ($blockers | sort_by(.rank) | first | .code) as $primary_code |
    ($pr.mergeable_state // "") as $ms |
    {
      number: ($n | tonumber), title: ($pr.title // null), head_ref: ($pr.head.ref // null), head_sha: ($pr.head.sha // null),
      base_ref: ($pr.base.ref // null), base_sha: ($pr.base.sha // null), draft: ($pr.draft // null),
      mergeable: (if $pr == null then null else $pr.mergeable end), mergeable_state: ($pr.mergeable_state // null), labels: $labels,
      files: (if $files == null then null else [$files[].filename] end),
      diff_lines: (if $files == null then null else ([$files[] | (.additions // 0) + (.deletions // 0)] | add // 0) end),
      ci_current_head: $ci, assertion: $e, audit_sample: $audit,
      primary: $primary, blockers: [$blockers[].code], unknowns: $unknowns,
      secondary: ([$blockers[].code | select(. != $primary_code)] + $unknowns + [(if $pr.draft == true then "draft:mark_ready_required" else empty end), (if $ms == "behind" then "behind_main:update_branch_and_ci_on_new_head_required" else empty end)]),
      transitions: (if $primary != "READY" then [] else
        [(if $pr.draft == true then "mark_ready" else empty end),
         (if $ms == "behind" then "update_branch", "ci_on_new_head" else empty end),
         "squash_merge_at_head"] end)
    }'
}
policy_default() {   # policy_default PR HEAD → READY | <category> | OPERATOR (no evidence input: the operator listed the PR)
  if [ -z "$ASSERTIONS" ]; then echo OPERATOR; return 0; fi
  local c; c="$(classify_pr "$1" 2>/dev/null)" || { echo UNKNOWN; return 0; }
  if [ "$(jq -r '.head_sha' <<<"$c")" != "$2" ]; then echo HEAD_MISMATCH; return 0; fi
  jq -r '.primary + (if .primary != "READY" then " " + (.blockers + .unknowns | join(",")) else "" end)' <<<"$c"
}

# --- presence on main: the only proof of SATISFIED ---------------------------------------------------------------
# present: the diff reverse-applies on BASE and does not forward-apply, and every file it adds exists on BASE
# absent: forward-applies and does not reverse-apply · ambiguous: anything else
diff_state() {
  local p="$1" idx; idx="$(mktemp)"; local fwd=1 rev=1
  GIT_INDEX_FILE="$idx" git read-tree "$BASE"
  GIT_INDEX_FILE="$idx" git apply --cached --check "$p" 2>/dev/null && fwd=0
  GIT_INDEX_FILE="$idx" git apply --cached --check -R "$p" 2>/dev/null && rev=0
  rm -f "$idx"
  if [ $rev -eq 0 ] && [ $fwd -ne 0 ]; then
    local f
    while read -r f; do [ -z "$f" ] && continue; git cat-file -e "$BASE:$f" 2>/dev/null || { echo ambiguous; return; }; done \
      < <(awk '/^diff --git /{f=$4; sub(/^b\//,"",f)} /^new file mode/{print f}' "$p")
    echo present
  elif [ $fwd -eq 0 ] && [ $rev -ne 0 ]; then echo absent
  else echo ambiguous; fi
}

# --- atomic claims ---------------------------------------------------------------------------------------------------
claim() {   # claim KEY → 0 claimed (fresh or reclaimed stale), 1 held by a live worker
  local d="$CLAIMS/$1"
  if mkdir "$d" 2>/dev/null; then echo "$$ $(date +%s)" > "$d/owner"; return 0; fi
  local pid=0 t; t="$(stat -c %Y "$d" 2>/dev/null || stat -f %m "$d" 2>/dev/null || echo 0)"
  [ -s "$d/owner" ] && read -r pid _ < "$d/owner"
  local age=$(( $(date +%s) - t ))
  # an owner file not written yet means the claim is seconds old: live; otherwise live = pid alive and within the TTL
  if [ "$age" -lt "$TTL" ] && { [ "$pid" = 0 ] || kill -0 "$pid" 2>/dev/null; }; then return 1; fi
  rm -rf "$d"; mkdir "$d" 2>/dev/null || return 1; echo "$$ $(date +%s)" > "$d/owner"; echo "reclaimed stale claim (pid $pid)"; return 0
}
release() { [ -n "${1:-}" ] && rm -rf "${CLAIMS:?}/$1"; return 0; }
on_signal() {   # cancellation: durable record, claim released, no further action
  trap - TERM INT
  if [ -n "$CUR_KEY" ]; then
    printf '{"at":"%s","event":"cancelled","pr":"%s","head":"%s","key":"%s","detail":"signal %s"}\n' "$(now)" "$CUR_PR" "$CUR_HEAD" "$CUR_KEY" "$1" >> "$LEDGER" 2>/dev/null || true
    release "$CUR_KEY"
  fi
  echo "#${CUR_PR:-?} CANCELLED by SIG$1 — claim released, nothing further done" >&2
  exit 143
}

live() {   # live PR → L_STATE L_HEAD L_DRAFT; 1 when GitHub could not be read (timeout, network, garbage)
  local out; L_STATE=""; L_HEAD=""; L_DRAFT=""
  out="$(pr_view "$1" 2>/dev/null)" || return 1
  read -r L_STATE L_HEAD L_DRAFT _ <<<"$out" || true
  case "$L_STATE" in OPEN|MERGED|CLOSED) ;; *) return 1 ;; esac
  [ -n "$L_HEAD" ] || return 1
  case "$L_DRAFT" in true|false) return 0 ;; *) return 1 ;; esac
}

run_train() {
  local log="" a
  while [ $# -gt 0 ]; do case "$1" in
    --mark-ready) MARK_READY=1; shift ;;
    --assertions) ASSERTIONS="$2"; shift 2 ;;
    --) shift; break ;;
    -*) echo "unknown flag $1" >&2; exit 64 ;;
    *) break ;;
  esac; done
  log="${1:?usage: run [--mark-ready] [--assertions F] LOG PR...}"; shift
  mkdir -p "$CLAIMS"; touch "$LEDGER"
  say() { echo "$(date +%H:%M) $*" >> "$log"; echo "$*"; }
  trap 'on_signal TERM' TERM; trap 'on_signal INT' INT
  for spec in "$@"; do
    local pr="${spec%@*}" want=""; [ "$spec" != "$pr" ] && want="${spec#*@}"
    live "$pr" || { hold "$pr" "" "PR head unavailable before diff download"; exit 7; }
    local diff_head="$L_HEAD"
    local p; p="$(mktemp)"
    pr_diff "$pr" > "$p" || { rm -f "$p"; hold "$pr" "$diff_head" "diff download failed — partial patch is not evidence"; exit 7; }
    local pid; pid="$(git patch-id --stable < "$p" | cut -d' ' -f1)"
    [ -n "$pid" ] || { say "#$pr EMPTY DIFF — FAIL_CLOSED"; record fail_closed "$pr" "" "" empty_diff; exit 3; }
    local key; key="$(intent_key "$pr" "$pid")"
    if ! claim "$key"; then say "#$pr CLAIMED by another worker — exiting without acting"; exit 6; fi
    CUR_PR="$pr"; CUR_KEY="$key"; CUR_HEAD=""   # the EXIT trap (main) releases CUR_KEY on any exit
    record claimed "$pr" "" "$key"
    act_on "$pr" "$want" "$p" "$key" "$diff_head" || { local rc=$?; release "$key"; CUR_KEY=""; exit $rc; }
    release "$key"; CUR_KEY=""; rm -f "$p"
  done
  say "TRAIN DONE"
}

hold() { say "#$1 HOLD ($3)"; record hold "$1" "$2" "$CUR_KEY" "$3"; return 7; }

act_on() {
  local pr="$1" want="$2" p="$3" key="$4" diff_head="$5" head
  fetch_main || { hold "$pr" "" "main refresh failed — cached main is not evidence"; return 7; }
  live "$pr" || { hold "$pr" "" "live PR state unavailable (GitHub timeout/network) — nothing done"; return 7; }
  head="$L_HEAD"; CUR_HEAD="$head"
  if [ "$head" != "$diff_head" ]; then
    say "#$pr SUPERSEDED (head changed during diff download)"; record superseded "$pr" "$diff_head" "$key" "diff_head_changed:$head"; return 5
  fi
  # live state first; the ledger and the patch-id are not proof
  if [ "$L_STATE" = MERGED ]; then
    case "$(diff_state "$p")" in
      present) if grep -q "\"event\":\"merged\".*\"key\":\"$key\"" "$LEDGER"; then say "#$pr SATISFIED (merged, change on main)"; record satisfied "$pr" "$head" "$key"
               else say "#$pr MERGED (recovered: merged on GitHub, ledger had no completion)"; record merged "$pr" "$head" "$key" recovered; fi; return 0 ;;
      *) say "#$pr FAIL_CLOSED (PR merged but its change is not verifiably on main)"; record fail_closed "$pr" "$head" "$key" merged_not_present; return 3 ;;
    esac
  fi
  if [ -n "$want" ] && [ "$want" != "$head" ]; then
    if own_update "$pr" "$head" "$key"; then say "#$pr RESUME (head ${head:0:8} came from this intent's own update-branch of ${want:0:8})"; record resumed "$pr" "$head" "$key" "queued:$want"
    else say "#$pr SUPERSEDED (queued for ${want:0:8}, head is ${head:0:8})"; record superseded "$pr" "$want" "$key"; return 5; fi
  fi
  if superseded "$pr" "$head"; then say "#$pr SUPERSEDED (head ${head:0:8} marked superseded)"; record superseded "$pr" "$head" "$key" marked; return 5; fi
  [ "$L_STATE" = OPEN ] || { say "#$pr NOT OPEN ($L_STATE) — SUPERSEDED"; record superseded "$pr" "$head" "$key" "$L_STATE"; return 5; }
  local where; where="$(diff_state "$p")"
  [ "$where" = present ] && { say "#$pr SATISFIED (open, but its change is already on main)"; record satisfied "$pr" "$head" "$key" open_present; return 0; }
  [ "$where" = absent ] || { say "#$pr FAIL_CLOSED (change partly on main)"; record fail_closed "$pr" "$head" "$key" ambiguous; return 3; }
  record running "$pr" "$head" "$key"
  local attempt
  for attempt in 1 2 3; do
    # 1. live state at the expected head; never update-branch a PR that is already merged
    live "$pr" || { hold "$pr" "$head" "live PR state unavailable — nothing done"; return 7; }
    if [ "$L_STATE" = MERGED ]; then act_on_merged_meanwhile "$pr" "$L_HEAD" "$p" "$key"; return $?; fi
    if [ "$L_STATE" != OPEN ] || [ "$L_HEAD" != "$head" ]; then say "#$pr SUPERSEDED during execution ($L_STATE ${L_HEAD:0:8}, expected ${head:0:8})"; record superseded "$pr" "$head" "$key" "during:$L_STATE:$L_HEAD"; return 5; fi
    # 2. drafts: the ready transition only with evidence AND the explicit flag
    if [ "$L_DRAFT" = true ]; then
      local v; v="$(policy "$pr" "$head" 2>/dev/null || echo UNKNOWN)"
      if [ "${v%% *}" != READY ]; then hold "$pr" "$head" "draft; policy/evidence verdict ${v:-none} — draft→ready not permitted"; return 7; fi
      if [ "$MARK_READY" != 1 ]; then record proposed "$pr" "$head" "$key" mark_ready; hold "$pr" "$head" "draft; policy READY — transition mark_ready proposed, rerun with --mark-ready to apply"; return 7; fi
      record ready_intent "$pr" "$head" "$key"
      pr_ready "$pr" >> "$log" 2>&1 || true
      live "$pr" || { hold "$pr" "$head" "live PR state unavailable after mark-ready"; return 7; }
      [ "$L_DRAFT" = false ] && [ "$L_HEAD" = "$head" ] || { hold "$pr" "$head" "mark-ready did not take effect (draft=$L_DRAFT head=${L_HEAD:0:8})"; return 7; }
      say "#$pr marked ready"; record ready_marked "$pr" "$head" "$key"
    fi
    # 3. update-branch pinned to the expected head, then read the NEW head
    record update_intent "$pr" "$head" "$key"
    local urc=0 out; out="$(pr_update "$pr" "$head" 2>&1)" || urc=$?
    say "#$pr update: $(printf '%s' "$out" | tr '\n' ' ' | head -c 200)"
    if echo "$out" | grep -qi conflict; then say "#$pr CONFLICT"; record fail_closed "$pr" "$head" "$key" conflict; return 2; fi
    local noop=0; echo "$out" | grep -qiE 'no new commits|up.to.date' && noop=1
    if [ "$urc" -ne 0 ] && [ "$noop" = 0 ]; then hold "$pr" "$head" "update-branch failed (exit $urc)"; return 7; fi
    if [ "$noop" = 0 ]; then
      local waited=0 new="$head"
      while [ "$waited" -lt "$SETTLE" ]; do
        pause "$SETTLE_POLL"; waited=$(( waited + SETTLE_POLL ))
        live "$pr" || continue
        [ "$L_STATE" = OPEN ] || break
        if [ "$L_HEAD" != "$head" ]; then new="$L_HEAD"; break; fi
      done
      if [ "$new" != "$head" ]; then
        say "#$pr head ${head:0:8} → ${new:0:8} after update-branch — CI eligibility of ${head:0:8} discarded"
        record branch_updated "$pr" "$new" "$key" "from:$head"
        head="$new"; CUR_HEAD="$head"
      else
        hold "$pr" "$head" "update accepted but new head not observed — old CI is not evidence"; return 7
      fi
    fi
    local base0; base0="$(main_sha)"
    # 4. CI on exactly this head, bounded
    local crc=0; ci_wait "$pr" "$head" "$key" || crc=$?
    case "$crc" in
      0) ;;
      3) say "#$pr CI fail on ${head:0:8}"; record fail_closed "$pr" "$head" "$key" "ci_fail"; return 3 ;;
      9) say "#$pr CI cancel, retry"; continue ;;
      5) live "$pr" && [ "$L_STATE" = MERGED ] && { act_on_merged_meanwhile "$pr" "$L_HEAD" "$p" "$key"; return $?; }
         say "#$pr SUPERSEDED during CI wait (${L_STATE:-?} ${L_HEAD:0:8}, expected ${head:0:8}) — CI of the obsolete sha ignored"; record superseded "$pr" "$head" "$key" "during_ci:$L_HEAD"; return 5 ;;
      *) return 7 ;;
    esac
    # 5. re-verify right before the merge call: same head, open, not draft, main unchanged since CI, policy still READY
    fetch_main || { hold "$pr" "$head" "main refresh failed before merge — not merged"; return 7; }
    live "$pr" || { hold "$pr" "$head" "live PR state unavailable before merge — not merged"; return 7; }
    if [ "$L_STATE" = MERGED ]; then act_on_merged_meanwhile "$pr" "$L_HEAD" "$p" "$key"; return $?; fi
    if [ "$L_STATE" != OPEN ] || [ "$L_HEAD" != "$head" ]; then say "#$pr SUPERSEDED during execution ($L_STATE ${L_HEAD:0:8})"; record superseded "$pr" "$head" "$key" "during:$L_STATE"; return 5; fi
    [ "$L_DRAFT" = false ] || { hold "$pr" "$head" "PR is a draft again before merge"; return 7; }
    if [ "$(main_sha)" != "$base0" ]; then say "#$pr main moved since CI started — redo"; continue; fi
    local v2="" i
    for i in 1 2 3; do v2="$(policy "$pr" "$head" 2>/dev/null || echo UNKNOWN)"; [ "${v2%% *}" = UNKNOWN ] || break; pause "$SETTLE_POLL"; done
    case "${v2%% *}" in
      READY) ;;
      OPERATOR) [ -z "$ASSERTIONS" ] || { hold "$pr" "$head" "policy verdict OPERATOR with an evidence input"; return 7; } ;;
      *) hold "$pr" "$head" "policy changed before merge: $v2"; return 7 ;;
    esac
    # 6. merge exactly this head; the outcome comes from live state, never from the CLI exit code (11-10: the squash
    # merge succeeded but branch cleanup failed; the old train retried update-branch on a merged PR)
    record merge_intent "$pr" "$head" "$key"
    local mrc=0; pr_merge "$pr" "$head" >> "$log" 2>&1 || mrc=$?
    fetch_main || { hold "$pr" "$head" "main refresh failed after merge request — inspect live outcome before retry"; return 7; }
    if live "$pr" && [ "$L_STATE" = MERGED ]; then
      [ "$mrc" -eq 0 ] || say "#$pr merge CLI exited $mrc after merging (branch cleanup) — logged, not fatal"
      if [ "$(diff_state "$p")" = present ] || [ "${MT_SKIP_MAIN_CHECK_AFTER_MERGE:-}" = 1 ]; then say "#$pr MERGED"; record merged "$pr" "$L_HEAD" "$key" "cli_exit=$mrc sha=$head"; return 0; fi
      say "#$pr merged on GitHub but the change is not visible on $BASE yet — ESCALATE"; record escalated "$pr" "$L_HEAD" "$key" merged_not_visible; return 4
    fi
    say "#$pr merge refused (exit $mrc, state ${L_STATE:-unreadable}), retry"
  done
  say "#$pr NOT MERGED"; record escalated "$pr" "$head" "$key" not_merged; return 4
}
ci_wait() {   # ci_wait PR SHA KEY → 0 green · 3 red · 9 cancelled run (retry) · 5 head moved/closed · 7 TIMEOUT (recorded)
  local pr="$1" sha="$2" key="$3" elapsed=0 b=""
  record ci_wait "$pr" "$sha" "$key" "timeout=${CI_TIMEOUT}s poll=${CI_POLL}s"
  while :; do
    b="$(pr_checks "$pr" "$sha" 2>/dev/null || echo "pending error")"
    case "$b" in
      pass|pass,skipping|skipping,pass) record ci_green "$pr" "$sha" "$key"; return 0 ;;
      *fail*) return 3 ;;
      *cancel*) return 9 ;;
    esac
    # an obsolete sha is never waited for: the head must still be the one CI is read for
    if live "$pr"; then { [ "$L_STATE" = OPEN ] && [ "$L_HEAD" = "$sha" ]; } || return 5; fi
    if [ "$elapsed" -ge "$CI_TIMEOUT" ]; then
      say "#$pr CI TIMEOUT after ${elapsed}s on ${sha:0:8} (last: $b) — HOLD, never approved"
      record timeout "$pr" "$sha" "$key" "ci ${elapsed}s: $b"; record hold "$pr" "$sha" "$key" ci_timeout; return 7
    fi
    pause "$CI_POLL"; elapsed=$(( elapsed + CI_POLL ))
  done
}
act_on_merged_meanwhile() {
  local pr="$1" head="$2" p="$3" key="$4"
  if [ "$(diff_state "$p")" = present ]; then say "#$pr SATISFIED (merged meanwhile)"; record satisfied "$pr" "$head" "$key" merged_meanwhile; return 0; fi
  say "#$pr FAIL_CLOSED (merged meanwhile but change not on main)"; record fail_closed "$pr" "$head" "$key" merged_not_present; return 3
}

# --- read-only plan -----------------------------------------------------------------------------------------------------
dry_run() {
  READONLY=1; readonly READONLY
  local out=""
  while [ $# -gt 0 ]; do case "$1" in
    --assertions) ASSERTIONS="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 64 ;;
  esac; done
  if [ -n "$ASSERTIONS" ]; then jq -e '.prs | type == "object"' "$ASSERTIONS" >/dev/null || { echo "assertions file must be {\"prs\": {\"<n>\": {...}}}" >&2; exit 64; }; fi
  : > "$GH_CALL_LOG"
  local main; main="$(ghx api "repos/$REPO_SLUG/branches/$BASE_BRANCH" -q .commit.sha 2>/dev/null || echo unknown)"
  local list="[]" page batch
  for page in 1 2 3 4 5 6 7 8 9 10; do
    batch="$(json_or_null "$(ghx api "repos/$REPO_SLUG/pulls?state=open&per_page=100&page=$page" 2>/dev/null || true)")"
    [ "$batch" = null ] && { echo "cannot list open PRs — no plan (fail closed)" >&2; exit 3; }
    printf '%s' "$list" > "$MT_TMP/acc.json"; printf '%s' "$batch" > "$MT_TMP/batch.json"
    list="$(jq -cs 'add | map({number, title, head: {ref: .head.ref}})' "$MT_TMP/acc.json" "$MT_TMP/batch.json")"
    [ "$(jq 'length' <<<"$batch")" -lt 100 ] && break
  done
  local n rows="$MT_TMP/rows.jsonl"; : > "$rows"
  for n in $(jq -r '.[] | select(((.title // "") | startswith("loop:")) or ((.head.ref // "") | startswith("agent/"))) | .number' <<<"$list" | sort -n); do
    classify_pr "$n" >> "$rows"
  done
  local calls refused=0
  calls="$(wc -l < "$GH_CALL_LOG" | tr -d ' ')"
  [ -n "${MT_REFUSED_LOG:-}" ] && [ -f "$MT_REFUSED_LOG" ] && refused="$(wc -l < "$MT_REFUSED_LOG" | tr -d ' ')"
  local mutating; mutating="$(grep -cE '(^| )(-X|--method|-f|-F|--field|--raw-field|--input)( |=|$)|^pr (ready|merge|edit|update-branch|comment|close|reopen|review|create)' "$GH_CALL_LOG" || true)"
  local plan; plan="$(jq -s --arg at "$(now)" --arg repo "$REPO_SLUG" --arg base "$BASE_BRANCH" --arg main "$main" \
    --argjson req "$(required_json)" --arg af "${ASSERTIONS:-}" --argjson ameta "$(if [ -n "$ASSERTIONS" ]; then jq -c 'del(.prs)' "$ASSERTIONS"; else echo null; fi)" \
    --argjson open_total "$(jq 'length' <<<"$list")" --argjson calls "$calls" --argjson mutating "${mutating:-0}" --argjson refused "$refused" '
    . as $prs | ["READY","CI_BLOCKED","CONFLICTED","ASSERTION_BLOCKED","GAP_ORPHAN","POLICY_BLOCKED","UNKNOWN"] as $cats |
    {generated_at: $at, mode: "dry-run", read_only: true, repo: $repo, base: $base, main_sha: $main,
     eligibility_source: "mirrors packages/server/src/services/loop-auto-merge.ts runAutoMergeTick (#754 shadow) on the CURRENT head; loop identity by title loop: + agent/* branch + head repo + base (the maker branch from the DB is not read)",
     assertions_input: {path: (if $af == "" then null else $af end), meta: $ameta},
     required_checks: $req,
     gh_calls: {total: $calls, mutating: $mutating, refused: $refused},
     open_prs_total: $open_total, loop_prs: ($prs | length),
     counts: (reduce $cats[] as $c ({}; .[$c] = ([$prs[] | select(.primary == $c)] | length))),
     ready: [$prs[] | select(.primary == "READY") | .number],
     apply_transitions: [$prs[] | select(.primary == "READY") | {number, head_sha, transitions}],
     note: "READY = eligible now on the current head; an apply run must re-validate on the post-update head (update-branch → CI on the new sha → policy + mergeability re-read → merge sha-pinned)",
     prs: $prs}' "$rows")"
  if [ -n "$out" ]; then printf '%s\n' "$plan" > "$out"; fi
  [ -n "$out" ] || printf '%s\n' "$plan"
  {
    echo "merge-train --dry-run ($REPO_SLUG, $BASE_BRANCH@${main:0:8}) — READ-ONLY, gh calls: $calls (mutating: ${mutating:-0}, refused: $refused)"
    jq -r '"loop PRs: \(.loop_prs) of \(.open_prs_total) open · " + ([.counts | to_entries[] | "\(.key)=\(.value)"] | join(" "))' <<<"$plan"
    jq -r '"READY: " + (if (.ready | length) == 0 then "none" else (.ready | map("#\(.)") | join(" ")) end)' <<<"$plan"
    jq -r '.apply_transitions[] | "  #\(.number) @\(.head_sha[0:8]): \(.transitions | join(" → "))"' <<<"$plan"
  } >&"$([ -n "$out" ] && echo 1 || echo 2)"
}

# --- stacked-PR rebuild ----------------------------------------------------------------------------------------------
commit_state() { local c="$1" p; p="$(mktemp)"; git diff "$c^" "$c" > "$p"; if [ ! -s "$p" ]; then echo present; else diff_state "$p"; fi; rm -f "$p"; }
hunks() { git diff -U0 "$@" | grep -E '^[+-]' | grep -vE '^(\+\+\+|---) ' | LC_ALL=C sort; }   # changed lines, order-free

rebase_onto_main() {
  local branch="$1" own="$2" pr="${3:-$1}"
  mkdir -p "$CLAIMS"; touch "$LEDGER"
  git rev-parse --verify -q "$branch" >/dev/null || { echo "FAIL_CLOSED: no branch $branch"; exit 3; }
  if [ -d "$(git rev-parse --git-dir)/rebase-merge" ] || [ -d "$(git rev-parse --git-dir)/rebase-apply" ]; then echo "FAIL_CLOSED: a rebase is in progress"; exit 3; fi
  # the rebuild commits (cherry-pick); without an identity (bare CI runners) every pick fails and would read as a conflict
  git var GIT_COMMITTER_IDENT >/dev/null 2>&1 || { echo "FAIL_CLOSED: no git committer identity (set user.name/user.email) — branch untouched, nothing pushed"; exit 3; }
  local old_head; old_head="$(git rev-parse "$branch")"
  local absent=() c
  for c in $(git rev-list --reverse "$branch~$own..$branch"); do
    case "$(commit_state "$c")" in
      present) echo "commit ${c:0:8} already on $BASE — dropped" ;;
      absent)  absent+=("$c") ;;
      *) echo "FAIL_CLOSED: commit ${c:0:8} is partly on $BASE (ambiguous) — nothing pushed"; record fail_closed "$pr" "$old_head" "" "ambiguous ${c:0:8}"; exit 3 ;;
    esac
  done
  if [ ${#absent[@]} -eq 0 ]; then echo "SATISFIED: every own commit of $branch is already on $BASE — nothing to push"; record satisfied "$pr" "$old_head"; return 0; fi
  # the change we must reproduce: the absent commits' hunks
  local want; want="$(for c in "${absent[@]}"; do hunks "$c^" "$c"; done | LC_ALL=C sort)"
  restore() { git cherry-pick --abort 2>/dev/null || true; git checkout -q -B "$branch" "$old_head"; }
  # rebuild explicitly instead of trusting `git rebase` (it stops mid-way on a conflict with HEAD at main)
  git checkout -q -B "$branch" "$BASE"
  for c in "${absent[@]}"; do
    git cherry-pick "$c" >/dev/null 2>"$MT_TMP/pick.err" || { restore; echo "ESCALATE: cherry-pick of ${c:0:8} onto $BASE failed — branch restored, nothing pushed"; head -3 "$MT_TMP/pick.err" | sed 's/^/  git: /'; record escalated "$pr" "$old_head" "" "cherry-pick ${c:0:8}"; exit 4; }
  done
  post_rebuild
  if git diff --quiet "$BASE" "$branch"; then restore; echo "FAIL_CLOSED: rebuilt $branch is identical to $BASE — nothing pushed"; record fail_closed "$pr" "$old_head" "" empty_after_rebuild; exit 3; fi
  # reproduce the original change only: hunk for hunk, else fail closed and escalate
  if [ "$(hunks "$BASE" "$branch")" != "$want" ]; then restore; echo "FAIL_CLOSED: rebuilt $branch differs from the original change — nothing pushed, escalate"; record fail_closed "$pr" "$old_head" "" reconstruct_mismatch; exit 3; fi
  echo "RECONSTRUCT: $branch rebuilt on $BASE with ${#absent[@]} own commit(s), change identical to the original"
  record reconstruct_push "$pr" "$old_head" "" "reconstructed as $(git rev-parse "$branch"); expected remote $old_head"
  if ! push "$branch" "$old_head"; then
    restore
    echo "FAIL_CLOSED: push did not report success — local branch restored; inspect remote before retry"
    record fail_closed "$pr" "$old_head" "" reconstruct_push_unconfirmed
    exit 3
  fi
  record superseded "$pr" "$old_head" "" "reconstructed as $(git rev-parse "$branch")"
}

main() {
  trap 'release "$CUR_KEY"; rm -rf "$MT_TMP"' EXIT
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    run|apply) run_train "$@" ;;
    --dry-run|plan) dry_run "$@" ;;
    rebase) rebase_onto_main "$@" ;;
    *) echo "usage: merge-train.sh run [--mark-ready] [--assertions F] LOG PR[@HEAD]... | --dry-run [--assertions F] [--out F] | rebase BRANCH OWN_N [PR]" >&2; exit 64 ;;
  esac
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
