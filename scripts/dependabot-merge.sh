#!/usr/bin/env bash
# dependabot-merge.sh PR SHA — the gated merge of a Dependabot patch/minor PR (.github/workflows/dependabot-auto-merge.yml).
#
# GitHub's native auto-merge counts a skipped required check as passed, so it is not used (operator decision on #1061:
# Dependabot auto-merge stays, through the corrected gate). This polls merge-train.sh's checks_verdict on the exact head —
# required checks only from their required app_id, the newest run per name per app, skipped/neutral/missing never green —
# and merges only on green, with the REST merge pinned to that head (GitHub refuses any other head). Red, a moved head, a
# refused merge or a timeout leave the PR open; the next run (a new head, keep-fresh's update) tries again.
#   DM_TRIES (60) x DM_POLL_S (60): how long to wait for checks. MERGE_TRAIN_REPO: owner/repo.
# The job's own check run (job `auto-merge`) is still in progress while it polls: MT_IGNORE_CHECKS names it, and
# merge-train never ignores a required check.
set -euo pipefail
PR="${1:?usage: dependabot-merge.sh PR SHA}"; SHA="${2:?usage: dependabot-merge.sh PR SHA}"
export MT_IGNORE_CHECKS="${MT_IGNORE_CHECKS:-auto-merge}"
# shellcheck source=merge-train.sh
source "$(dirname "${BASH_SOURCE[0]}")/merge-train.sh"
trap 'rm -rf "$MT_TMP"' EXIT
TRIES="${DM_TRIES:-60}"; POLL="${DM_POLL_S:-60}"
for ((i = 1; i <= TRIES; i++)); do
  head="$(ghx api "repos/$REPO_SLUG/pulls/$PR" -q .head.sha 2>/dev/null || true)"
  [ "$head" = "$SHA" ] || { echo "#$PR head is ${head:-unreadable}, not $SHA — not merging"; exit 0; }
  rm -f "$MT_TMP/required.json"   # protection is re-read every poll, never remembered
  v="$(checks_verdict "$SHA")"
  case "$(jq -r .verdict <<<"$v")" in
    green)
      if ghx api -X PUT "repos/$REPO_SLUG/pulls/$PR/merge" -f merge_method=squash -f "sha=$SHA" >/dev/null; then echo "#$PR merged at $SHA"
      else echo "#$PR merge refused at $SHA (behind or changed) — left open"; fi
      exit 0 ;;
    red) echo "#$PR not merged: $v"; exit 0 ;;
  esac
  [ "$i" -ge "$TRIES" ] || sleep "$POLL"
done
echo "#$PR not merged: checks not green after $TRIES poll(s): $v"
