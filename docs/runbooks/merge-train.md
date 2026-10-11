# Merge train (scripts/merge-train.sh)

Idempotent merge train for djimitflo PRs. Replaces the ad-hoc session script and chained shell jobs that caused the two
11-10 incidents below.

```bash
scripts/merge-train.sh run LOG 778 779@<headsha> 780     # one PR after another; stops at the first failure
scripts/merge-train.sh rebase <branch> <own_n> [<pr>]   # rebuild a stacked PR on main keeping its own top commits
```

Exit codes: 0 done · 2 conflict · 3 FAIL_CLOSED · 4 ESCALATE / not merged · 5 SUPERSEDED · 6 claimed by another worker.

## Guarantees

| Rule | How |
|---|---|
| Live state before every action | PR state + head and main are re-read before acting, before the merge call and after it |
| SATISFIED needs proof on main | the PR's net diff reverse-applies on current main and does not forward-apply, and every file the PR adds exists there; a ledger entry or patch-id alone is never proof; anything else ⇒ FAIL_CLOSED |
| Idempotency | intent key = sha256(repo \| PR \| `git patch-id --stable` of the PR diff); ledger `MT_LEDGER` (default `~/.djimit/merge-train.ledger.jsonl`), states CLAIMED → RUNNING → MERGED \| SATISFIED \| FAIL_CLOSED \| ESCALATED \| SUPERSEDED |
| Concurrency | each intent is claimed with an atomic `mkdir` under `merge-train.claims/`; a live claim (owner pid alive, within `MT_CLAIM_TTL_S`, default 2 h) makes another worker exit 6; a stale claim is reclaimed and live state re-verified |
| Stale jobs | `PR@HEAD` jobs exit SUPERSEDED when the head moved; a PR closed/reopened/re-headed during execution aborts before the merge call; a rebuilt branch marks its old head superseded |
| Merge outcome | decided from live state (PR MERGED and change on main), never from the CLI exit code; a cleanup failure after a merge is logged, not fatal; a merged PR never gets `update-branch` |
| Main moved | if main changed between the CI wait and the merge call, the attempt is redone |
| Rebuild | `rebase` classifies each own commit (present / absent / ambiguous), rebuilds by cherry-picking the absent ones onto main, and pushes only if the rebuilt diff equals the original change hunk for hunk; never an empty branch; ambiguous ⇒ FAIL_CLOSED, cherry-pick conflict ⇒ ESCALATE (branch restored) |

Every external call is a probe overridable with `MT_<NAME>` (tests: `packages/server/src/__tests__/merge-train.test.ts`).

## Incident 1 — #778 emptied by a queued rebase (2026-10-11 ~20:29–20:39 UTC+2)

1. #778 was stacked on #776 and #777. #776 and #777 squash-merged; #777's squash included a later CI fix, so the original
   #777 commit on #778's branch no longer matched main.
2. A queued job ran `git rebase --onto origin/main HEAD~3 | tail -1 && git push -f origin HEAD:test/tg-001-prerun`.
   The rebase stopped on the original #777 commit with HEAD at main; `| tail -1` hid the failure (pipe status = tail's).
3. The job force-pushed HEAD = main: the PR branch had no commits; GitHub auto-closed #778 ("no commit found").
4. A second queued train then ran on the stale state ("branch already up-to-date").
5. Recovery: `git reset --hard origin/main && git cherry-pick 30711ef6` (#778's own commit), force-push, `gh pr reopen 778`,
   stop the two stale chained jobs, run one train 778 → 779 → 780.

Classification under the new script: `rebase feat 1 778` ⇒ **RECONSTRUCT** (the #776 copy is present, #778's own commit
absent, rebuilt diff equals the original); `rebase feat 3` ⇒ **FAIL_CLOSED** (the original #777 commit is partly on main),
nothing pushed. Regression test: "#778 regression: a raw rebase stops with HEAD at main …".

## Incident 2 — merged PR treated as refused (2026-10-11 21:08)

`gh pr merge 778 --squash --delete-branch` merged on GitHub but exited non-zero: the local branch could not be deleted
because a worktree had it checked out. The old train read the exit code as "merge refused", retried `update-branch` on
the merged PR (→ "conflicts") and stopped, so #779 and #780 never ran. Under the new script the outcome is read from live
state (MERGED + change on main ⇒ MERGED, cleanup error logged). Regression test: "11-10 #778 regression: the merge lands but
branch cleanup fails …".
