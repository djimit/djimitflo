---
type: integration-surface
title: Telegram Bot Gateway & Webhook Route
description: The two Telegram surfaces — the @djimitflo/telegram long-polling gateway (TELEGRAM_BOTS_CONFIG, filesystem bot-token leases, machine-scoped task creation) and the server's secret-gated /api/telegram webhook route (TelegramBotService, allowlist + TELEGRAM_USER_MAP command identity, telegram_identities as the only authorizer for Approve/Deny and triage buttons, readiness status) — plus the operator push channel/digest and the TelegramApiService that funnels both into the authenticated local REST/approval spine.
tags: [telegram, webhook, long-polling, file-lease, identity-linking, operator-push, approvals, environment-configuration]
sources:
  - id: openwiki-source-bb3f481cb7205f63895b02fc
    resource: repo://packages/server/src/__tests__/live-canvas.test.ts
  - id: openwiki-source-0d1b9de7fd5d8ad8dea14a11
    resource: repo://packages/server/src/__tests__/public-boundaries.test.ts
  - id: openwiki-source-4d8d624020a6e9a8fee06db9
    resource: repo://packages/server/src/__tests__/telegram-api-chain.test.ts
  - id: openwiki-source-bba4030f92909a51ce121819
    resource: repo://packages/server/src/__tests__/tg2-telegram-context.test.ts
  - id: openwiki-source-e57612dc55cb1fe7d7373bd5
    resource: repo://packages/server/src/config/runtime-profile.ts
  - id: openwiki-source-922486a2b03bd894d1e9f283
    resource: repo://packages/server/src/index.ts
  - id: openwiki-source-13e7bffe2fd4d8b2a22e195d
    resource: repo://packages/server/src/routes/index.ts
  - id: openwiki-source-3b48fdf6c91879952665c466
    resource: repo://packages/server/src/routes/telegram.ts
  - id: openwiki-source-a666ef9855d3d9d9e0c851f0
    resource: repo://packages/server/src/services/telegram-api-service.ts
  - id: openwiki-source-e4cd8cc6130b083fe8ec600a
    resource: repo://packages/server/src/services/telegram-bot-service.ts
  - id: openwiki-source-1914db9c4b7d9d79c827e45d
    resource: repo://packages/server/src/services/telegram-identity.ts
  - id: openwiki-source-03ff56e13d2508b0e43d5df4
    resource: repo://packages/telegram/package.json
  - id: openwiki-source-5ffb649082c8f0103a72ae51
    resource: repo://packages/telegram/src/index.test.ts
  - id: openwiki-source-d441a5558c86cce9b01f7575
    resource: repo://packages/telegram/src/index.ts
  - id: openwiki-source-eac024e1155739aa49af1b28
    resource: repo://packages/telegram/src/transport.test.ts
generated: { by: "openwiki/0.5.2", at: "2026-10-17T12:03:52.116Z" }
verified:
  - by: openwiki/0.5.2
    at: 2026-10-17T12:03:52.116Z
---

# Telegram Bot Gateway & Webhook Route

Djimitflo exposes **two independent Telegram surfaces** that share configuration
conventions but never share transport code:

1. **The long-polling gateway** (`packages/telegram`, package
   `@djimitflo/telegram`): a multi-bot grammY long poller started in-process by
   the server in operator-capable runtime profiles, guarded by filesystem
   leases so only one process polls a given bot token.
2. **The webhook route** (`packages/server/src/routes/telegram.ts`): a
   single-bot HTTP webhook mounted at `/api/telegram`, where Telegram pushes
   updates to a public URL (`TELEGRAM_WEBHOOK_URL`) authenticated by a shared
   secret header. The same bot doubles as the **operator push channel** —
   approval cards with Approve/Deny buttons, one-tap triage, alerts, and the
   daily digest all flow out through it.

Both surfaces resolve Telegram senders to DjimFlo identities before anything
runs, and both reach the task API exclusively through `TelegramApiService`,
whose own header comment states the architecture: *Telegram is an
authenticated API client, not another task/approval writer.* Neither surface
writes tasks, approvals, or telemetry directly — every mutation is a loopback
HTTP call carrying a freshly minted per-actor Bearer token into the ordinary
`/api` task and approval routes, so ownership, audit events, and
separation-of-duties rules apply unchanged (see
[Approval Decision Flow](/openwiki/workflows/approval-decision-flow.md)).

Two authorization mechanisms exist side by side, deliberately:

- **Chat commands** (both surfaces) gate on the env pair
  `TELEGRAM_ALLOWED_USERS` + `TELEGRAM_USER_MAP`, resolved at `configure()`
  time against `users.id` or `users.email`.
- **Button callbacks** (Approve/Deny and triage) are authorized **only** by
  the D3 table `telegram_identities` — an operator-maintained allowlist of
  Telegram user id → Djimitflo user, where the mapped user must be active and
  their RBAC role must hold the same permission the web route demands
  (`approve:task` for approvals and memory review, `write:governance` for D5
  pre-screen labels). The comment in `routes/telegram.ts` is blunt:
  *TELEGRAM_USER_MAP does not authorise buttons.*

```mermaid
flowchart TD
  TG["Telegram servers"] -->|"pushed updates (secret header)"| WH["POST /api/telegram/webhook"]
  GW["TelegramGatewayService (operator profile)"] -->|"getUpdates long poll per bot token"| TG
  WH --> SVC["TelegramBotService"]
  GW --> SVC2["ops callbacks (createTask / getStatus / cancelTask)"]
  SVC --> CMD["chat commands: env allowlist + userMap ladder"]
  SVC --> BTN["button callbacks: telegram_identities (D3) + RBAC"]
  CMD --> TAPI["TelegramApiService"]
  BTN --> TAPI
  SVC2 --> TAPI
  TAPI -->|"loopback HTTP + fresh per-actor JWT"| API["local /api tasks & approvals spine"]
  APPR["ApprovalService (approval created)"] -->|"pushApproval (opt-in)"| SVC
  SVC -->|"sendMessage / broadcastAlert (outbound only)"| TG
```

## The polling gateway (`@djimitflo/telegram`)

`TelegramGatewayService` (`packages/telegram/src/index.ts`) is a standalone
workspace package whose grammY dependency is dynamically imported inside
`startAll()` so merely importing the module loads nothing. It is constructed
with an array of `TelegramBotConfig` entries — `{token, machineId, agentType,
hostIp, name, allowedUsers?, userMap?}` — plus an `ops` object of three async
callbacks: `createTask(prompt, machineId, actorUserRef)`,
`getStatus(machineId, actorUserRef)`, and the optional `cancelTask(taskId,
actorUserRef)`.

### Server wiring

In `packages/server/src/index.ts` (L372–L390) the gateway starts **only when
`operatorRuntime` is true** — i.e. the `operator` or `autonomous` profile,
never the default `api` profile
(`packages/server/src/config/runtime-profile.ts`) — and only when
`TELEGRAM_BOTS_CONFIG` is set; otherwise a log line notes the gateway is
disabled. The env value is parsed as a JSON array, each entry's `allowedUsers`
and `userMap` falling back to the `TELEGRAM_ALLOWED_USERS` /
`TELEGRAM_USER_MAP` parsers shared with the webhook route, and
`TelegramGatewayService` is dynamically imported and constructed with a
`TelegramApiService` pointed at the loopback base
`http://127.0.0.1:${PORT}/api`. The instance is retained so the SIGTERM
handler can `stopAll()` it — without that, a restart sees `EEXIST` on the
lease files and skips polling (see
[Server Runtime](/openwiki/architecture/server-runtime.md)). Init and
`startAll()` failures are logged and swallowed: a broken Telegram setup never
blocks boot.

### Lease protocol

Each config acquires a per-token lease file before polling:

- The lease path is `<leaseDir>/<sha256(token).hex[0:16]>.lock`, so the raw
  bot token never touches the filesystem. `leaseDir` defaults to
  `DJIMIT_TELEGRAM_LEASE_DIR` or `os.tmpdir()/djimit-telegram-leases`.
- Acquisition uses `fs.openSync(path, 'wx')` — atomic create-or-fail. The
  payload records `machineId`, `name`, a host id (sha256 of `os.hostname()`,
  12 hex chars), pid, and start timestamp.
- A 30-second unref'd heartbeat `utimesSync`s all held leases; the TTL is 2
  minutes, so a live owner never looks expired while a crashed owner's lease
  becomes reclaimable after at most two minutes.
- On `EEXIST`, takeover is two-tiered: (1) **host-qualified dead-pid probe** —
  if the recorded host matches this host and the recorded pid is dead
  (`process.kill(pid, 0)` → `ESRCH`; `EPERM` still counts as alive), the lease
  is unlinked and re-acquired — cross-host pid probes are meaningless in
  separate pid namespaces, so no pid check runs there; (2) **TTL expiry** — a
  lease whose mtime is older than the TTL is reclaimed regardless of host or
  payload readability, so a truncated lease written by a crashed writer can
  never wedge polling forever. An `ENOENT` between `EEXIST` and `statSync` is
  treated as a release and immediately retried.
- If acquisition still fails, `startAll()` retries with backoff
  (2 s, 5 s, 15 s, 30 s, 60 s) to ride out an overlapping restart, then warns
  and skips that bot.
- Per-bot init failure removes that bot's lease file so one bad token doesn't
  strand a lease; `stopAll()` clears the heartbeat, `Promise.allSettled`s
  every `bot.stop()`, and unlinks all leases.

### Authorization and commands

A grammY middleware runs before every command handler and enforces the whole
contract in one place: the sender id must be present, must be in
`allowedUsers`, **and** must map through `userMap` to a non-blank actor string
— anything else gets '⛔ Telegram user is not authorized and linked to a
DjimFlo account.' and is dropped. The comment at the middleware states the
invariant: *a bot token identifies the transport, never the requesting user.*
Commands are deliberately narrow — `/start`, `/status`, `/task
<beschrijving>`, `/cancel <task_id>` — where `/task` forwards the prompt and
the config's `machineId` to `ops.createTask`, binding the task to that bot's
machine; `/cancel` without a wired `cancelTask` op surfaces
`TASK_CANCELLATION_UNAVAILABLE`. Because a polling bot owns the update stream,
Telegram's 409 "another getUpdates consumer" conflict is handled as
first-class: both `bot.catch` and the `bot.start()` rejection log a warning
and keep the process alive rather than crashing.

## The webhook route (`/api/telegram`)

`createTelegramRoutes(db, auth?, _wsService?, api?)` mounts at `/telegram`
under `/api` with **no mount-level middleware** — the webhook authenticates
itself, and any blanket guard at `/` or `/telegram` would break Telegram's
calls (the mount table deliberately leaves this prefix open; see
[HTTP/WebSocket API Surface](/openwiki/integrations/exposed-surface.md)). The
mount also constructs its own `TelegramApiService` against the loopback base
so the webhook surface works even when the polling gateway is not running.

### Env parsing and readiness

Three exported functions define the configuration contract:

- `parseTelegramAllowedUsers(value)` — comma-separated numeric ids; blanks and
  non-numeric entries are dropped (`Number.isFinite` filter).
- `parseTelegramUserMap(value)` — a JSON object of Telegram-id → user ref.
  Non-object/array JSON and any entry whose key is not an all-digit string or
  whose value is a blank/non-string is discarded; parse failure yields `{}`.
- `telegramConfigStatus(env, configured, db?)` — reports `{configured, ready,
  allowed_user_count, webhook_configured, linked_identity_count,
  approver_identity_count, missing_env, blocking}`. `ready` requires the four
  env prerequisites — `TELEGRAM_BOT_TOKEN`, a non-empty allowed-user list,
  `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_WEBHOOK_SECRET` — **and at least one
  approver identity**: a `telegram_identities` row whose mapped user is active
  and whose role holds `approve:task` (`approverIdentityCount`; a viewer or
  inactive user does not count, and a missing table on an old schema counts as
  zero). This is the TG-2 fix: the status used to report ready from the env
  alone while every button press was refused. `TELEGRAM_USER_MAP` still only
  feeds `linked_identity_count` and lands in `missing_env`, not in
  `blocking`; the `blocking` list names what readiness still lacks (missing
  env vars other than `TELEGRAM_USER_MAP`, "approver identity unknown (no
  database)", or the D3 remedy pointing at `/decisions`). The report is
  count-and-name only — token, URL, secret, and mapped user refs are never
  included in the payload, so the status endpoint cannot leak credentials.

On router creation, when `TELEGRAM_BOT_TOKEN` is present three things happen:
`TelegramBotService.configure()` runs, the bot is registered as the operator
push sender (`setPushSender(bot)`), and the daily-digest/triage timer starts
(`startOperatorDigest(db)`) — this webhook bot is the canonical push channel,
though both pushes stay off until their flags are set.

### Endpoints

**`POST /api/telegram/webhook`** fails closed at three gates before any body
handling:

1. bot not configured → `503`;
2. `TELEGRAM_WEBHOOK_SECRET` unset → `503` (a public webhook with no secret
   must never process updates);
3. `X-Telegram-Bot-Api-Secret-Token` header ≠ secret → `401`.

Only then is the body passed to `bot.handleWebhook()`, which returns `{ok:
true}` on success and `500` on internal error.

**`GET /api/telegram/status`** requires auth (or passes through when no auth
middleware was supplied, as in tests) and returns `telegramConfigStatus()`.

### `TelegramBotService` behavior

`handleWebhook()` dispatches `callback_query` payloads to `handleCallback()`
(button taps), validates message shape (safe-integer chat/from ids, string
text), and then applies the three-step identity ladder **before** any command
runs:

1. sender id ∈ `allowedUsers`, else '⛔ You are not authorized to use this
   bot.';
2. sender linked via `userMap` to a user ref resolved at `configure()` time
   against `users.id` *or* `users.email`, else '⛔ Telegram identity is not
   linked to a DjimFlo user';
3. the linked DjimFlo account is still `is_active`, else '⛔ DjimFlo account
   is disabled or no longer linked'.

Commands (`/start`, `/status`, `/loops`, `/agents`, `/dennis`, `/dennis_task`,
`/mission`, `/help`, `/approve`, `/reject`, `/task`, `/cancel`; the
`@botname` suffix is stripped during parsing) split into two kinds:

- **Read-only DB summaries** (`/status`, `/loops`, `/agents`, `/mission`,
  `/dennis`) query SQLite directly — loop/agent/worker counts, Dennis
  readiness snapshot — and cannot mutate anything (loop start/stop is
  explicitly not exposed).
- **Mutations** go through the optional `TelegramApiService`: `/task` posts a
  `local`-mode pending task with machine `telegram-webhook`; `/cancel` calls
  the task cancel route; `/approve` and `/reject` (the latter maps to
  `/approvals/:id/deny`) hit the approval routes, and a
  `SELF_APPROVAL_FORBIDDEN` response is translated to the Dutch 'Je kunt je
  eigen aanvraag niet goedkeuren.' — separation of duties survives Telegram.
  `/dennis_task` additionally permission-checks `create:task`, ensures the
  `dennis-agent` row exists, and creates a `dry_run`-only task pinned to
  Dennis with approval-gated metadata. If no `api` was injected, every
  mutation answers `TELEGRAM_API_UNAVAILABLE`.

### Button callbacks — D3 identity is the only authorizer

Approval and triage button taps never consult `allowedUsers`/`userMap` for
authorization. `handleCallback()` first sanity-checks the payload (chat id is
a safe integer, `callback_data` ≤ 64 bytes — Telegram's hard limit — and the
shape matches `ap:<id>`, `dn:<id>`, `rs:<id>:<reason>` or a triage kind), then
authorizes via `telegram-identity.ts`:

- `resolveTelegramActor` looks up the sender **only** in
  `telegram_identities` (which ships empty; the operator adds rows on
  `/decisions` via `PUT/DELETE /api/self-improve/telegram-identities/:id`),
  requires the mapped user to exist and be active, and takes the RBAC role
  from the users row — the chat, group, or bot a message arrived through is
  never consulted.
- `mayApproveViaTelegram` demands `approve:task`; triage uses
  `mayActViaTelegram` with the same permission the web route demands
  (`write:governance` for D5 labels, `approve:task` for memory review).
- Every decision, allow or deny, is audited as a `telegram_access` judgment;
  a failed audit insert must never turn a deny into an allow or crash the
  gateway. Being in `TELEGRAM_ALLOWED_USERS` is still required, but it is only
  a transport gate — without a D3 row the tap is refused ('⛔ Not allowed')
  and the API is never called.

From there `dn:` asks for a fixed deny reason first (`rs:` carries one of
*Out of scope / Too risky / Wrong change / Not now*), and the decision itself
goes through `api.request(actor.userId, /approvals/:id/approve|deny)` as the
mapped user, so `SELF_APPROVAL_FORBIDDEN` and every other server rule still
applies. An `APPROVAL_ALREADY_PROCESSED` reply (TG-3: lane rules can
auto-decide before the tap arrives) is answered with who decided and when,
read back from the approvals row, instead of a bare error.

### One-tap triage

The `pl:`/`mp:`/`mr:` payloads drive the D5 pre-screen-rejection label and the
memory-candidate review through exactly the same API routes the `/decisions`
dashboard calls, as the mapped user — so a memory promote records that user as
the human approver. Ids are looked up before anything runs (unknown ids get
'Not found', already-decided candidates are not re-run), and all triage taps
are refused while `TELEGRAM_TRIAGE_ENABLED` is off, pointing the operator at
the dashboard.

### Outbound delivery

Outbound delivery is one-way and fire-and-forget: `sendMessage()` POSTs
MarkdownV2 to `api.telegram.org/bot<token>/sendMessage` with a 15 s timeout,
pre-escaping MarkdownV2 metacharacters, and `broadcastAlert()` /
`requestApproval()` / `requestTriage()` fan text (plus optional inline
keyboards and an *Open* URL button) out to the allowlist. Because the request
URL embeds the credential, **all fetch errors are collapsed to
`TELEGRAM_DELIVERY_FAILED`** — raw errors could smuggle the token into logs —
and secrets handling here stays aligned with the secret-patterns service, as
verified by the delivery-rejection tests.

## Operator push channel and daily digest (`operator-push.ts`)

Historically nothing reached the operator unless they opened the dashboard —
`requestApproval`/`broadcastAlert` had zero callers. `operator-push.ts` fixes
that with three opt-in pushes, all sent through the webhook bot registered by
`setPushSender` and all **never throwing** — the approval itself never depends
on Telegram:

- **Approval push** (`TELEGRAM_PUSH_ENABLED`): `ApprovalService` calls
  `pushApproval` after an approval is created (immediately or on an unref'd
  delay). The push skips anything no longer `pending` (a lane rule may have
  auto-approved it), dedupes per approval id in `telegram_push_log`, honors
  `TELEGRAM_QUIET_HOURS` (`HH-HH` UTC, wrapping midnight) and an hourly cap
  (`TELEGRAM_PUSH_MAX_PER_HOUR`, default 6). The message (`approvalMessage`,
  ≤ 1 000 chars, secret-pattern-redacted) carries lane, proposal, files, risk
  with the matched-rule explanation, expiry, and id — enriched by
  `approvalContext`, which walks approval → task → maker lease → loop run →
  goal → proposal. Buttons are Approve / Deny / Open; the *Open* URL needs an
  `https://` `DJIMITFLO_PUBLIC_URL`.
- **Triage push** (`TELEGRAM_TRIAGE_ENABLED`, requires
  `TELEGRAM_PUSH_ENABLED`): at most `TELEGRAM_TRIAGE_MAX_PER_PUSH` (default 3)
  one-tap messages per tick for unlabelled D5 rejections and memory candidates
  awaiting review, deduped under `triage:` keys in the same log with the same
  quiet hours and a **separate** hourly budget so triage never crowds out an
  approval.
- **Daily digest** (`OPERATOR_DIGEST_ENABLED`, at `OPERATOR_DIGEST_HOUR`,
  default 7 UTC, once per UTC day via `operator_digest_log`): 24 h
  verified/regressed/new/expired counts, a "waiting for you" total with one
  count + `/decisions#…` deep link per section, loop-PR settlement and draft
  age, realm gate states, stalls, disarmed schedulers, dependency-lane and
  test-only auto-merge status. Unreadable counts render as 'unknown', never a
  calm 0. `pushNotice` (same gate as approvals) adds one informational line
  for test-only auto-merge events, including the **REVOKED** alert.

`startOperatorDigest(db)` arms a single 15-minute unref'd tick (only when the
digest or triage is enabled) that records the needs-you shadow ranking once
per day, then runs the digest and the triage push. All message content leaves
to Telegram — ids, titles, aggregates, pre-screen reasons, ≤ 400 chars of a
memory candidate — so it is redacted and carries no hosts; the full flag list
(`OPERATOR_PUSH_FLAGS`) is asserted against the
[Configuration Reference](/openwiki/operations/configuration-reference.md)
by a runbook drift test.

## `TelegramApiService` — the authenticated chain

The constructor enforces `TELEGRAM_API_MUST_BE_LOCAL`: the base URL must be
`http:` on `127.0.0.1`/`localhost`/`[::1]` with no embedded credentials, so a
mapped user's Bearer token can never be forwarded to a remote origin.
`requireActor(ref, permission?)` resolves the actor by id or email, rejects
disabled/unlinked accounts (`AUTH_DISABLED_OR_UNLINKED`), and enforces RBAC
(`FORBIDDEN`). `request()` mints a fresh JWT per call
(`auth.generateToken(user)`) and fetches with `redirect: 'error'` and a 15 s
timeout, tolerating empty bodies (204); non-2xx responses surface the server's
error code (`data.error.code` or `DJIMFLO_API_HTTP_<status>`). The
`createTask`, `getStatus`, and `cancelTask` fields are exactly the `ops` shape
the polling gateway consumes, so the same chain test exercises both surfaces.

The net effect, proven end-to-end in `telegram-api-chain.test.ts`: wrong
webhook secret → 401; unknown/unlinked/unpermitted sender → zero tasks; an
allowed `/task` creates a pending task owned by the mapped user with a
`task.created` audit event and WebSocket broadcast; the owner cannot
self-approve; an approver-role user approves and the mock execution completes;
a viewer gets `FORBIDDEN`; only the owner can cancel a running task; a
disabled account stops creating tasks immediately.

## Failure semantics and operational notes

- **Duplicate pollers** are prevented by the lease file, not by Telegram
  409s: a second process (or a restart before SIGTERM cleanup) sees `EEXIST`,
  retries with backoff, then skips that bot with a warning. Reclaim paths are
  same-host dead-pid takeover and 2-minute TTL expiry; the 30 s heartbeat
  keeps a healthy owner fresh.
- **Gateway or webhook misconfiguration never blocks the server.** Missing
  `TELEGRAM_BOTS_CONFIG` logs and continues; gateway init failures warn;
  the webhook 503s until configured; per-bot init failure is contained to
  that bot and cleans up its lease.
- **Restart correctness depends on SIGTERM** calling `stopAll()` (heartbeat
  cleared, bots stopped, leases unlinked) — wired in
  `packages/server/src/index.ts` L450–L452. Without it the next boot must
  wait out retries or the TTL.
- **Ready ≠ env-complete.** With the TG-2 readiness rule the status endpoint
  reports `ready: true` only once a D3 approver identity exists; an env-only
  setup serves chat commands but every Approve/Deny tap is refused and
  audited.
- All Telegram variables (`TELEGRAM_BOTS_CONFIG`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_USER_MAP`, `TELEGRAM_WEBHOOK_URL`,
  `TELEGRAM_WEBHOOK_SECRET`, `DJIMIT_TELEGRAM_LEASE_DIR`, plus the
  `OPERATOR_PUSH_FLAGS` push/digest/triage flags) are tabulated in the
  [Configuration Reference](/openwiki/operations/configuration-reference.md)
  with defaults and danger ratings.

## Focused tests

- `packages/telegram/src/index.test.ts` — lease lifecycle in a temp
  `leaseDir`: duplicate-token `EEXIST` skip, same-host dead-pid takeover,
  live-pid non-takeover, TTL-expiry takeover regardless of host, truncated
  lease reclaimed after TTL but not while fresh, heartbeat armed by
  `startHeartbeat()` and cleared by `stopAll()`.
- `packages/telegram/src/transport.test.ts` — real grammY update handling:
  unknown and unlinked senders never reach `ops`; `/task@fixture_bot` and
  `/status` forward `(text, machineId, actor)` exactly.
- `packages/server/src/__tests__/telegram-api-chain.test.ts` — the full
  webhook → loopback API → owned task → independent approval → mock execution
  chain; loopback-only base URL enforcement; Telegram delivery rejections
  surfaced without credentials; secret-gated webhook reachable through the
  full router without making diff/status routes public.
- `packages/server/src/__tests__/telegram-identity.test.ts` — D3 allowlist
  ships empty and every id is denied-and-audited; inactive/invalid ids
  refused; approval via Telegram needs `approve:task`, audited either way.
- `packages/server/src/__tests__/operator-push.test.ts` — pushes off by
  default; dedupe/hourly-cap/quiet-hours; message content redacted; callback
  authorization (unmapped or `approve:task`-lacking users refused without an
  API call); deny-reason picker; self-approval refusal; digest content and
  once-per-day-at-the-hour behavior.
- `packages/server/src/__tests__/tg2-telegram-context.test.ts` — readiness
  blocked while only `TELEGRAM_USER_MAP` is set, ready with a D3 row for an
  active `approve:task` user (a viewer or inactive user does not count);
  approval-message context chain and redaction; already-decided approvals are
  not pushed.
- `packages/server/src/__tests__/tg3-approval-already-processed.test.ts` —
  409 `APPROVAL_ALREADY_PROCESSED` from the API and the bot answering who
  already decided instead of `INTERNAL_ERROR`.
- `packages/server/src/__tests__/telegram-triage.test.ts` — one-tap triage
  authorization mirrors the web routes, payload validation (≤ 64 bytes,
  kind + id only, id must exist), `TELEGRAM_TRIAGE_ENABLED` gate, memory
  promote records the D3-mapped user as human approver.
- `packages/server/src/__tests__/public-boundaries.test.ts` — missing
  `TELEGRAM_WEBHOOK_SECRET` fails closed with 503.
- `packages/server/src/__tests__/live-canvas.test.ts` (Telegram section) —
  env parsing, readiness output excludes secrets, disabled-account and
  role-downgrade behavior, Dennis dry-run task creation.
