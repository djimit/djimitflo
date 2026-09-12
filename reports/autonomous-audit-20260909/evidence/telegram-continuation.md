# Telegram continuation — local executed parity

2026-09-09. Scope: isolated audit worktree only. No Telegram messages, polling requests, webhook registrations or production mutations were sent to the provider. Existing user changes were preserved.

## Result and evidence class

The polling gateway now requires an explicitly allowed Telegram sender mapped to a DjimFlo account. Both polling and webhook task operations use the existing authenticated local REST API. Webhook approvals now reach ExecutionEngine rather than merely updating an approval row. This is **executed local transport simulation plus real HTTP/domain/audit evidence**, not live Telegram delivery or provider-runtime certification.

| Chain | Executed proof | Boundary |
|---|---|---|
| grammY update -> sender gate -> operation | Real Bot.handleUpdate and command parsing, including /task@fixture_bot; denied and unlinked senders cause zero task calls; mapped identity reaches callback | Telegram outbound API intercepted; polling startup stubbed, no provider connection |
| Webhook -> transport authentication | Real HTTP secret header, unknown/unlinked sender denial and malformed-message handling | Synthetic local credentials only |
| Webhook -> local API -> task | Real authenticated HTTP POST creates pending task with mapped created_by/owner_user_id, canonical task.created audit and WebSocket broadcast invocation | /task creates a pending task; it does not claim dispatch or completion |
| Dennis task -> shared task API | Real dry_run task retains Dennis metadata and mapped owner; viewer request is denied before Dennis agent provisioning | Existing Dennis agent bootstrap retained; no new task persistence path |
| Approval -> engine -> completion | Actual engine creates an approval for a disposable mock task; owner self-approval stays pending; viewer denied; separate approver accepted; task completes with execution events and one task.executed audit | Real orchestration using in-process MockExecutor, not a CLI/model provider and not independent human sign-off |
| Rejection -> task state | Independent /reject uses canonical decision route and leaves task cancelled | No external work starts |
| Cancellation -> ownership/lifecycle | Non-owner cannot cancel running mock; owner can; pending-task cancellation returns canonical TASK_NOT_RUNNING instead of claiming success | Existing running-only cancellation semantics preserved |
| Current account state | Account disable blocks commands; role downgrade is reflected by a freshly issued mapped-user token and canonical permission denial | No ambient admin or machine identity substituted |
| Reply failure | HTTP 429 and HTTP 200 with Telegram ok:false both reject with sanitized TELEGRAM_DELIVERY_FAILED | Transport failure simulated, no delivery claim |
| Fully assembled route graph | Valid-secret webhook is reachable without user JWT; all three diff routes and Telegram status remain protected; public health omits DB provenance; deep/metrics still require authentication | Actual createRoutes assembly and HTTP, not only isolated route mounting |

## Defects corrected

1. Polling accepted arbitrary senders. The old callback received only prompt/machineId, and startup inserted directly into tasks with created_by=machineId, bypassing real user ownership, API validation, audit and task events. The actual grammY [red test](telegram-transport-red.log) observed two unauthorized operation calls. Explicit allowlist plus userMap and the small TelegramApiService client now use existing shared routes.
2. Webhook /dennis_task wrote tasks directly without actor attribution or permission checks. It now uses the shared task API after checking the current mapped account's existing create:task permission before optional Dennis agent bootstrap.
3. Webhook /approve and /reject only called ApprovalService then Dennis-specific materialization. Ordinary task approvals could be persisted without resuming execution. Canonical approval HTTP routes now own the decision, engine continuation, denial and Dennis materialization. The local chain test proves terminal task state and audit, not merely an HTTP 200.
4. The root '/' diff mount authenticated every subsequent request, including unmatched public Telegram/health paths. Full-router [red evidence](telegram-router-red.log) showed 401 for a valid-secret webhook. Only the redundant mount-level authentication was removed; each of the three diff handlers already authenticates itself. The final test checks those boundaries remain enforced.
5. Reply sending ignored HTTP and Telegram JSON failures, falsely resolving successfully. Two [red delivery cases](telegram-delivery-red.log) now fail explicitly without including credential-bearing provider URLs in thrown errors. Outbound requests are bounded by a timeout.

The polling interface additionally exposes /cancel through the same API; webhook /task and /cancel share those operations. Existing polling /status now counts only tasks returned for that authenticated user and machine, not a machine-name impersonation.

## Verification

- [Server scope](telegram-api-chain-final.log): 29 tests passed across real HTTP Telegram chain, existing Dennis/live-canvas tests, public boundaries and route inventory.
- [Telegram workspace](telegram-transport-green.log): 29 tests passed; new real grammY command-transport regression included. Older callback sanity tests alone were not counted as transport proof.
- [Server type check](telegram-server-type-check.log), [Telegram type check](telegram-type-check.log), [changed-file lint](telegram-lint.log): exit zero. Telegram workspace build also succeeded.
- `telegram-api-chain-initial.log` retains an initial test-fixture mistake: attempting to cancel a pending task. The canonical API correctly returned TASK_NOT_RUNNING. The corrected test exercises a genuinely running mock and separately asserts the pending-task rejection; no application cancellation guard was weakened.

All test replies are intercepted. An older live-canvas test that previously attempted a fake-token network send now stubs outbound delivery; it no longer relies on an actual failed external request.

## Configuration and remaining limits

Polling `TELEGRAM_BOTS_CONFIG` accepts per-bot allowedUsers and userMap. If omitted, startup uses the existing TELEGRAM_ALLOWED_USERS and TELEGRAM_USER_MAP operator configuration. Missing mapping/allowlist fails closed. Identity references can be user IDs or emails; the local API adapter resolves a current active user for each request and creates an in-memory bearer token using the existing AuthService. Tokens are neither logged nor persisted by the adapter. API targets are restricted to local HTTP loopback; redirects are rejected. Server listening configuration must make that loopback endpoint reachable.

Only the current audit command environment was inspected for legitimate credential presence: TELEGRAM_BOT_TOKEN=false, TELEGRAM_BOTS_CONFIG=false, TELEGRAM_ALLOWED_USERS=false, TELEGRAM_USER_MAP=false. These booleans do not describe another running server or production configuration; no secret files or unrelated credentials were searched.

Live Telegram delivery remains UNVERIFIED. Polling and webhook are distinct configured transports, not proven safe to operate simultaneously on one bot token. The polling command surface is task/status/cancel; approval and Dennis commands remain webhook-specific. A single account mapping does not prove multi-channel feature completeness.

Durable Telegram update-id idempotency remains a source-observed gap: repeated delivery can create another task because the shared task-create API has no idempotency key contract. This tranche did not add a second ledger or relax the API boundary. An outbound failure after a successful task creation is therefore not an exactly-once guarantee, and retry behavior must not be represented as such.

These tests do not prove live provider execution, detached-process cancellation, Telegram delivery receipts, universal ToolBroker interception, autonomous approval authority or production promotion. Task-level policy and actual mock execution are separate from per-tool mediation.
