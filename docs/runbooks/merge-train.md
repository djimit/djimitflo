# Merge train (scripts/merge-train.sh)

Idempotent merge train for djimitflo PRs. Replaces the ad-hoc session script and chained shell jobs that caused the two
11-10 incidents below.

```bash
scripts/merge-train.sh --dry-run --assertions verdicts.json --out plan.json   # read-only plan of every open loop PR
scripts/merge-train.sh run LOG 778 779@<headsha> 780                         # apply: one PR after another; stops at the first failure
scripts/merge-train.sh run --mark-ready --assertions verdicts.json LOG 737   # apply incl. draft→ready for READY loop PRs
scripts/merge-train.sh rebase <branch> <own_n> [<pr>]                        # rebuild a stacked PR on main keeping its own top commits
```

Exit codes: 0 done · 2 conflict · 3 FAIL_CLOSED · 4 ESCALATE / not merged · 5 SUPERSEDED · 6 claimed by another worker ·
7 HOLD (CI timeout, GitHub unreadable, draft without evidence/flag, policy changed) · 8 ledger write failed (nothing further
done) · 143 cancelled by a signal.

Knobs: `MT_CI_TIMEOUT_S` (3600) / `MT_CI_POLL_S` (45) bound the CI wait; `MT_HEAD_SETTLE_S` (30) / `MT_HEAD_SETTLE_POLL_S` (5)
bound the read-back of the new head after update-branch; `MT_GH_TIMEOUT_S` (60) bounds every gh call; `MT_REQUIRED_CHECKS`
overrides the required contexts (default: branch protection of `main`, fallback the 2026-10-12 list).

## Apply flow (per PR, per attempt)

1. Read live state (state, head, draft). MERGED → SATISFIED/recovered (proof on main); head ≠ expected → SUPERSEDED, unless the
   ledger has this intent's own `branch_updated` to that head (resume after a worker restart).
2. Draft → the policy verdict on the current head must be `READY` (the dry-run classifier with `--assertions`) **and**
   `--mark-ready` must be given; otherwise HOLD with the transition proposed in the ledger. Without `--assertions` drafts are
   never marked ready (verdict `OPERATOR` only covers non-draft PRs the operator listed explicitly).
3. `PUT pulls/{n}/update-branch` with `expected_head_sha`; conflict → exit 2; the new head is read back and recorded
   (`branch_updated`, from → to). CI of the old head is discarded.
4. CI is waited for on **that sha** (check-runs + commit statuses + every required context present); the head is re-read on
   every poll (moved → SUPERSEDED, an obsolete sha's CI is never used); red → FAIL_CLOSED; TIMEOUT → HOLD, never approved.
5. Re-read state, head, draft, main (moved → redo the attempt) and the policy verdict (changed → HOLD).
6. `PUT pulls/{n}/merge` with `merge_method=squash` and `sha=<head>` (GitHub refuses any other head); the outcome is read from
   live state. No auto-merge, no branch deletion.

Every mutation is preceded by a ledger entry (`ready_intent`, `update_intent`, `merge_intent`); a failed ledger write exits 8
before the mutation. SIGTERM/SIGINT records `cancelled` and releases the claim.

## Dry-run (`--dry-run`)

Read-only by construction: every gh call goes through `ghx`, which in this mode refuses anything but `gh api <path>` GETs
(no `-X`/`-f`/`-F`/`--input`) and `gh pr view|list|diff|checks`; the mutating wrappers (ready, update-branch, merge, push)
refuse before reaching a probe; no ledger or claim is written. The JSON reports `gh_calls.{total,mutating,refused}`.

It enumerates open PRs titled `loop:` or on an `agent/*` branch and mirrors `runAutoMergeTick` (#754 shadow) on the CURRENT
head: loop identity (title, not Dependabot, head repo, `agent/*` branch, base) · `gap-orphan` label · run verified · test files
only, none removed, diff ≤ limit · assertion strength `pass` · no CHANGES_REQUESTED · CI green (incl. required contexts) ·
mergeable · not an audit sample. Primary category precedence: GAP_ORPHAN → POLICY_BLOCKED → ASSERTION_BLOCKED → CI_BLOCKED →
CONFLICTED → POLICY_BLOCKED (audit sample) → UNKNOWN (any missing data; never READY) → READY. Every other blocker is listed as
secondary; READY PRs list the transitions an apply run needs (`mark_ready`, `update_branch`, `ci_on_new_head`,
`squash_merge_at_head`).

Assertion verdicts and run verification live in the prod DB, not on GitHub: pass them as a file —
`{"source": "...", "prs": {"737": {"assertion_strength": "pass", "run_verified": true, "maker_branch": "agent/…", "diff_max": 400}}}`.
A PR without an entry is ASSERTION_BLOCKED (and `run_verified` unknown); the dry-run never reads the DB.

## Guarantees

| Rule | How |
|---|---|
| Live state before every action | PR state + head and main are re-read before acting, before the merge call and after it |
| SATISFIED needs proof on main | the PR's net diff reverse-applies on current main and does not forward-apply, and every file the PR adds exists there; a ledger entry or patch-id alone is never proof; anything else ⇒ FAIL_CLOSED |
| Idempotency | intent key = sha256(repo \| PR \| `git patch-id --stable` of the PR diff); ledger `MT_LEDGER` (default `~/.djimit/merge-train.ledger.jsonl`), states CLAIMED → RUNNING → MERGED \| SATISFIED \| FAIL_CLOSED \| ESCALATED \| SUPERSEDED |
| Concurrency | each intent is claimed with an atomic `mkdir` under `merge-train.claims/`; a live claim (owner pid alive, within `MT_CLAIM_TTL_S`, default 2 h) makes another worker exit 6; a stale claim is reclaimed and live state re-verified |
| Stale jobs | `PR@HEAD` jobs exit SUPERSEDED when the head moved; a PR closed/reopened/re-headed during execution aborts before the merge call; a rebuilt branch marks its old head superseded |
| Merge outcome | decided from live state (PR MERGED and change on main), never from the CLI exit code; a merged PR never gets `update-branch`; the merge is pinned to the validated head (`sha=`) |
| Stale head | the head after update-branch is read back and becomes the expected head; CI, mergeability and policy are re-read for it; pre-update CI is never reused |
| Bounded | CI wait, head read-back and every gh call are bounded; TIMEOUT ⇒ HOLD; signals ⇒ `cancelled` + claim released |
| Main moved | if main changed between the CI wait and the merge call, the attempt is redone |
| Rebuild | `rebase` classifies each own commit (present / absent / ambiguous), rebuilds by cherry-picking the absent ones onto main, and pushes only if the rebuilt diff equals the original change hunk for hunk; never an empty branch; ambiguous ⇒ FAIL_CLOSED, cherry-pick conflict ⇒ ESCALATE (branch restored) |

Every external call is a probe overridable with `MT_<NAME>` (tests: `packages/server/src/__tests__/merge-train.test.ts`,
`merge-train-correctness.test.ts`).

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
