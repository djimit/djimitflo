---
type: integration-connector
title: "GitHub Integration: Webhooks & PR Review"
description: The GitHub connector surface — the raw-body HMAC-verified webhook at /github/webhook handling issues and pull_request events, deduped integration-inbox intake keyed by delivery ID and payload sha256, the GITHUB_REPOSITORY_PATHS allowlist, the GithubPrReviewService loop runs that post comments and commit statuses through the gh CLI, and the LoopDraftPrService that ships certified loop runs as draft PRs (G4, default off).
tags: [github, webhook, hmac-signature, pr-review, integration-inbox, gh-cli, dedupe, loop-run, draft-pr]
sources:
  - id: openwiki-source-bb1ebe868e35e9e500714501
    resource: repo://Dockerfile
  - id: openwiki-source-e085af0cae8866b4b64f17a2
    resource: repo://packages/server/src/__tests__/evidence-freshness.test.ts
  - id: openwiki-source-f322ba4a78e55adb01bd4c05
    resource: repo://packages/server/src/__tests__/github-pr-review-llm.test.ts
  - id: openwiki-source-5e8ccb34bcafd796b3f6a16f
    resource: repo://packages/server/src/__tests__/github-pr-review-webhook.test.ts
  - id: openwiki-source-fb6f8ef1a73fc922398d2685
    resource: repo://packages/server/src/__tests__/github-webhooks.test.ts
  - id: openwiki-source-eade8d5b063b116951ad7f82
    resource: repo://packages/server/src/__tests__/loop-draft-pr-service.test.ts
  - id: openwiki-source-922486a2b03bd894d1e9f283
    resource: repo://packages/server/src/index.ts
  - id: openwiki-source-88025dd4e11a95c17cde0683
    resource: repo://packages/server/src/routes/github-webhooks.ts
  - id: openwiki-source-e25da9650619e280c998992e
    resource: repo://packages/server/src/services/evidence-freshness.ts
  - id: openwiki-source-34dbd5b3123e070678b30d30
    resource: repo://packages/server/src/services/github-pr-review-service.ts
  - id: openwiki-source-875d6fe4c748ad23e7800ff1
    resource: repo://packages/server/src/services/integration-inbox-service.ts
  - id: openwiki-source-6996102cb8a12952e08c5888
    resource: repo://packages/server/src/services/loop-daemon.ts
  - id: openwiki-source-b41bf296406aa0c468600a4e
    resource: repo://packages/server/src/services/loop-draft-pr-service.ts
  - id: openwiki-source-7154de76781720358bf72a94
    resource: repo://packages/server/src/services/repo-registry.ts
  - id: openwiki-source-6c7f10ad81b9df82a04d3c57
    resource: repo://packages/server/src/services/work-item-service.ts
generated: { by: "openwiki/0.5.2", at: "2026-10-17T12:03:52.116Z" }
verified:
  - by: openwiki/0.5.2
    at: 2026-10-17T12:03:52.116Z
---

# GitHub Integration: Webhooks & PR Review

This page covers the GitHub connector in both directions. Inbound, the
`POST /github/webhook` endpoint implemented by `createGitHubWebhookRoutes` in
`packages/server/src/routes/github-webhooks.ts` has two event branches
(`issues` and `pull_request`), with `IntegrationInboxService` intake for
issues and the `GithubPrReviewService` turning pull_request deliveries into
reviewed `loop_run`s posted back to GitHub via the `gh` CLI. Outbound,
`LoopDraftPrService` ships certified loop runs as draft PRs (G4, default
off). The repository path allowlist guards everything that touches a local
checkout. Outbound Telegram, MCP drift, and other inlets share the inbox
service but are documented separately; the broader route inventory lives in
`/openwiki/integrations/exposed-surface.md`, and the goal/loop state machine
used by both PR flows in `/openwiki/workflows/maker-checker-loop.md`.

## Mounting order is load-bearing: raw bytes before JSON

In `packages/server/src/index.ts` the router is mounted at `/github/webhook`
**before** `app.use(express.json())`, with an inline comment spelling out
why: the `X-Hub-Signature-256` HMAC authenticates the exact wire bytes, so
the body must never be reserialized JSON. The same comment re-affirms the
second half of the ordering invariant: **this connector imports work items
only; it never starts goals/loops/workers** (that holds for the issues
intake at the HTTP boundary; the pull_request branch's internal,
non-LLM-interpretation review pipeline is the documented exception described
below). The router itself layers, in order:

1. an `express-rate-limit` limiter of **60 requests per minute** (draft-8
   standard headers);
2. `express.raw({ type: 'application/json', limit: '256kb', inflate: false })`,
   so `req.body` arrives as a `Buffer`.

The handler hard-fails with `400 GITHUB_WEBHOOK_RAW_BODY_REQUIRED` if the body
is not a `Buffer`, defending against any future remounting behind a JSON
parser. If `GITHUB_WEBHOOK_SECRET` is unset or blank, every POST returns
`503 GITHUB_WEBHOOK_UNCONFIGURED`. When a secret is set, the signature must
match `^sha256=[a-f0-9]{64}$` and is compared against an HMAC-sha256 of the
raw body with `crypto.timingSafeEqual`, so verification is constant-time and
never leaks prefix information.

## Repository allowlist: GITHUB_REPOSITORY_PATHS

`repository.full_name` from the payload (validated by zod as
`owner/repo`-shaped) is resolved through `configuredRepository()`, which
parses the `GITHUB_REPOSITORY_PATHS` environment variable as a JSON object
mapping repo names to local directories. A mapping is only accepted when the
value is an **absolute** path that currently exists as a directory; the stored
result is `realpathSync`-resolved, so symlink tricks cannot escape the
allowlist. Unknown repos, malformed JSON, relative paths, and missing
directories all yield `422 GITHUB_WEBHOOK_REPOSITORY_UNCONFIGURED`. This is
the same class of operator-controlled path allowlist used elsewhere on the
exposed surface, and it is complemented by the authenticated
`/repositories` scan routes (`packages/server/src/routes/repositories.ts`),
which sanitize repository paths for non-admin readers — the webhook allowlist
and the scanned-repository registry are separate mechanisms.

## Issues branch: intake only, never execution

For `X-GitHub-Event: issues`, only actions `opened` and `labeled` are accepted
(zod schema `issuePayload`); every other event type is acknowledged with
`202 { status: 'ignored' }`. A `labeled` event is itself ignored (`202`,
`label_not_selected`) unless the applied label equals
`GITHUB_LOOP_LABEL` (default `djimitflo`).

A valid delivery produces exactly one triaged work item via
`IntegrationInboxService.importEvent` with `source: 'github_issue'` and
`recommended_loop: 'repo-maintenance-loop'`:

- The issue title/body/URL are wrapped in a
  `BEGIN_EXTERNAL_CONTENT source=github_issue trust=untrusted … END_EXTERNAL_CONTENT`
  fence, because arbitrary issue text is a prompt-injection vector for any
  eventual maker run that later reads the description.
- A `risk_class` is derived from labels: `critical`/`sev1`/`p0` → critical,
  `high`/`sev2`/`p1` → high, `medium`/`p2` → medium, otherwise low.
- The response is `202 { status: 'imported', work_item_id, created,
  execution_started: false, operator_review_required: true }` — the connector
  **imports work items only and never starts goals, loops, or workers** for
  issues. A compliance audit entry (`github_issue_imported`,
  `authentication: 'github_hmac_sha256'`, `execution_started: false`) records
  that boundary decision.

Re-delivery of the same issue under a new delivery ID routes through
`WorkItemService.upsertBySourceRef`, which refreshes title, description, and
metadata but preserves operator-owned scheduling state (`status`,
`assigned_runtime`, `assigned_agent_id`, `parent_goal_id`,
`recommended_loop`) and only raises, never lowers, the risk class.

## pull_request branch: synchronous goal + loop_run, then gh-backed review

`pull_request` events with actions `opened`, `synchronize`, or `reopened`
(zod schema `pullRequestPayload`, including a 40-hex `head.sha`) take a
deliberately different path from issues. Inside one immediate SQLite
transaction the handler:

1. creates a goal whose objective is the PR title/URL wrapped in the same
   `BEGIN_EXTERNAL_CONTENT … trust=untrusted` fence, with acceptance criteria
   "Post an automated review comment and Check Run for this pull request";
2. starts a `repo-maintenance-loop` run with a single `target_finding` whose
   `file_path` is a **stable anchor file** — the first of `package.json`,
   `README.md`, `AGENTS.md` present in the repository (`422
   GITHUB_WEBHOOK_NO_ANCHOR_FILE` if none exists), giving the loop's
   bookkeeping finding a real file to point at;
3. records the delivery, then commits.

Only after the transaction commits does the handler call
`GithubPrReviewService.startReview(...)` — the code carries an explicit
comment that shelling out to `gh` must never happen inside the transaction —
and answers `202 { status: 'accepted', loop_run_id, review }`. The route
comment justifies auto-starting here versus operator review for issues: the
review is expected to behave like a CI check, and Phase 1 interprets no
untrusted content with an LLM; Phase 2 must keep the external-content
wrapping when a real LLM reads PR data.

```mermaid
flowchart TD
    R["POST /github/webhook raw body"] --> RL["60 req/min limiter and 256kb raw cap"]
    RL --> SEC{"GITHUB_WEBHOOK_SECRET set?"}
    SEC -- no --> S503["503 GITHUB_WEBHOOK_UNCONFIGURED"]
    SEC -- yes --> SIG{"timingSafeEqual HMAC sha256"}
    SIG -- bad --> S401["401 GITHUB_WEBHOOK_SIGNATURE_INVALID"]
    SIG -- ok --> EV{"X-GitHub-Event"}
    EV -- issues --> LBL{"opened or selected label"}
    LBL -- no --> IG1["202 ignored"]
    LBL -- yes --> INBOX["IntegrationInboxService.importEvent as triaged work_item, execution never started"]
    EV -- pull_request --> TX["transaction: goal plus loop_run plus delivery row"]
    TX --> REV["GithubPrReviewService.startReview after commit"]
    REV --> GH["gh pr comment and gh api commit status"]
    EV -- other --> IG2["202 unsupported_event"]
```

*Webhook request flow: shared verification, then the divergent issues
(import-only) and pull_request (auto review) branches.*

## Delivery dedupe: github_webhook_deliveries

Both branches persist every processed delivery in
`github_webhook_deliveries (id, event, source_ref, result_json,
payload_sha256, created_at)` — the table is created on router construction
and `payload_sha256` is backfilled with an `ALTER TABLE` when missing.
Dedupe is keyed on the `X-GitHub-Delivery` header (restricted to
`[A-Za-z0-9-]{1,128}`) and runs inside the same transaction as the import:

- Same delivery ID **and** identical event, source_ref, and payload sha256 →
  the stored response is replayed verbatim with `200 { status: 'duplicate' }`,
  and no second review or `gh` invocation happens.
- Same delivery ID but different hash, source ref, event, or a missing stored
  result → `409 GITHUB_WEBHOOK_DELIVERY_CONFLICT`, because a delivery ID
  rebound to different content is an integrity violation, not a retry.

## GithubPrReviewService: a checker-only loop run posted back to GitHub

`GithubPrReviewService` (`packages/server/src/services/github-pr-review-service.ts`)
owns the table `github_pull_request_reviews` with a unique index on
`(owner, repo, pr_number, head_sha)` and status
`pending | commented | completed | failed`. Its docstring frames it as
Djimitflo's own replacement for the retired Kilo Code Bot, with two phases:

### Phase 1 (default, no LLM)

`runCheckerVerdict` synthesizes the maker/checker pair through the real
`LoopService` state machine: because the PR's commits already *are* the
patch, a `manual` maker lease is inserted and immediately completed with a
note that no isolated worktree exists, then a `manual` checker lease submits
the verdict via `submitCheckerVerdict` with a `manual_attestation`
(`roborev-webhook`). The verdict itself is an explicitly labeled rule-based
stub over stats fetched with `gh pr view --json title,url,additions,
deletions,changedFiles,files`:

- more than **40 changed files** or **1500 added+deleted lines** →
  `needs_revision` ("please split or request manual review");
- any path matching `/\.env|secret|credential/i` → `needs_revision`;
- otherwise `accepted`.

The bookkeeping loop_run has no worktree, so loop verification marks the
worktree/assignment/diff/checks gates `skipped` (E2, not applicable) and
leaves the status alone; the verdict posted to GitHub is computed
independently from the PR's own diff stats, not from the loop outcome. Once
that verdict is on GitHub the run has done its job, so after a successful
comment `settleReviewRun` settles it: the loop_run is set to `completed`
(from `planning`/`running`/`blocked`) with metadata
`settled_by: 'github-pr-review'`, and — idempotently, catching earlier
settles too — any still-`running` goal of an already-settled review run is
also completed. Both updates are prod-hardening fixes: 32 blocked review
runs in 3 hours (2026-09-25) inflated the blocked count and would have been
replayed as failures by the dream state, and 42 review goals stayed
`running` after their runs were settled (2026-09-27). A review that failed
a gate still leaves the run `blocked`, since the `UPDATE` only fires on the
success path.

### Phase 2 (opt-in real LLM checker)

Setting `GITHUB_PR_REVIEW_RUNTIME` to one of `codex`, `opencode`, `claude`,
`gemini`, `editor`, `mock` switches `startReview` to return `pending`
immediately and run `runLlmReview` asynchronously. That path fetches
`pull/<n>/head` from origin, materializes a real worktree on a
`djimitflo/pr-review-<n>-<id>` branch, hard-resets it to the PR head SHA,
writes the `gh pr diff` output into `.djimitflo/PR_REVIEW_PACKET.md` wrapped
as untrusted external content (the first point a real LLM reads PR data),
completes the maker lease with that assignment packet, and drives a real
checker through `LoopService.executeChecker()` with a 480s timeout. It is off
by default precisely because auto-spawning a paid LLM call on every PR push
is the runaway-cost failure mode that retired the bot this replaces.

### Never-throw failure semantics and the comment body

Both phases converge on `postToGithub`: the markdown body (verdict line,
changed-file/line counts, the loop run ID, optional LLM notes, and a
"Static findings (roborev)" section when `RoborevFindingsService.readPending`
has findings matching `owner/repo` at the head SHA) is written to a temp file
and posted with `gh pr comment --body-file`. Status reporting then uses
`gh api repos/{owner}/{repo}/statuses/{head_sha}` with context
`djimitflo-review` and state `success | failure | pending` — a comment in the
code explains the Checks API rejects personal-access-token auth with a hard
403, so the older Commit Status API renders the green/red dot instead.
`startReview` never throws: any `gh`/GitHub failure is recorded as
`status: 'failed'` on the review row with the error in metadata, a
`github_pr_review_failed` audit entry is written, and the webhook still
answers 202, keeping Djimitflo's own database authoritative over a transient
GitHub outage; successful reviews likewise write a `github_pr_reviewed`
audit entry. Every `git`/`gh` subprocess call in both phases carries a
**15s timeout** (`GH_TIMEOUT_MS`); only the Phase 2 checker LLM runs longer
(480s).

## LoopDraftPrService: certified runs leave the VPS as draft PRs (G4)

The outbound counterpart of the review flow lives entirely outside the
webhook. When the loop daemon's verification pass finds all gates passing
(step 9b of `packages/server/src/services/loop-daemon.ts`, inside the
`if (allGatesPass)` learning-loop closure at `L912`–`L915`), it calls
`LoopDraftPrService.openForRun(run.id)` inside a try/catch whose comment
promises a PR failure will **never fail the daemon**. The service
(`packages/server/src/services/loop-draft-pr-service.ts`) is gated on
`LOOP_AUTO_DRAFT_PR_ENABLED === 'true'` — its docstring explains the
rationale: a certified run used to sit in a VPS worktree until it was
harvested by hand (#357, #363), but publishing to GitHub must stay opt-in,
and the merge stays human because the PR is opened as a **draft** hand-off.

`openForRun` then requires `GITHUB_REPOSITORY` (`owner/repo`) and
`GITHUB_TOKEN`; any missing precondition is not thrown but recorded as a
`draft_pr_failed` warning loop event with a null return. Only runs in `ready_for_human_merge` or
`completed` qualify, and a run whose metadata already carries `pr_url`
returns it unchanged — at most one PR per run.

The target repo is per-goal (B2, multi-repo oracle lanes), not blindly
`GITHUB_REPOSITORY`: the slug comes from the linked proposal's
`repo:<slug>` evidence ref, falling back to the primary repo. A proposal
naming a different repo gets a PR only when that repo is a registered extra
repo (`repo-registry`, `EXTRA_REPOS_ENABLED` on) — otherwise
`draft_pr_failed: repo_not_registered` — and the worktree's push-remote URL
must parse back to the same slug or the run fails with `repo_mismatch` and
nothing is pushed.

Two quality gates can run between the change-set selection and the push:

- **Batch-8 evidence freshness** (`evidence-freshness.ts`,
  `LOOP_EVIDENCE_FRESHNESS_MODE=off|shadow|enforce`): the maker lease's
  recorded `evidence_read_set` (files the checks *read* but did not edit)
  is re-fingerprinted against freshly fetched current main, and the
  `fresh|stale|unknown` result is persisted into
  `loop_runs.metadata.evidence_freshness`. A `stale` read set records an
  `evidence_stale` (enforce) or `evidence_stale_shadow` event; enforce mode
  additionally marks the run with a `requeue` metadata flag and returns
  null — the re-check is queued rather than opening a PR over evidence that
  has rotted. A failed base fetch means "unknown" and fails open.
- **RX-6 arrival throttle** (`LOOP_DRAFT_PR_THROTTLE_MODE=shadow|enforce`):
  counts open GitHub PRs whose title starts with `loop:` against
  `LOOP_DRAFT_PR_MAX_OPEN` (default 5). At or over the cap, enforce mode
  records `draft_pr_throttled` and opens nothing (shadow records
  `draft_pr_throttle_shadow` and opens anyway). A failing open-PR list
  call never throttles — the queue probe fails open.

The publication itself is deliberately hygienic:

- From the latest non-superseded **completed** maker lease it takes the
  worktree and branch, then commits only the maker's real files: tracked
  diffs plus untracked files, excluding anything under `node_modules`,
  lockfile install noise (a `package-lock.json` whose sibling
  `package.json` was not itself touched), and symlinks. An empty change set
  fails with `no changes in the maker worktree` instead of pushing noise.
- The commit and push run as `djimitflo-loop <loop@djimitflo.invalid>`,
  and the push authenticates with the token passed as a one-off
  `http.extraheader` basic-auth header, so the token is never written into
  the remote URL or `.git/config` (a test asserts the absence), and any
  error message is scrubbed of `basic …` credentials before it lands in the
  `draft_pr_failed` event.
- The PR is opened over the REST API (`POST /repos/{repo}/pulls`, bearer
  token) with `draft: true`, a 120-character-capped title prefixed `loop:`
  taken from the linked self-improvement proposal when the goal has one,
  base `LOOP_DRAFT_PR_BASE` (default `main`), remote `LOOP_DRAFT_PR_REMOTE`
  (default `origin`), and a body listing the recorded checker and
  security_checker verdicts plus the file list. Behind
  `LOOP_PR_BODY_V2 === 'true'` the body (UX-10) additionally carries the
  lane name, oracle check results, a gate summary, the `HEAD~1..HEAD` diff
  stat, a mutation score parsed from the mutation check's report, and a run
  link only when `DJIMITFLO_PUBLIC_URL` is https — stripped to ids,
  aggregates and numbers, and secret-redacted, because the repo is public.
- On success the PR URL is persisted into `loop_runs.metadata.pr_url` and a
  `draft_pr_opened` event is recorded; on any failure the run is untouched
  and only the `draft_pr_failed` event remains.

The service file also exports two read models over
`loop_runs.metadata.pr_url` (no GitHub call): `listDraftPrs` for the
draft-PRs cockpit route — folding merge-survival's polled `pr_outcome` and
`auto_merge` decision into per-row evolutionary settlement states and
aggregate counts, failing soft to `null` totals on a partial schema and
leaving registered-extra-repo PRs out of the default view — and
`countOpenLoopPrs` for the needs-you count, which likewise returns `null`
(unknown) on a schema hiccup rather than "nothing open".

## Production dependency: the pinned gh CLI in the Dockerfile

Because the review phases shell out to `gh` and the draft-PR flow shells out
to `git`, the production image (`Dockerfile`, runner stage) provisions both.
The apt layer (`L64`–`L67`) installs
`ca-certificates git python3-minimal curl procps libatomic1` with
`--no-install-recommends` after a full `apt-get upgrade` (the layer is
preceded by an apt config forcing IPv4 and bounded retries/timeouts after
three stalled mirror downloads); a comment over the
`gh` block (`L69`–`L71`) names `GithubPrReviewService` as the consumer of the
CLI for PR comments and Check Runs. The CLI itself is installed from a
**statically fetched, pinned `.deb`** — `ARG GH_CLI_VERSION=2.100.0`,
downloading `gh_${GH_CLI_VERSION}_linux_${ARCH}.deb` for the
`dpkg --print-architecture` build architecture from
`github.com/cli/cli/releases` with `curl -fsSL` plus retry flags, installing
via `dpkg -i`, and probed with `gh --version` so a broken install fails the
build — rather than adding a third-party apt repository. The `git`, `curl`, and
`ca-certificates` packages in the same layer are what Phase 2's
fetch/reset worktree commands and the draft-PR push rely on.

## Configuration summary

| Variable | Role |
| --- | --- |
| `GITHUB_WEBHOOK_SECRET` | HMAC key for `X-Hub-Signature-256`; unset → 503 |
| `GITHUB_REPOSITORY_PATHS` | JSON map of `owner/repo` to absolute local directory (realpath-resolved) |
| `GITHUB_LOOP_LABEL` | Label selectivity for `issues/labeled` events (default `djimitflo`) |
| `GITHUB_PR_REVIEW_RUNTIME` | Opt-in Phase 2 LLM checker runtime; unset → Phase 1 stub |
| `ROBOREV_PENDING_PATH` | Location of pending roborev findings folded into the comment |
| `LOOP_WORKTREE_ROOT` | Worktree root used by the Phase 2 path |
| `LOOP_AUTO_DRAFT_PR_ENABLED` | Master switch for the G4 draft-PR hand-off (default off) |
| `GITHUB_REPOSITORY` / `GITHUB_TOKEN` | Primary repo and bearer token for the draft-PR push and REST call |
| `LOOP_DRAFT_PR_BASE` / `LOOP_DRAFT_PR_REMOTE` | Draft PR base branch (default `main`) and push remote (default `origin`) |
| `EXTRA_REPOS_ENABLED` / `GITHUB_REPOSITORY_PATHS` | Repo registry for the per-goal draft-PR target (B2 multi-repo lanes) |
| `LOOP_EVIDENCE_FRESHNESS_MODE` | Re-fingerprint the check read set vs current main before publishing (`off`/`shadow`/`enforce`) |
| `LOOP_DRAFT_PR_THROTTLE_MODE` / `LOOP_DRAFT_PR_MAX_OPEN` | RX-6 arrival throttle on open `loop:`-titled PRs (cap default 5; list failure fails open) |
| `LOOP_PR_BODY_V2` / `DJIMITFLO_PUBLIC_URL` | Richer redacted PR body (UX-10); run link only over an https public URL |

Operator-facing defaults and environment setup are cross-referenced in
`/openwiki/operations/configuration-reference.md`.

## Focused tests

- `packages/server/src/__tests__/github-webhooks.test.ts` — the issues
  branch end-to-end: signed `opened` delivery imports a work item whose
  description contains the prompt-injection body inside the
  `BEGIN_EXTERNAL_CONTENT` fence, zero goals/loop_runs are created, a repeat
  delivery replays with 200, and a new delivery refreshes content without
  rewinding operator-set `status`/`assigned_runtime`.
- `packages/server/src/__tests__/github-pr-review-webhook.test.ts` — the
  Phase 1 PR branch with mocked `gh`: small PR → accepted with a
  `github_pull_request_reviews` row, completed maker+checker leases, and the
  bookkeeping loop_run settled `completed` with `settled_by:
  github-pr-review`; settling also idempotently completes the goals of
  earlier settled review runs while leaving a real running goal untouched;
  large PRs (>40 files / >1500 lines) and sensitive paths
  (`.env.production`) → `needs_revision`; a failing `gh pr comment` records
  `failed` without crashing the webhook; duplicate deliveries re-POST with
  no further `gh` calls; roborev findings are folded into or omitted from
  the comment body.
- `packages/server/src/__tests__/github-pr-review-llm.test.ts` — Phase 2
  with only `gh` faked: a real `git` origin exposes `refs/pull/9/head`, the
  worktree is materialized and reset to the PR SHA, the mock checker runs
  for real, and the review settles as `commented` with both leases completed
  and the worktree containing the PR's commit.
- `packages/server/src/__tests__/loop-draft-pr-service.test.ts` — the G4
  hand-off with a real bare git remote and mocked fetch: disabled flag and
  refused GitHub responses both no-op (`draft_pr_failed` recorded, nothing
  thrown); the pushed branch contains only the maker's files (lockfile noise
  and the `node_modules` symlink excluded); the token never lands in
  `.git/config`; a second call for the same run returns the stored URL
  without re-opening the PR; and the RX-6 throttle tests cover off (no list
  call), shadow over the cap (event + PR opened), enforce over/under the
  cap (nothing pushed/PR opened), and a failing open-PR list never
  throttling, plus the UX-10 v2 body assertions (lane, oracle, gates,
  mutation gain, secret redaction, https-only run link).
- `packages/server/src/__tests__/evidence-freshness.test.ts` — the Batch-8
  read-set gate on `openForRun`: off leaves the flow unchanged, shadow
  records and still opens, enforce blocks the PR when files the checks read
  changed on main, and a base-fetch failure fails open.
- `packages/server/src/__tests__/multi-repo-oracle-lanes.test.ts` — the B2
  per-goal PR target: unregistered extra-repo proposals get no PR, and the
  draft lands in the registered extra repo when `EXTRA_REPOS_ENABLED=on`.

The same service also feeds the cockpit: `listDraftPrs` aggregates
`loop_runs.metadata.pr_url` rows with merge-survival settlement states
(covered by `draft-prs-route.test.ts`, `loop-auto-merge.test.ts` and
`merge-survival-settlement.test.ts`).
