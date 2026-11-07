---
type: operator-workflow
title: "Approval Request & Decision Flow"
description: The operator-facing approval lifecycle — how the server creates requests transactionally (with the outbox event atomically inside), realizes a configurable TTL as expiry, and applies decisions atomically with a data-layer self-approval ban — plus the authority-ledger recording and the REST, dashboard, WebSocket, and Telegram surfaces operators use to act on them.
tags: [approvals, decision-flow, expiry, separation-of-duties, atomicity, authority-ledger, event-outbox, telegram, dashboard, websocket]
verified:
  - by: openwiki/0.5.2
    at: 2026-11-07T14:47:55.436Z
sources:
  - id: openwiki-source-c59282d47905fbb590f903cd
    resource: repo://packages/dashboard/src/App.tsx
  - id: openwiki-source-d92c9d196f1885a52b397aba
    resource: repo://packages/dashboard/src/components/ApprovalCard.tsx
  - id: openwiki-source-c158d08fa824b9d5951b1025
    resource: repo://packages/dashboard/src/components/Layout.tsx
  - id: openwiki-source-e478782969879bcd9b84ec7e
    resource: repo://packages/dashboard/src/components/PendingApprovalsBanner.tsx
  - id: openwiki-source-25ea83c0f1b895ef632e2fed
    resource: repo://packages/dashboard/src/hooks/usePendingApprovals.ts
  - id: openwiki-source-a88410cf109e6199a2c75b3c
    resource: repo://packages/dashboard/src/pages/ApprovalQueuePage.tsx
  - id: openwiki-source-a7875fb874c6b22d9843c688
    resource: repo://packages/dashboard/src/pages/DecisionsInboxPage.tsx
  - id: openwiki-source-cd524ffa0394e6f0b9d7b1d5
    resource: repo://packages/server/src/__tests__/approval-atomicity.test.ts
  - id: openwiki-source-f8a431d32ba737885bdd6d38
    resource: repo://packages/server/src/__tests__/approvals-http.test.ts
  - id: openwiki-source-99d295c6f9e6e124e5b4056a
    resource: repo://packages/server/src/__tests__/authority-ledger-and-outbox.test.ts
  - id: openwiki-source-5d8407f289bf3dac6575e4bf
    resource: repo://packages/server/src/__tests__/event-outbox-atomicity.test.ts
  - id: openwiki-source-f5435020aa95ebec27e5276f
    resource: repo://packages/server/src/__tests__/manual-approvals.test.ts
  - id: openwiki-source-4d8d624020a6e9a8fee06db9
    resource: repo://packages/server/src/__tests__/telegram-api-chain.test.ts
  - id: openwiki-source-d77928939568025601f76bb2
    resource: repo://packages/server/src/execution/execution-engine.ts
  - id: openwiki-source-c6ff9a9bb5a3e771103ed6e5
    resource: repo://packages/server/src/routes/approvals.ts
  - id: openwiki-source-13e7bffe2fd4d8b2a22e195d
    resource: repo://packages/server/src/routes/index.ts
  - id: openwiki-source-3b48fdf6c91879952665c466
    resource: repo://packages/server/src/routes/telegram.ts
  - id: openwiki-source-51c1d51f70f1d72e6714c483
    resource: repo://packages/server/src/services/approval-context.ts
  - id: openwiki-source-fb188ee3df500e339b426861
    resource: repo://packages/server/src/services/approval-service.ts
  - id: openwiki-source-c6dea3219b2706b35a322348
    resource: repo://packages/server/src/services/authority-ledger-service.ts
  - id: openwiki-source-3520db2e41877a293398e0b2
    resource: repo://packages/server/src/services/event-outbox-service.ts
  - id: openwiki-source-5619b6ed7c07b419c8fb3fd2
    resource: repo://packages/server/src/services/operator-push.ts
  - id: openwiki-source-a666ef9855d3d9d9e0c851f0
    resource: repo://packages/server/src/services/telegram-api-service.ts
  - id: openwiki-source-e4cd8cc6130b083fe8ec600a
    resource: repo://packages/server/src/services/telegram-bot-service.ts
  - id: openwiki-source-1914db9c4b7d9d79c827e45d
    resource: repo://packages/server/src/services/telegram-identity.ts
  - id: openwiki-source-fa568b0862f0b0b901ecfc19
    resource: repo://packages/server/src/services/websocket-service.ts
  - id: openwiki-source-eebaf177712ad937ce48ce28
    resource: repo://packages/shared/src/types/common.ts
  - id: openwiki-source-78f33dbc13edb0630c5e1cd3
    resource: repo://stryker.config.js
generated: { by: "openwiki/0.5.2", at: "2026-11-07T14:47:55.436Z" }
---

# Approval Request & Decision Flow

An approval is a durable row in the `approvals` table (schema in
packages/server/src/database/schema.ts#L266-L289) that moves through one
lifecycle: `pending` → `approved` | `denied` | `expired` (`ApprovalStatus` in
packages/shared/src/types/common.ts#L80-L86). `ApprovalService`
(packages/server/src/services/approval-service.ts) owns that table and every
transition; routes, the dashboard, and Telegram are operator surfaces that read
the rows and call `ExecutionEngine.handleApprovalDecision()`. The pipeline
context that *creates* most requests is documented in
[Governance Pipeline](/openwiki/concepts/governance-pipeline.md); this page
covers the request → decide → record chain that operators see.

## Where requests come from

A request enters the table through `createApproval()` from three directions:

1. **Execution gates** — `ExecutionEngine.executeTask()` hits a
   `require_approval` policy verdict, calls `createApproval()` with the risk
   assessment, policy id, and an `executionInputHash` in metadata, then moves
   the task to `awaiting_approval` and broadcasts
   `EXECUTION_PAUSED_FOR_APPROVAL` (execution-engine.ts L411-L455). These
   approvals authorize resuming a paused dispatch.
2. **Manual action reviews** — `POST /api/approvals` (mounted with
   `requireAuth` at packages/server/src/routes/index.ts#L146, handled in
   routes/approvals.ts L37-L63) lets an operator with `create:task` attach a
   human-review request to an existing task they can modify. These carry
   `metadata.manual_action: true` and **never gate execution**: a decision only
   records evidence (execution-engine.ts L918-L927) and cannot dispatch a task.
3. **Other services** — the governance feedback loop and the Dennis agent call
   the same `createApproval()` for their own gated proposals.

Every request gets an `expires_at` from `approvalTtlMs()` and a `requested_by`
maker. The TTL was once a fixed hour; it is now **configurable** via the
`APPROVAL_TTL_MS` environment variable (default 1 h, clamped to 5 min .. 7
days; approval-service.ts L24-L32, verified by approval-ttl.test.ts). The maker
is the `requestedBy` argument — the dispatcher id for engine gates, the JWT
subject (`getUser(req).sub`) for manual reviews (routes/approvals.ts L53).

## Creation is transactional; decisions are atomic

`createApproval()` runs the row insert, its canonical `approval.requested`
audit record, **and** the `djimitflo.approval.requested` outbox event inside
one `db.transaction().immediate()` (L95-L143). If the audit or the outbox
insert fails, the approval rolls back with them — the event is a required
(CODE-003) producer, committed by the same transaction it describes. Only after
the commit does it schedule the Telegram push, broadcast the WebSocket event,
and record the authority-ledger `HOLD`:

- **Telegram push (post-commit, L144-L148)** — off unless
  `TELEGRAM_PUSH_ENABLED=true`, and delayed by `TELEGRAM_PUSH_DELAY_MS`
  (default 15 s; `0` pushes immediately) via `pushApproval()`
  (operator-push.ts L148-L173). The delay exists so that an approval a lane
  rule auto-approves right after creation is re-checked as `decided` and skipped
  instead of pushed. `pushApproval` dedupes per approval id
  (`telegram_push_log`), honors `TELEGRAM_QUIET_HOURS` and a
  `TELEGRAM_PUSH_MAX_PER_HOUR` cap (default 6), and never throws — the approval
  never depends on Telegram.
- **WebSocket broadcast** — `approval.requested`
  (`WebSocketEventType.APPROVAL_REQUESTED`, shared/src/types/websocket.ts#L54).
- **Authority ledger** — `recordDecision(approval, 'EXECUTION_APPROVAL_REQUESTED', 'HOLD', requestedBy)`.

`decideApproval(id, approved, decidedBy, reason)` enforces the non-negotiables
(L185-L265), wrapped in the same kind of immediate transaction:

- **Validation & status guard** — `approved` must be a boolean
  (`INVALID_APPROVAL_DECISION`); a missing row throws `Approval not found`; a
  non-pending row throws `APPROVAL_EXPIRED` (already expired) or `Approval
  already processed` (L186-L199).
- **Expiry check first** — if `expires_at` is missing/unparseable or already
  past, the service persists the expired record (outbox + audit) **inside**
  that decision transaction and throws `APPROVAL_EXPIRED` only after the commit
  (L200-L203, L252-L261).
- **Self-approval is forbidden at the data layer** — `decidedBy ===
  approval.requested_by` throws `SELF_APPROVAL_FORBIDDEN` regardless of what
  any route-level permission allowed (L204-L209). This closes the maker/admin
  gap left by the role table; see
  [Roles & Permissions](/openwiki/concepts/roles-and-permissions.md).
- **The status transition is compare-and-swap** — the UPDATE carries
  `WHERE id = ? AND status = 'pending'`, so two simultaneous deciders cannot
  both win; the loser sees `Approval already processed` (L213-L236).
- **`decided_by` is persisted** — the row records `decided_by`,
  `decided_at`, `decision_reason`, plus the legacy `approved_by`/`approved_at`/
  `denied_at`/`denial_reason` fields, and the matching
  `approval.granted`/`approval.denied` audit entry and outbox event are written
  in the same transaction (L237-L250).

After the commit, and only then, the service broadcasts the corresponding
`approval.granted` / `approval.denied` / `approval.expired` event and calls
`recordDecision()` with `ALLOW` or `DENY` (L252-L262). A broadcast failure is
logged, never a domain failure (L319-L327). The atomicity suite
(packages/server/src/__tests__/approval-atomicity.test.ts) pins exactly one
`approval_expired` audit row and one publish, even when a decision attempt
itself realizes the expiry; the outbox-atomicity suite
(packages/server/src/__tests__/event-outbox-atomicity.test.ts L73-L113) proves
an outbox insert fault rolls back the request, the decision, and the expiry.

## Expiry is lazy, and it unsticks tasks

There is no sweeper cron. Expiry is **realized on demand**:

- `getLatestPendingForTask()` expires every stale `pending` row for the task
  before answering the caller, each through `expireApproval()` → broadcast +
  `DENY` ledger record (L71-L88). When `executionOnly: true` is passed it
  filters out `manual_action` reviews via a JSON predicate **before** `LIMIT`,
  so a newer manual review cannot hide an older execution gate (L82-L86).
- `decideApproval()` turns a decision attempt against a stale row into the
  persisted expiry described above (L200-L203).

`expireApprovalRecord()` (L278-L317) does one more thing that matters
operationally: while expiring the row it also moves its task out of
`awaiting_approval` to `cancelled` — guarded on the task still being
`awaiting_approval` so a task that moved on is untouched — and writes a
`task_cancelled_after_approval_expiry` audit row. This fixes the "task stuck in
awaiting_approval forever" bug the code comment documents, because the
ApprovalCard only renders decision buttons for `pending` rows.

## Every step lands in the authority ledger and the outbox

`recordDecision()` (L159-L165) is best-effort — it never blocks the approval it
is describing — and writes to the append-only **`authority_events`** ledger via
`recordAuthorityEvent()` (authority-ledger-service.ts L24-L42). Rows are
sequenced per `correlation_id` (the task id), carry a sha-256 payload digest,
and classify the actor as `human`, `agent`, or `service`. The service emits
`HOLD` on request, `ALLOW`/`DENY` on decision, and `DENY` with state
`EXECUTION_APPROVAL_EXPIRED` on expiry. Recording silently returns `null` if
the `authority_events` table has not been provisioned.

**Actor typing** changed (actorType, L172-L183): an actor is `human` only when
it matches a real user (`users.id` or `users.email` — the route decides as the
JWT subject), `agent:` prefix → `agent`, and everything else (`autonomy:*` rule
deciders, `inherit:*` inherited approvals, `system`, unknown labels) →
`service`. This fixed a production bug where 194 `autonomy:*` rows were
recorded as human (authority-ledger-and-outbox.test.ts L49-L62).

The outbox event side is no longer best-effort: `enqueueApprovalEvent()` calls
**`enqueueRequiredEvent()`**, which throws unless invoked inside the state-
change transaction — so a committed domain row always has its outbox row
(event-outbox-service.ts L37-L41). The insert is a no-op while
`EVENT_PUBLISH_ENABLED` is not `true` (no event promised). A
`EventOutboxService` drain then publishes pending/failed rows to
`DJIMIT_EVENT_BUS_URL` with optional bearer token, retrying up to 10 attempts
(60 s default interval) so a bus outage delays but never loses or blocks the
action (event-outbox-service.ts L56-L113).

## Operator surfaces

<!-- openwiki: mermaid parse failed and this diagram was converted to a text fence so it does not break rendering. Fix the diagram source and restore the mermaid fence. Parser error: Parse error on line 17: ...t or one-tap buttons Op->>Eng: PATCH Expecting '()', 'SOLID_OPEN_ARROW', 'DOTTED_OPEN_ARROW', 'SOLID_ARROW', 'SOLID_ARROW_TOP', 'SOLID_ARROW_BOTTOM', 'STICK_ARROW_TOP', 'STICK_ARROW_BOTTOM', 'SOLID_ARROW_TOP_DOTTED', 'SOLID_ARROW_BOTTOM_DOTTED', 'STICK_ARROW_TOP_DOTTED', 'STICK_ARROW_BOTTOM_DOTTED', 'SOLID_ARROW_TOP_REVERSE', 'SOLID_ARROW_BOTTOM_REVERSE', 'STICK_ARROW_TO -->
```text
sequenceDiagram
    autonumber
    participant Src as Gate or operator (engine or POST /approvals)
    participant Svc as ApprovalService
    participant DB as SQLite approvals and audit_events
    participant OB as event_outbox (in-transaction)
    participant WSB as WebSocketService
    participant LED as authority_events
    participant Op as Dashboard or Telegram approver
    participant Eng as ExecutionEngine

    Src->>Svc: createApproval(task, assessment, requestedBy)
    Svc->>DB: transaction insert row plus approval.requested audit
    Svc->>OB: enqueueRequiredEvent djimitflo.approval.requested
    Svc->>WSB: broadcast approval.requested (post-commit)
    Svc->>LED: recordDecision HOLD (post-commit)
    Note over Op: dashboards poll or subscribe; Telegram push delay then /approve /reject or one-tap buttons
    Op->>Eng: PATCH /approvals/:id or POST /:id/approve or deny
    Eng->>Svc: decideApproval(id, approved, decidedBy, reason)
    Svc->>DB: transaction CAS status update plus decided_by plus audit
    Svc->>OB: enqueueRequiredEvent djimitflo.approval.approved/denied
    Svc->>WSB: broadcast granted or denied or expired (post-commit)
    Svc->>LED: recordDecision ALLOW or DENY (post-commit)
    alt approval is manual_action
        Eng-->>Op: evidence captured, no dispatch
    else approved
        Eng->>Eng: re-enter executeTask full preflight
    else denied
        Eng->>DB: task cancelled, evidence captured
    end
```

*Ledger/outbox: the outbox event is committed inside the state-change
transaction; the WebSocket broadcast and authority-ledger record are strictly
post-commit.*

### REST

The router (packages/server/src/routes/approvals.ts) exposes:

- `GET /api/approvals` and `GET /api/approvals/:id` — list/detail. Non-privileged
  users are filtered through `AuthorizationService.getApprovalTaskVisibilityWhere`
  and `canAccessApprovalTask`, so `checker`/`viewer` roles get an empty queue
  and a 404 on a row they cannot read (L102-L158; HTTP-verified in
  approvals-http.test.ts L73-L82).
- `POST /api/approvals` — manual-action review creation (`create:task`,
  L37-L63, noted above).
- `PATCH /api/approvals/:id`, `POST /api/approvals/:id/approve`,
  `POST /api/approvals/:id/deny` — decision endpoints gated by
  `requirePermission('approve:task')`. All three forward to
  `ExecutionEngine.handleApprovalDecision`, taking `decidedBy` from the JWT
  subject. `sendDecisionError` maps: `INVALID_APPROVAL_DECISION` → 400,
  `SELF_APPROVAL_FORBIDDEN` → 409, `APPROVAL_EXPIRED` → 410, and `Approval
  already processed` → 409 (L74-L88, L161-L258).
- `POST /api/approvals/:id/cancel` — `pending → expired` write (L261-L286),
  gated by `requirePermission('approve:task')`. A second attempt returns 409
  (`APPROVAL_ALREADY_PROCESSED`); the cancel is attributed in the audit trail
  as an `approval.expired` event with `action: approval_cancelled` (F4), so a
  cancel is recorded as a decision too.

The role/visibility matrix is pinned by
packages/server/src/__tests__/approvals-http.test.ts: every role can list, but
only admin/approver-style roles clear `approve:task`, and a viewer cannot even
*read* another task's approval. Responses are enriched with
`approvalContext()` — goal, proposal, worker runtime, and a prompt preview when
the task belongs to an autonomous loop run (approval-context.ts L20-L43) — so a
loop-worker approval no longer looks identical to any other task.

### Dashboard

Two React surfaces sit on the same REST API:

- **`usePendingApprovals`** (packages/dashboard/src/hooks/usePendingApprovals.ts)
  powers the app-shell badge, banner, and tab title. It polls
  `getAllApprovals('pending')` every 30 s, filters out rows whose
  `expires_at` is already past client-side, and refreshes immediately whenever
  any card fires the `APPROVALS_CHANGED` window event. `Layout` renders
  `PendingApprovalsBanner` (with an "expires in N min" urgency switch at 15
  minutes) on every page **except `/decisions`** (the inbox that now hosts the
  queue), and shows the pending count as a badge on the `/decisions` nav item
  (Layout.tsx L190, L240).
- **`ApprovalQueuePage`** (packages/dashboard/src/pages/ApprovalQueuePage.tsx)
  is embedded as the first section of the Decisions inbox
  (`/decisions#approvals`; `/approvals` redirects there, App.tsx L109, L119).
  It has status tabs (pending/approved/denied/all), a request-id guard so a
  slower tab response cannot clobber a newer one, and subscriptions to all four
  approval WebSocket events that re-run the current tab's query. Each row
  renders an `ApprovalCard`, which shows risk/status, the `approval.context`
  block, an expiry countdown, and Approve/Deny buttons for `pending` only.
  Buttons are gated by `useCan('approve:task')`; deny opens a reason-picker
  dialog (a fixed reason plus optional details, not a bare prompt), and a
  decision dispatches `APPROVALS_CHANGED`.

### Telegram

Telegram is an authenticated API client, not another task/approval writer
(`TelegramApiService` header,
packages/server/src/services/telegram-api-service.ts L4-L11). It posts
decisions against the same internal API:

- `TelegramApiService.request()` resolves the mapped DjimFlo user, mints a
  short-lived JWT for that user, and calls a loopback-only internal API — the
  constructor throws `TELEGRAM_API_MUST_BE_LOCAL` for any remote URL
  (L5-L33). `requireActor()` refuses disabled/unlinked users and enforces
  permissions like `create:task` server-side.
- `TelegramBotService` offers a text path (`handleApprove`/`handleReject`,
  `/approve <id>` and `/reject <id>` → `POST /approvals/:id/approve` and
  `/deny`, L477-L510) and an inline one-tap button flow (`handleCallback`,
  L258-L298). Buttons are authorised via `mayApproveViaTelegram()` — the
  `telegram_identities` (D3) mapping of the Telegram account to an active user
  whose role holds `approve:task`; the decision itself goes through the normal
  approval API as that user, so `SELF_APPROVAL_FORBIDDEN` and every other
  server rule still apply. A second tap after a lane rule auto-approves renders
  "Already decided by ..." (`APPROVAL_ALREADY_PROCESSED`), and a self-approve
  is rendered as "you cannot approve your own request".
- The webhook route validates the `X-Telegram-Bot-Api-Secret-Token` before
  touching the bot (routes/telegram.ts L89-L100).

The end-to-end chain is exercised by
packages/server/src/__tests__/telegram-api-chain.test.ts: webhook →
authenticated local API → task create → engine `executeTask` →
`awaiting_approval` → Telegram `/approve` persists `decided_by` and the task
runs to completion, while a self-`/approve` from the maker and an `/approve`
from a `viewer` are both refused. The standalone gateway
(packages/telegram/src/index.ts) delegates all state mutation back through the
same ops interface; it never writes approvals directly.

## Invariants and failure semantics

- **Atomic create/decide.** Status, audit, and (on expiry) the task cancel and
  the outbox row live or roll back together; a competing decider on another
  connection sees either `database is locked` during the write or the
  already-committed result (approval-atomicity.test.ts L135-L160).
- **No self-approval, ever.** `requested_by` vs `decided_by` is enforced in the
  service, so a permission-table oversight or a stolen admin token still cannot
  make the maker the approver.
- **Expiry is a denial.** Both realizations write `approval_expired` audit,
  broadcast `approval.expired`, and record `EXECUTION_APPROVAL_EXPIRED` +
  `DENY` in the ledger — and the task does not linger in `awaiting_approval`.
- **Broadcast and authority ledger are best-effort; records are canonical.** The
  committed row + audit chain + outbox are the authority; a disconnected socket
  or a missing `authority_events` table only costs a log line / a `null`.
- **Mutation-tested.** The `decideApproval` guard block
  (approval-service.ts L122-L145) and ToolBroker's capability-token validation
  are Stryker targets in stryker.config.js L5-L13, alongside the
  runtime-governance score bounds — see
  [Test Strategy](/openwiki/testing/test-strategy.md). The atomicity,
  outbox-atomicity, and `manual-approvals.test.ts` suites keep the expiry,
  event, and manual-action semantics honest.

## Related pages

- [Governance Pipeline](/openwiki/concepts/governance-pipeline.md) — how
  risk/policy/gate evaluation decides *that* an approval is required and how a
  granted start is rebound to the input hash.
- [Roles & Permissions](/openwiki/concepts/roles-and-permissions.md) — the
  `approve:task` gate and task-visibility filters every surface above relies on.
- [Telegram Bot](/openwiki/integrations/telegram-bot.md) — the webhook,
  identity mapping, and push channel detailed.
- [Test Strategy](/openwiki/testing/test-strategy.md) — where the atomicity,
  HTTP contract, and mutation-gate suites fit in `npm test`.
