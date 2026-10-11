#!/usr/bin/env bash
# merge-train.sh — idempotent merge train for djimitflo PRs (runbook: docs/runbooks/merge-train.md).
#
#   merge-train.sh run LOG PR[@HEADSHA]...   update-branch, wait for CI, squash-merge, one PR after another
#   merge-train.sh rebase BRANCH OWN_N [PR]   rebuild BRANCH on main keeping its OWN_N top commits (stacked PRs)
#
# Incident #778 (2026-10-11): a queued `git rebase --onto origin/main HEAD~3 | tail -1 && git push -f` hit a
# conflict, the pipe hid the failure, HEAD was left at main and an EMPTY branch was force-pushed; GitHub closed the PR.
# Guarantees:
#  - live state (PR + main) is re-read before every action; the queue, the ledger and a patch-id are never proof alone:
#    SATISFIED requires the PR's net diff to be present on current main (reverse-applies, forward does not) and every
#    file the PR adds to exist there; anything else is FAIL_CLOSED.
#  - each merge intent (key = sha256(repo|pr|patch-id)) is claimed atomically (mkdir) and moves through
#    CLAIMED → RUNNING → MERGED | SATISFIED | FAIL_CLOSED | ESCALATED | SUPERSEDED in the ledger; a live claim held by
#    another worker makes this worker exit without acting; a stale claim (dead pid or older than MT_CLAIM_TTL_S) is
#    reclaimed only by a worker that then re-verifies live state.
#  - a job queued for another head, or whose PR closed/reopened/moved meanwhile, exits SUPERSEDED.
#  - a rebuilt branch is pushed only if it reproduces the original change hunk for hunk; never an empty branch.
# Every external probe is overridable (MT_<NAME>, evaluated) so the logic is testable without GitHub (merge-train.test.ts).
set -euo pipefail
REPO_SLUG="${MERGE_TRAIN_REPO:-djimit/djimitflo}"
LEDGER="${MT_LEDGER:-$HOME/.djimit/merge-train.ledger.jsonl}"
CLAIMS="$(dirname "$LEDGER")/merge-train.claims"
BASE="${MT_BASE:-origin/main}"
TTL="${MT_CLAIM_TTL_S:-7200}"
mkdir -p "$CLAIMS"; touch "$LEDGER"

probe() { local name="$1"; shift; local override="MT_$name"; if [ -n "${!override:-}" ]; then ( eval "${!override}" ); else "$@"; fi; }   # override runs in a subshell, like the real command
pr_view()   { probe PR_VIEW gh pr view "$1" --repo "$REPO_SLUG" --json state,headRefOid -q '"\(.state) \(.headRefOid)"'; }
pr_diff()   { probe PR_DIFF gh pr diff "$1" --repo "$REPO_SLUG"; }
pr_update() { probe UPDATE gh pr update-branch "$1" --repo "$REPO_SLUG"; }
pr_checks() { probe CHECKS gh pr checks "$1" --repo "$REPO_SLUG" --json bucket -q '[.[].bucket]|unique|join(",")'; }
pr_merge()  { probe MERGE gh pr merge "$1" --repo "$REPO_SLUG" --squash --delete-branch; }
fetch_main(){ probe FETCH git fetch -q origin; }
main_sha()  { probe MAIN_SHA git rev-parse "$BASE"; }
push()      { probe PUSH git push -f -q origin "$1"; }
pause()     { probe SLEEP sleep "$1"; }
post_rebuild() { probe POST_REBUILD true; }   # test hook only

now() { date -u +%FT%TZ; }
record() { printf '{"at":"%s","event":"%s","pr":"%s","head":"%s","key":"%s","detail":"%s"}\n' "$(now)" "$1" "$2" "${3:-}" "${4:-}" "$(printf '%s' "${5:-}" | tr -d '"\\' | head -c 200)" >> "$LEDGER"; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1; }
intent_key() { printf '%s|%s|%s' "$REPO_SLUG" "$1" "$2" | sha256; }
superseded() { grep -q "\"event\":\"superseded\",\"pr\":\"$1\",\"head\":\"$2\"" "$LEDGER"; }

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
release() { rm -rf "$CLAIMS/$1"; }

run_train() {
  local log="$1"; shift
  say() { echo "$(date +%H:%M) $*" >> "$log"; echo "$*"; }
  for spec in "$@"; do
    local pr="${spec%@*}" want=""; [ "$spec" != "$pr" ] && want="${spec#*@}"
    local p; p="$(mktemp)"; pr_diff "$pr" > "$p" || true
    local pid; pid="$(git patch-id --stable < "$p" | cut -d' ' -f1)"
    [ -n "$pid" ] || { say "#$pr EMPTY DIFF — FAIL_CLOSED"; record fail_closed "$pr" "" "" empty_diff; exit 3; }
    local key; key="$(intent_key "$pr" "$pid")"
    if ! claim "$key"; then say "#$pr CLAIMED by another worker — exiting without acting"; exit 6; fi
    trap 'release "$key"' EXIT
    record claimed "$pr" "" "$key"
    act_on "$pr" "$want" "$p" "$key" || { local rc=$?; release "$key"; trap - EXIT; exit $rc; }
    release "$key"; trap - EXIT
  done
  say "TRAIN DONE"
}

act_on() {
  local pr="$1" want="$2" p="$3" key="$4" state head
  fetch_main || true
  read -r state head < <(pr_view "$pr")
  # live state first; the ledger and the patch-id are not proof
  if [ "$state" = MERGED ]; then
    case "$(diff_state "$p")" in
      present) if grep -q "\"event\":\"merged\".*\"key\":\"$key\"" "$LEDGER"; then say "#$pr SATISFIED (merged, change on main)"; record satisfied "$pr" "$head" "$key"
               else say "#$pr MERGED (recovered: merged on GitHub, ledger had no completion)"; record merged "$pr" "$head" "$key" recovered; fi; return 0 ;;
      *) say "#$pr FAIL_CLOSED (PR merged but its change is not verifiably on main)"; record fail_closed "$pr" "$head" "$key" merged_not_present; return 3 ;;
    esac
  fi
  if [ -n "$want" ] && [ "$want" != "$head" ]; then say "#$pr SUPERSEDED (queued for ${want:0:8}, head is ${head:0:8})"; record superseded "$pr" "$want" "$key"; return 5; fi
  if superseded "$pr" "$head"; then say "#$pr SUPERSEDED (head ${head:0:8} marked superseded)"; record superseded "$pr" "$head" "$key" marked; return 5; fi
  [ "$state" = OPEN ] || { say "#$pr NOT OPEN ($state) — SUPERSEDED"; record superseded "$pr" "$head" "$key" "$state"; return 5; }
  local where; where="$(diff_state "$p")"
  [ "$where" = present ] && { say "#$pr SATISFIED (open, but its change is already on main)"; record satisfied "$pr" "$head" "$key" open_present; return 0; }
  [ "$where" = absent ] || { say "#$pr FAIL_CLOSED (change partly on main)"; record fail_closed "$pr" "$head" "$key" ambiguous; return 3; }
  record running "$pr" "$head" "$key"
  local attempt
  for attempt in 1 2 3; do
    # never update-branch a PR that is already merged
    local s0 h0; read -r s0 h0 < <(pr_view "$pr")
    if [ "$s0" = MERGED ]; then act_on_merged_meanwhile "$pr" "$h0" "$p" "$key"; return $?; fi
    local out; out="$(pr_update "$pr" 2>&1 || true)"; say "#$pr update: $out"
    if echo "$out" | grep -q conflicts; then say "#$pr CONFLICT"; record fail_closed "$pr" "$head" "$key" conflict; return 2; fi
    pause 60
    local base0; base0="$(main_sha)"
    local b
    while :; do b="$(pr_checks "$pr" 2>/dev/null || true)"; case "$b" in *pending*|"") pause 45 ;; *) break ;; esac; done
    if echo "$b" | grep -q fail; then say "#$pr CI fail"; record fail_closed "$pr" "$head" "$key" ci_fail; return 3; fi
    if echo "$b" | grep -q cancel; then say "#$pr CI cancel, retry"; continue; fi
    # re-verify right before the merge call: same head, still open, main unchanged since CI, change still absent
    local s2 h2; fetch_main || true; read -r s2 h2 < <(pr_view "$pr")
    if [ "$s2" = MERGED ]; then act_on_merged_meanwhile "$pr" "$h2" "$p" "$key"; return $?; fi
    if [ "$s2" != OPEN ] || [ "$h2" != "$head" ]; then say "#$pr SUPERSEDED during execution ($s2 ${h2:0:8})"; record superseded "$pr" "$head" "$key" "during:$s2"; return 5; fi
    if [ "$(main_sha)" != "$base0" ]; then say "#$pr main moved since CI started — redo"; continue; fi
    # the outcome comes from live state, never from the CLI exit code (11-10: the squash merge succeeded but
    # `--delete-branch` failed on a worktree-held local branch; the old train retried update-branch on a merged PR)
    local mrc=0; pr_merge "$pr" >> "$log" 2>&1 || mrc=$?
    local s3 h3; fetch_main || true; read -r s3 h3 < <(pr_view "$pr")
    if [ "$s3" = MERGED ]; then
      [ "$mrc" -eq 0 ] || say "#$pr merge CLI exited $mrc after merging (branch cleanup) — logged, not fatal"
      if [ "$(diff_state "$p")" = present ] || [ "${MT_SKIP_MAIN_CHECK_AFTER_MERGE:-}" = 1 ]; then say "#$pr MERGED"; record merged "$pr" "$h3" "$key" "cli_exit=$mrc"; return 0; fi
      say "#$pr merged on GitHub but the change is not visible on $BASE yet — ESCALATE"; record escalated "$pr" "$h3" "$key" merged_not_visible; return 4
    fi
    say "#$pr merge refused (exit $mrc, state $s3), retry"
  done
  say "#$pr NOT MERGED"; record escalated "$pr" "$head" "$key" not_merged; return 4
}
act_on_merged_meanwhile() {
  local pr="$1" head="$2" p="$3" key="$4"
  if [ "$(diff_state "$p")" = present ]; then say "#$pr SATISFIED (merged meanwhile)"; record satisfied "$pr" "$head" "$key" merged_meanwhile; return 0; fi
  say "#$pr FAIL_CLOSED (merged meanwhile but change not on main)"; record fail_closed "$pr" "$head" "$key" merged_not_present; return 3
}

# --- stacked-PR rebuild ----------------------------------------------------------------------------------------------
commit_state() { local c="$1" p; p="$(mktemp)"; git diff "$c^" "$c" > "$p"; if [ ! -s "$p" ]; then echo present; else diff_state "$p"; fi; rm -f "$p"; }
hunks() { git diff -U0 "$@" | grep -E '^[+-]' | grep -vE '^(\+\+\+|---) ' | LC_ALL=C sort; }   # changed lines, order-free

rebase_onto_main() {
  local branch="$1" own="$2" pr="${3:-$1}"
  git rev-parse --verify -q "$branch" >/dev/null || { echo "FAIL_CLOSED: no branch $branch"; exit 3; }
  if [ -d "$(git rev-parse --git-dir)/rebase-merge" ] || [ -d "$(git rev-parse --git-dir)/rebase-apply" ]; then echo "FAIL_CLOSED: a rebase is in progress"; exit 3; fi
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
    git cherry-pick "$c" >/dev/null 2>&1 || { restore; echo "ESCALATE: cherry-pick of ${c:0:8} onto $BASE failed — branch restored, nothing pushed"; record escalated "$pr" "$old_head" "" "cherry-pick ${c:0:8}"; exit 4; }
  done
  post_rebuild
  if git diff --quiet "$BASE" "$branch"; then restore; echo "FAIL_CLOSED: rebuilt $branch is identical to $BASE — nothing pushed"; record fail_closed "$pr" "$old_head" "" empty_after_rebuild; exit 3; fi
  # reproduce the original change only: hunk for hunk, else fail closed and escalate
  if [ "$(hunks "$BASE" "$branch")" != "$want" ]; then restore; echo "FAIL_CLOSED: rebuilt $branch differs from the original change — nothing pushed, escalate"; record fail_closed "$pr" "$old_head" "" reconstruct_mismatch; exit 3; fi
  echo "RECONSTRUCT: $branch rebuilt on $BASE with ${#absent[@]} own commit(s), change identical to the original"
  record superseded "$pr" "$old_head" "" "reconstructed as $(git rev-parse "$branch")"
  push "$branch"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  run) run_train "$@" ;;
  rebase) rebase_onto_main "$@" ;;
  *) echo "usage: merge-train.sh run LOG PR[@HEAD]... | rebase BRANCH OWN_N [PR]" >&2; exit 64 ;;
esac
