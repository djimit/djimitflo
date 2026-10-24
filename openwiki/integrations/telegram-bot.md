---
type: integration-surface
title: Telegram Bot Gateway & Webhook Route
description: The two Telegram surfaces — the @djimitflo/telegram long-polling gateway (TELEGRAM_BOTS_CONFIG, filesystem bot-token leases, machine-scoped task creation) and the server's unauthenticated-but-secret-gated /api/telegram webhook route (TelegramBotService commands, D3 telegram_identities-gated approve/deny and triage buttons, readiness status) — plus the TelegramApiService that funnels both into the authenticated local REST/approval spine.
tags: [telegram, webhook, long-polling, file-lease, identity-linking, operator-profile, approvals, environment-configuration]
sources:
  - id: openwiki-source-bb3f481cb7205f63895b02fc
    resource: repo://packages/server/src/__tests__/live-canvas.test.ts
  - id: openwiki-source-0d1b9de7fd5d8ad8dea14a11
    resource: repo://packages/server/src/__tests__/public-boundaries.test.ts
  - id: openwiki-source-4d8d624020a6e9a8fee06db9
    resource: repo://packages/server/src/__tests__/telegram-api-chain.test.ts
  - id: openwiki-source-f1335b23c2574efd59e8ad5a
    resource: repo://packages/server/src/__tests__/telegram-identity.test.ts
  - id: openwiki-source-f58b1dd397ba2ebc85842c01
    resource: repo://packages/server/src/__tests__/telegram-triage.test.ts
  - id: openwiki-source-bba4030f92909a51ce121819
    resource: repo://packages/server/src/__tests__/tg2-telegram-context.test.ts
  - id: openwiki-source-d51c6e3eca462ac5da2da494
    resource: repo://packages/server/src/__tests__/tg3-approval-already-processed.test.ts
  - id: openwiki-source-e57612dc55cb1fe7d7373bd5
    resource: repo://packages/server/src/config/runtime-profile.ts
  - id: openwiki-source-922486a2b03bd894d1e9f283
    resource: repo://packages/server/src/index.ts
  - id: openwiki-source-13e7bffe2fd4d8b2a22e195d
    resource: repo://packages/server/src/routes/index.ts
  - id: openwiki-source-34ae7c3a7cf830b5ef01826b
    resource: repo://packages/server/src/routes/self-improvement.ts
  - id: openwiki-source-3b48fdf6c91879952665c466
    resource: repo://packages/server/src/routes/telegram.ts
  - id: openwiki-source-5619b6ed7c07b419c8fb3fd2
    resource: repo://packages/server/src/services/operator-push.ts
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
generated: { by: "openwiki/0.5.2", at: "2026-10-24T12:32:22.727Z" }
verified:
  - by: openwiki/0.5.2
    at: 2026-10-24T12:32:22.727Z
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
   secret header.

Both surfaces resolve Telegram senders through an explicit allowlist and both
reach the task API exclusively through `TelegramApiService`, whose own header
comment states the rule: *Telegram is an authenticated API client, not another
task/approval writer.* Every mutation is a loopback HTTP call carrying a
freshly minted per-actor Bearer token into the ordinary `/api` task and
approval routes, so ownership, audit events, and separation-of-duties rules
apply unchanged (see
[Approval Decision Flow](/openwiki/workflows/approval-decision-flow.md)). Where
they differ is identity: chat commands on the webhook bot map senders through
the `TELEGRAM_USER_MAP` env var, while **button decisions (approve/deny and
one-tap triage) are authorised only by the D3 `telegram_identities` table** —
the env map links chat commands but has never authorised a button press.

```mermaid
sequenceDiagram
  participant TG as Telegram servers
  participant WH as POST /api/telegram/webhook
  participant SVC as TelegramBotService
  participant ID as telegram-identity (D3)
  participant API as TelegramApiService
  participant APP as ApprovalService (/api/approvals)

  TG->>WH: update (X-Telegram-Bot-Api-Secret-Token)
  WH->>WH: 503 unless configured and secret set, 401 on wrong secret
  WH->>SVC: handleWebhook(payload)
  alt inline button (callback_query)
    SVC->>ID: mayApproveViaTelegram(telegram_user_id)
    ID->>ID: telegram_identities row + active user + role holds approve:task, audited as telegram_access
    ID-->>SVC: actor or refusal
    SVC->>API: request(actor.userId, /approvals/:id/approve or /deny)
    API->>APP: loopback HTTP + fresh per-actor Bearer JWT
    APP-->>SVC: decided, SELF_APPROVAL_FORBIDDEN, or APPROVAL_ALREADY_PROCESSED
    SVC->>TG: sendMessage outcome to the chat
  else text command (message)
    SVC->>SVC: identity ladder (allowedUsers, TELEGRAM_USER_MAP link, is_active)
    SVC->>API: createTask or cancelTask as the mapped user
    API->>APP: same loopback API and approval spine
  end
```

Sequence: a pushed update reaches the secret-gated webhook, button presses are
authorised against `telegram_identities` and executed through the loopback
approval API as the mapped user, while text commands pass the env-map identity
ladder before any mutation.

## The polling gateway (`@djimitflo/telegram`)

`TelegramGatewayService` (`packages/telegram/src/index.ts`) is a standalone
workspace package whose only runtime dependency is grammY, dynamically imported
inside `startAll()` so merely importing the module loads nothing. It is
constructed with an array of `TelegramBotConfig` entries — `{token, machineId,
agentType, hostIp, name, allowedUsers?, userMap?}` — plus an `ops` object of
three async callbacks: `createTask(prompt, machineId, actorUserRef)`,
`getStatus(machineId, actorUserRef)`, and the optional `cancelTask(taskId,
actorUserRef)`.

### Server wiring

In `packages/server/src/index.ts` (L371–L389) the gateway starts **only when
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
handler can `stopAll()` it (L449–L451) — without that, a restart sees `EEXIST`
on the lease files and skips polling until the TTL expires (see
[Server Runtime](/openwiki/architecture/server-runtime.md)). Init and `startAll()`
failures are logged and swallowed: a broken Telegram setup never blocks boot.

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
  strand a lease; `stopAll()` clears the heartbeat, `Promise.allSettled`s every
  `bot.stop()`, and unlinks all leases.

### Authorization and commands

A grammY middleware runs before every command handler and enforces the
whole contract in one place: the sender id must be present, must be in
`allowedUsers`, **and** must map through `userMap` to a non-blank actor string
— anything else gets '⛔ Telegram user is not authorized and linked to a
DjimFlo account.' and is dropped. The comment at the middleware states the
invariant: *a bot token identifies the transport, never the requesting user.*
Commands are deliberately narrow — `/start`, `/status`, `/task`, `/cancel`;
`/task` forwards `(text, machineId, actor)` to `ops.createTask`, binding the
task to that bot's machine; `/cancel` without a wired `cancelTask` op surfaces
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
(`packages/server/src/routes/index.ts` L204) so the webhook surface works even
when the polling gateway is not running.

### Env parsing and readiness

Three exported functions define the configuration contract:

- `parseTelegramAllowedUsers(value)` — comma-separated numeric ids; blanks and
  non-numeric entries are dropped (`Number.isFinite` filter).
- `parseTelegramUserMap(value)` — a JSON object of Telegram-id → user ref.
  Non-object/array JSON and any entry whose key is not an all-digit string or
  whose value is a blank/non-string is discarded; parse failure yields `{}`.
- `telegramConfigStatus(env, configured, db)` — reports `{configured, ready,
  allowed_user_count, webhook_configured, linked_identity_count,
  approver_identity_count, missing_env, blocking}`. Env readiness requires
  `TELEGRAM_BOT_TOKEN`, a non-empty allowed-user list, `TELEGRAM_WEBHOOK_URL`
  and `TELEGRAM_WEBHOOK_SECRET`; **overall `ready` additionally requires at
  least one D3 approver** — `approverIdentityCount(db)` counts active
  `telegram_identities` rows whose user's role holds `approve:task` (TG-2:
  the status used to report ready from the env alone while every button press
  was refused, and `TELEGRAM_USER_MAP` still does not authorise buttons).
  `blocking` names what is missing, including the no-approver case. The report
  is count-and-name only — token, URL, secret, and mapped user refs are never
  included in the payload, so the status endpoint cannot leak credentials.

On router creation, `TelegramBotService.configure()` runs only when
`TELEGRAM_BOT_TOKEN` is present, and the configured bot is registered as the
canonical push channel: `setPushSender(bot)` arms the operator-push services
(approval requests, daily digest, triage) and `startOperatorDigest(db)` starts
the daily digest timer — both pushes stay off until their flags are set
(UX-12/13; see Configuration Reference for `TELEGRAM_PUSH_ENABLED`,
`TELEGRAM_TRIAGE_ENABLED`, `OPERATOR_DIGEST_*`).

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
middleware was supplied, as in tests) and returns `telegramConfigStatus()` with
the live database so `approver_identity_count` reflects the current D3 table.

### `TelegramBotService` message commands

`handleWebhook()` dispatches `callback_query` updates to `handleCallback` (see
below) and validates message payloads (safe-integer chat/from ids, string
text) before applying the three-step identity ladder **before** any command
runs:

1. sender id ∈ `allowedUsers`, else '⛔ You are not authorized';
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

### Approve/Deny and triage buttons (`handleCallback`)

Inline-button presses are a separate, stricter path than chat commands. The
callback payload is validated first (safe-integer chat id, `callback_data`
under Telegram's 64-byte limit, strict `ap:`/`dn:`/`rs:`/`pl:`/`mp:`/`mr:`
kind-and-id patterns), then the sender must pass
`mayApproveViaTelegram(db, telegram_user_id)` (`pl:` labels use
`mayActViaTelegram` with `write:governance`) **and** be in `allowedUsers`.

- **Approvals**: `ap:<id>` calls `/approvals/:id/approve` as the D3-mapped
  user; `dn:<id>` asks for a deny reason from four fixed buttons
  (`DENY_REASONS`: Out of scope / Too risky / Wrong change / Not now), and the
  `rs:<id>:<code>` follow-up posts `/approvals/:id/deny` with that reason.
  `SELF_APPROVAL_FORBIDDEN` is translated to '⛔ You cannot approve your own
  request.' and `APPROVAL_ALREADY_PROCESSED` to a '✅ Already decided by …'
  line that names the decider (TG-3) instead of a bare error.
- **Triage**: `pl:<id>:o|w` labels a D5 pre-screen rejection as a correct or
  wrong rejection through the same `/self-improve/proposals/:id/prescreen-label`
  route the /decisions page calls; `mp:<id>` / `mr:<id>` promote or reject a
  memory candidate through the same swarm governance routes, so a promote
  records the mapped user as the human approver. Triage requires
  `triageEnabled()` (`TELEGRAM_TRIAGE_ENABLED` on top of
  `TELEGRAM_PUSH_ENABLED`), looks the target id up before anything runs, and
  refuses a candidate already decided. Every allow/deny decision in
  `telegram-identity.ts` is audited as a `telegram_access` judgment — and the
  audit is wrapped so it can never turn a deny into an allow or crash the
  gateway.

### Identity tables vs env maps

`packages/server/src/services/telegram-identity.ts` (D3) owns the durable
identity contract: only an explicit `telegram_identities` row (telegram user
id → Djimitflo user) identifies anyone; the chat, group, or bot an update
arrived through is never consulted; the mapped user must exist and be active,
and their RBAC role is the only source of permissions — approving via Telegram
requires the same `approve:task` permission as the web UI (see
[Roles and Permissions](/openwiki/concepts/roles-and-permissions.md)). The
table ships empty; operators manage rows on `/decisions` (Telegram identities)
via `PUT/DELETE /api/self-improve/telegram-identities/:telegramId`, which
itself demands `manage:config` because a mapped Telegram account acts as that
user — mapping is delegation. The env `TELEGRAM_USER_MAP` remains only the
chat-command link resolved by `configure()` against `users.id` or
`users.email`.

Outbound delivery is one-way and fire-and-forget: `sendMessage()` POSTs
MarkdownV2 to `api.telegram.org/bot<token>/sendMessage` with a 15 s timeout,
pre-escaping MarkdownV2 metacharacters, and `broadcastAlert()` /
`requestApproval()` / `requestTriage()` fan text out to the allowlist. Because
the request URL embeds the credential, **all fetch errors are collapsed to
`TELEGRAM_DELIVERY_FAILED`** — raw errors could smuggle the token into logs —
and secrets handling here stays aligned with the secret-patterns service, as
verified by the delivery-rejection tests.

## `TelegramApiService` — the authenticated chain

The constructor enforces `TELEGRAM_API_MUST_BE_LOCAL`: the base URL must be
`http:` on `127.0.0.1`/`localhost`/`[::1]` with no embedded credentials, so a
mapped user's Bearer token can never be forwarded to a remote origin.
`requireActor(ref, permission?)` resolves the actor by id or email, rejects
disabled/unlinked accounts (`AUTH_DISABLED_OR_UNLINKED`), and enforces RBAC
(`FORBIDDEN`). `request()` mints a fresh JWT per call
(`auth.generateToken(user)`) and fetches with `redirect: 'error'` and a 15 s
timeout; non-2xx responses surface the server's error code. The `createTask`,
`getStatus`, and `cancelTask` fields are exactly the `ops` shape the polling
gateway consumes, so the same chain test exercises both surfaces.

The net effect, proven end-to-end in `telegram-api-chain.test.ts`: wrong
webhook secret → 401; unknown/unlinked/unpermitted sender → zero tasks; an
allowed `/task` creates a pending task owned by the mapped user with a
`task.created` audit event and WebSocket broadcast; the owner cannot self-
approve; an approver-role user approves and the mock execution completes; a
viewer gets `FORBIDDEN`; only the owner can cancel a running task; a disabled
account stops creating tasks immediately.

## Failure semantics and operational notes

- **Duplicate pollers** are prevented by the lease file, not by Telegram
  409s: a second process (or a restart before SIGTERM cleanup) sees `EEXIST`,
  retries with backoff, then skips that bot with a warning. Reclaim paths are
  same-host dead-pid takeover and 2-minute TTL expiry; the 30 s heartbeat
  keeps a healthy owner fresh. (The lease protocol described above is the
  implemented single-poller mechanism; `packages/telegram/src/index.test.ts`
  exercises it end to end.)
- **Gateway or webhook misconfiguration never blocks the server.** Missing
  `TELEGRAM_BOTS_CONFIG` logs and continues; gateway init failures warn; the
  webhook 503s until configured; per-bot init failure is contained to that bot
  and cleans up its lease.
- **Unconfigured D3 identities fail closed.** The status endpoint keeps
  `ready` false and lists the missing approver in `blocking` until at least
  one active `telegram_identities` row holds `approve:task`; button presses
  are refused and audited in the meantime, and the audit insert itself can
  never crash the gateway.
- **Restart correctness depends on SIGTERM** calling `stopAll()` (heartbeat
  cleared, bots stopped, leases unlinked) — wired in
  `packages/server/src/index.ts` L449–L451. Without it the next boot must wait
  out the retry backoff or the TTL.
- All Telegram variables (`TELEGRAM_BOTS_CONFIG`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_USER_MAP`, `TELEGRAM_WEBHOOK_URL`,
  `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_PUSH_ENABLED`,
  `TELEGRAM_TRIAGE_ENABLED`, `OPERATOR_DIGEST_*`,
  `DJIMIT_TELEGRAM_LEASE_DIR`) are tabulated in the
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
- `packages/server/src/__tests__/telegram-identity.test.ts` — the D3 table
  ships empty so every id is denied and audited; active/inactive resolution;
  approval via Telegram needs the web `approve:task` permission, audited
  either way.
- `packages/server/src/__tests__/telegram-triage.test.ts` — one-tap triage
  end to end: unknown and permission-lacking tappers refused and audited;
  payload validation (kind + id, ≤ 64 bytes, id must exist);
  `TELEGRAM_TRIAGE_ENABLED` off refuses; a mapped admin labels through the
  /decisions route; memory promote records the mapped user as human approver;
  triage push respects quiet hours, per-push and hourly caps, and never crowds
  out an approval push.
- `packages/server/src/__tests__/tg2-telegram-context.test.ts` — TG-2
  readiness: not ready with only `TELEGRAM_USER_MAP`; ready once a D3 row for
  an active `approve:task` user exists; approval push messages carry lane,
  proposal, file, run and why, secret-redacted, under 1 000 chars; decided
  approvals are not re-pushed.
- `packages/server/src/__tests__/tg3-approval-already-processed.test.ts` —
  an already-decided approval button answers '✅ Already decided by …' instead
  of an error.
- `packages/server/src/__tests__/public-boundaries.test.ts` — missing
  `TELEGRAM_WEBHOOK_SECRET` fails closed with 503.
- `packages/server/src/__tests__/live-canvas.test.ts` (Telegram section) —
  env parsing, readiness output excludes secrets, disabled-account and
  role-downgrade behavior, Dennis dry-run task creation.
