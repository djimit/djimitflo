---
type: integration-connector
title: "GitHub Integration: Webhooks & PR Review"
description: The GitHub connector surface — the raw-body HMAC-verified webhook at /github/webhook handling issues and pull_request events, deduped integration-inbox intake keyed by delivery ID and payload sha256, the GITHUB_REPOSITORY_PATHS allowlist, and the GithubPrReviewService loop runs that post comments and commit statuses through the gh CLI.
tags: [github, webhook, hmac-signature, pr-review, integration-inbox, gh-cli, dedupe, loop-run]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-24T19:59:50.419Z
sources:
  - id: openwiki-source-bb1ebe868e35e9e500714501
    resource: repo://Dockerfile
  - id: openwiki-source-f322ba4a78e55adb01bd4c05
    resource: repo://packages/server/src/__tests__/github-pr-review-llm.test.ts
  - id: openwiki-source-5e8ccb34bcafd796b3f6a16f
    resource: repo://packages/server/src/__tests__/github-pr-review-webhook.test.ts
  - id: openwiki-source-fb6f8ef1a73fc922398d2685
    resource: repo://packages/server/src/__tests__/github-webhooks.test.ts
  - id: openwiki-source-922486a2b03bd894d1e9f283
    resource: repo://packages/server/src/index.ts
  - id: openwiki-source-88025dd4e11a95c17cde0683
    resource: repo://packages/server/src/routes/github-webhooks.ts
  - id: openwiki-source-34dbd5b3123e070678b30d30
    resource: repo://packages/server/src/services/github-pr-review-service.ts
  - id: openwiki-source-875d6fe4c748ad23e7800ff1
    resource: repo://packages/server/src/services/integration-inbox-service.ts
  - id: openwiki-source-6c7f10ad81b9df82a04d3c57
    resource: repo://packages/server/src/services/work-item-service.ts
generated: { by: "openwiki/0.5.2", at: "2026-09-24T19:59:50.419Z" }
---

# GitHub Integration: Webhooks & PR Review

This page covers the inbound GitHub connector: the `POST /github/webhook`
endpoint implemented by `createGitHubWebhookRoutes` in
`packages/server/src/routes/github-webhooks.ts`, its two event branches
(`issues` and `pull_request`), the `IntegrationInboxService` intake for
issues, the repository path allowlist, and the `GithubPrReviewService` that
turns pull_request deliveries into reviewed `loop_run`s posted back to GitHub
via the `gh` CLI. Outbound Telegram, MCP drift, and other inlets share the
inbox service but are documented separately; the broader route inventory lives
in `/openwiki/integrations/exposed-surface.md`, and the goal/loop state
machine used by the review path in `/openwiki/workflows/swarm-goal-lifecycle.md`.

## Mounting order is load-bearing: raw bytes before JSON

In `packages/server/src/index.ts` the router is mounted at `/github/webhook`
**before** `app.use(express.json())`, with an inline comment spelling out why:
the `X-Hub-Signature-256` HMAC authenticates the exact wire bytes, so the body
must never be reserialized JSON. The router itself layers, in order:

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

The loop_run legitimately settles as `blocked` (worktree/diff verification
gates fail on a worktree-less synthetic lease), which the service comment
calls expected: the verdict posted to GitHub is computed independently from
the PR's own diff stats, not from the loop outcome.

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
GitHub outage. All `gh` calls carry a 15s timeout.

## Production dependency: the pinned gh CLI in the Dockerfile

Because both review phases shell out to `gh`, the production image
(`Dockerfile`, runner stage) installs the official CLI from a statically
fetched, pinned `.deb` (`ARG GH_CLI_VERSION=2.100.0`,
`gh_<version>_linux_<arch>.deb` from `github.com/cli/cli/releases`, verified
with `gh --version` at build time) rather than adding a third-party apt
repository. `git` and `ca-certificates` are installed alongside it, which
Phase 2's worktree/fetch/reset commands also rely on.

## Configuration summary

| Variable | Role |
| --- | --- |
| `GITHUB_WEBHOOK_SECRET` | HMAC key for `X-Hub-Signature-256`; unset → 503 |
| `GITHUB_REPOSITORY_PATHS` | JSON map of `owner/repo` to absolute local directory (realpath-resolved) |
| `GITHUB_LOOP_LABEL` | Label selectivity for `issues/labeled` events (default `djimitflo`) |
| `GITHUB_PR_REVIEW_RUNTIME` | Opt-in Phase 2 LLM checker runtime; unset → Phase 1 stub |
| `ROBOREV_PENDING_PATH` | Location of pending roborev findings folded into the comment |
| `LOOP_WORKTREE_ROOT` | Worktree root used by the Phase 2 path |

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
  `github_pull_request_reviews` row and completed maker+checker leases; large
  PRs (>40 files / >1500 lines) and sensitive paths (`.env.production`) →
  `needs_revision`; a failing `gh pr comment` records `failed` without
  crashing the webhook; duplicate deliveries re-POST with no further `gh`
  calls; roborev findings are folded into or omitted from the comment body.
- `packages/server/src/__tests__/github-pr-review-llm.test.ts` — Phase 2
  with only `gh` faked: a real `git` origin exposes `refs/pull/9/head`, the
  worktree is materialized and reset to the PR SHA, the mock checker runs
  for real, and the review settles as `commented` with both leases completed
  and the worktree containing the PR's commit.
