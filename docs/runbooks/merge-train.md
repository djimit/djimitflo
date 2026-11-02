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
overrides the required contexts (default: branch protection of `main`; unreadable protection is HOLD
`required_checks_unavailable`, never a remembered list). A required context is green only on `success` of its newest run on
the exact sha — `skipped`, `neutral`, `cancelled`, `stale` is red (`required_not_success:<name>=<conclusion>`).

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
| Evidence binding | The PR head is read before downloading its diff and compared again afterward. A changed head exits SUPERSEDED. A failed main refresh exits HOLD; cached main is never accepted as current proof. |
| SATISFIED needs proof on main | the PR's net diff reverse-applies on current main and does not forward-apply, and every file the PR adds exists there; a ledger entry or patch-id alone is never proof; anything else ⇒ FAIL_CLOSED |
| Idempotency | intent key = sha256(repo \| PR \| `git patch-id --stable` of the PR diff); ledger `MT_LEDGER` (default `~/.djimit/merge-train.ledger.jsonl`), states CLAIMED → RUNNING → MERGED \| SATISFIED \| FAIL_CLOSED \| ESCALATED \| SUPERSEDED |
| Concurrency | each intent is claimed with an atomic `mkdir` under `merge-train.claims/`; a live claim (owner pid alive, within `MT_CLAIM_TTL_S`, default 2 h) makes another worker exit 6; a stale claim is reclaimed and live state re-verified |
| Stale jobs | `PR@HEAD` jobs exit SUPERSEDED when the head moved; a PR closed/reopened/re-headed during execution aborts before the merge call; a rebuilt branch marks its old head superseded |
| Merge outcome | decided from live state (PR MERGED and change on main), never from the CLI exit code; a merged PR never gets `update-branch`; the merge is pinned to the validated head (`sha=`) |
| Stale head | the head after update-branch is read back and becomes the expected head; CI, mergeability and policy are re-read for it; pre-update CI is never reused; an accepted update without a new head within the settle window exits HOLD |
| Bounded | CI wait, head read-back and every gh call are bounded; TIMEOUT ⇒ HOLD; signals ⇒ `cancelled` + claim released |
| Main moved | if main changed between the CI wait and the merge call, the attempt is redone |
| Rebuild | `rebase` classifies each own commit (present / absent / ambiguous), rebuilds by cherry-picking the absent ones onto main, and pushes only if the rebuilt diff equals the original change hunk for hunk; never an empty branch; ambiguous ⇒ FAIL_CLOSED, cherry-pick conflict ⇒ ESCALATE (branch restored) |
| Rebuild publication | The push leases the exact original remote head; a concurrent update is preserved. A push that does not report success restores the local branch and exits FAIL_CLOSED without marking the old head superseded. Inspect the live remote before retrying: a transport error can occur after the server accepted a push. The branch must already be published at the original head. |

Every external call is a probe overridable with `MT_<NAME>` (tests: `packages/server/src/__tests__/merge-train.test.ts`,
`merge-train-correctness.test.ts`).

## Merge paths and release enforcement (forensic 2026-10-26 rank 9)

Every client that merges to main or deploys from it applies one rule to the exact head (or main) commit: **each required
check of main's branch protection needs a success of the newest run from its required producer (`checks[].app_id`;
-1 = any source) — another app's run of the same name never stands in for it; skipped, neutral, cancelled or stale is
not a pass; not reported by that producer is pending; unreadable protection is HOLD, never a remembered list.** GitHub
itself counts a skipped required check as passed, so the workflows must not let a required job be skipped
(`scripts/ci-workflows.test.mjs`). TypeScript gates share `services/required-checks.ts`.

| Path | Who arms it | Class | Where the rule lives |
|---|---|---|---|
| `scripts/merge-train.sh run` | operator, PR list with pinned heads | any PR | `checks_verdict`, `ci_wait` (only the verdict `pass` is green) |
| loop auto-merge | operator, `LOOP_AUTO_MERGE_TEST_ONLY` | earned exception: test-only loop PRs, capped, 10 % sample, self-revoking (core-invariants FR-004) | `loop-auto-merge.ts` `checks()` |
| dependency lane | operator, `DEPENDENCY_LANE_MODE` | earned exception: npm patch/minor Dependabot PRs, capped, revoked by red main | `dependency-lane.ts` `checkState()` |
| auto-deploy | operator, systemd timer on the VPS | deploys main | `scripts/auto-deploy.sh` (required contexts from the public branch summary) |
| `dependabot-auto-merge.yml` | operator decision (kept on #1061) | Dependabot patch/minor, same-repo, author and actor `dependabot[bot]` | `scripts/dependabot-merge.sh`: merge-train `checks_verdict` on the exact head (run from main), then a merge pinned to that head — not GitHub-native auto-merge, which counts a skipped required check as passed |

No workflow arms GitHub-native auto-merge (`scripts/ci-workflows.test.mjs` fails on `gh pr merge --auto`): Dependabot
auto-merge waits up to an hour for the gate and leaves the PR open on red, pending, a moved head or a refused (behind)
merge. Its own running job (`auto-merge`) is excluded via `MT_IGNORE_CHECKS`, which never excludes a required check.

CI tests the commit protection reads: every job checks out `github.event.pull_request.head.sha` (not the synthetic merge
commit), required jobs have no job-level or step-level `if:` and no `continue-on-error`, their triggers have no path
filters, and every action is pinned to a commit sha.

**Build receipt.** `scripts/deploy-vps.sh` resolves the Dockerfile's `ARG NODE_IMAGE` tag to its registry digest
(`node@sha256:…`; pulled only when the tag is absent, as before) and builds with that digest, so both stages use exactly
the base the receipt records; no digest means no build. After the build it writes
`/srv/djimitflo/build-receipts/<image id>.json` (write-once, mode 0444): commit, image tag, image id, `package-lock.json`
sha256, Dockerfile sha256, base image digest, build time (each verified: a missing or different lockfile or Dockerfile hash refuses the switch). The image declares commit, lock hash and base
(`DJIMITFLO_BUILD_COMMIT`, `DJIMITFLO_BUILD_LOCK_SHA256`, `DJIMITFLO_BUILD_BASE_IMAGE`); both stages install with `npm ci`
(the runtime `npm install --omit=dev` rewrote the lock inside the image). Before the switch the deploy verifies all of
it against the receipt. After the compose rewrite every failure — a failing `docker compose up`, an unhealthy start, a
running image that is not the receipt's — restores the previous compose.yml, recreates the previous container and waits
for it to be healthy again (or says the rollback is NOT healthy). Housekeeping after a healthy deploy never fails it.
To check by hand: `docker inspect -f '{{.Image}}' djimitflo-live` and
`cat /srv/djimitflo/build-receipts/<that id without sha256:>.json`.
