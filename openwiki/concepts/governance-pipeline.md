---
type: security-architecture
title: "Governance Pipeline: Policy, ToolBroker, Approvals & Audit Chain"
description: The pre-execution governance spine of Djimitflo's server — how CommandRiskClassifier, PolicyDecisionService, GovernanceGateService, ToolBroker, and ApprovalService order and bind every task dispatch, and how AuditService/ComplianceAuditService hash-chain the evidence.
tags: [governance, policy, approvals, audit-chain, risk-classification, tool-broker, capability-tokens, compliance, separation-of-duties]
sources:
  - id: openwiki-source-cd524ffa0394e6f0b9d7b1d5
    resource: repo://packages/server/src/__tests__/approval-atomicity.test.ts
  - id: openwiki-source-9287baaf5ea380972e0a1e6e
    resource: repo://packages/server/src/__tests__/approval-ttl.test.ts
  - id: openwiki-source-5d8407f289bf3dac6575e4bf
    resource: repo://packages/server/src/__tests__/event-outbox-atomicity.test.ts
  - id: openwiki-source-5256266ed42b742b60f7fe45
    resource: repo://packages/server/src/__tests__/execution-approval-binding.test.ts
  - id: openwiki-source-289072797fee700b24a8a1d3
    resource: repo://packages/server/src/bootstrap/autonomous-services.ts
  - id: openwiki-source-d77928939568025601f76bb2
    resource: repo://packages/server/src/execution/execution-engine.ts
  - id: openwiki-source-c6ff9a9bb5a3e771103ed6e5
    resource: repo://packages/server/src/routes/approvals.ts
  - id: openwiki-source-fb188ee3df500e339b426861
    resource: repo://packages/server/src/services/approval-service.ts
  - id: openwiki-source-6f07fd3ee9d91a2533fab263
    resource: repo://packages/server/src/services/audit-service.ts
  - id: openwiki-source-c6dea3219b2706b35a322348
    resource: repo://packages/server/src/services/authority-ledger-service.ts
  - id: openwiki-source-c50e8044b190950d062a33f3
    resource: repo://packages/server/src/services/command-risk-classifier.ts
  - id: openwiki-source-e1fac1d43de60c6a93d86d47
    resource: repo://packages/server/src/services/compliance-audit-service.ts
  - id: openwiki-source-3520db2e41877a293398e0b2
    resource: repo://packages/server/src/services/event-outbox-service.ts
  - id: openwiki-source-09d2f957ee33fa23e9f7bfea
    resource: repo://packages/server/src/services/governance-gate-service.ts
  - id: openwiki-source-b41b1f9d7b7eb2a10d1be6cd
    resource: repo://packages/server/src/services/policy-decision-service.ts
  - id: openwiki-source-305e9b5205c7ac7f361f73bb
    resource: repo://packages/server/src/services/redos-guard.ts
  - id: openwiki-source-79e38068daabb6567e2c465d
    resource: repo://packages/server/src/services/runtime-governance-service.ts
  - id: openwiki-source-39bff2b9dbe3e565ff3d8077
    resource: repo://packages/server/src/services/tool-broker.ts
generated: { by: "openwiki/0.5.2", at: "2026-11-07T14:47:55.436Z" }
verified:
  - by: openwiki/0.5.2
    at: 2026-11-07T14:47:55.436Z
---

# Governance Pipeline: Policy, ToolBroker, Approvals & Audit Chain

Every task dispatch in `packages/server` passes through the same governance spine
before an executor is allowed to start. The spine runs inside
`ExecutionEngine.executeTask()`
(packages/server/src/execution/execution-engine.ts) and composes five services:

1. **CommandRiskClassifier** — turns task text or an explicit shell command into a
   `RiskAssessment` (risk level + recommended decision).
2. **PolicyDecisionService** — evaluates enabled rows of `approval_policies` against
   that assessment, honoring blocked-tool lists and ReDoS-guarded match patterns.
3. **GovernanceGateService** — an optional, env-armed layer that can only *tighten*
   an `allow` to `require_approval` when the executing agent's OpenMythos benchmark
   score is below a floor. It never loosens.
4. **ToolBroker** — per-tool-call default-deny evaluation issuing durable, scoped
   capability tokens; currently an opt-in boundary for callers that mediate tool
   calls explicitly, not something CLI executors enforce internally.
5. **ApprovalService** — the approval lifecycle (configurable TTL defaulting to 1
   hour, transaction-wrapped create/decide, data-layer self-approval ban) plus the
   outbox/ledger side records.

Every meaningful transition in the pipeline — requested, granted, denied, expired —
is appended to the hash-chained `audit_events` log through the AuditService façade
over ComplianceAuditService, mirrored best-effort into the append-only
`authority_events` ledger, and — when `EVENT_PUBLISH_ENABLED=true` — promised as a
`djimitflo.approval.*` row in `event_outbox` that an `EventOutboxService` drain
delivers to the external Djimit event bus.

## Preflight order in executeTask

`executeTask()` consults the pipeline in a fixed order, and the order itself is a
security property: cheap structural holds run before any policy work, and every gate
failure is persisted as an event and/or audit row before the method returns or throws.

```mermaid
sequenceDiagram
    autonumber
    participant C as Caller (route or re-dispatch)
    participant E as ExecutionEngine
    participant R as RuntimeGovernanceService
    participant K as CommandRiskClassifier
    participant P as PolicyDecisionService
    participant G as GovernanceGateService
    participant A as ApprovalService
    participant D as AuditService to ComplianceAuditService

    C->>E: executeTask(taskId, executorKind, dispatcherId)
    E->>E: in-memory and durable duplicate or running guards
    E->>E: recovery-hold and assurance-hold metadata checks
    E->>A: getLatestPendingForTask(executionOnly)
    A-->>E: pending execution approval or null
    E->>R: isAllowed(agent_id)
    alt agent quarantined or circuit-broken
        E-->>C: denied, task cancelled
    end
    E->>E: loop-pause, agent-availability, skill-attribution, runtime-admission checks
    E->>K: assessTask(task, executorKind)
    K-->>E: RiskAssessment
    E->>P: evaluate(assessment)
    P-->>E: decision from approval_policies or classifier fallback
    E->>G: assess(task, executorKind)
    G-->>E: allow or require_approval
    Note over E: gate may tighten allow to require_approval, never loosen
    alt decision is deny
        E->>D: record EXECUTION_DENIED
        E-->>C: denied, task cancelled
    else decision is require_approval and no bound approved grant
        E->>A: createApproval (APPROVAL_TTL_MS expiry, input hash bound)
        A->>D: record APPROVAL_REQUESTED audit plus required outbox event in transaction
        A-->>C: WebSocket approval broadcast, push, and authority-ledger record
        E-->>C: awaiting_approval with approvalId
    else allow or approved
        E-->>C: queued, then revalidated admission after capacity wait
    end
```

*The decision flow every task dispatch traverses; the same pipeline re-runs verbatim
after any concurrency-capacity wait and on every fallback-executor admission.*

Concretely, inside `executeTask()`:

1. **Duplicate/running guards** — in-memory `activeSessions`/`pendingExecutions` and a
   durable `running` status check (packages/server/src/execution/execution-engine.ts#L277-L288).
2. **Recovery-hold checks** — `metadata.execution_recovery_hold === true` set by
   startup reconciliation throws `EXECUTION_RECOVERY_REQUIRED` (L300-L302), and
   `metadata.deep_agent_assurance_hold === true` throws `DEEP_AGENT_ASSURANCE_HOLD`
   (L304-L306).
3. **Pending approval check** — `approvalService.getLatestPendingForTask(taskId,
   { executionOnly: true })` throws "Task is awaiting approval" if an execution-gate
   approval is pending (L308-L311).
4. **Runtime-governance allow check** — a quarantined or circuit-breaker-tripped
   agent (`runtimeGovernance.isAllowed`) cancels the task and returns `denied`
   (L313-L324; packages/server/src/services/runtime-governance-service.ts#L138-L141).
5. **Structural admission checks** — `assertTaskLoopNotPaused` throws
   `LOOP_OPERATOR_PAUSED` when the task's owning loop run or goal is paused by its
   operator (L326), `assertAssignedAgentAvailable` throws `AGENT_UNAVAILABLE` for a
   missing, retired, non-idle, or newly quarantined assigned agent (L327),
   `blockInvalidSkillAttribution` cancels and returns `denied` on an invalid or
   ambiguous skill attribution (L329-L332), and `admitRuntime` denies with
   `RUNTIME_NOT_ADMITTED` when the runtime@version has no admission record
   (L341-L343; runtime admission itself is only enforced at this layer — see
   `admitRuntime` at L866-L887, with `RUNTIME_ADMISSION_MODE=shadow` as the
   record-but-allow rollback).
6. **Risk classification** — `riskClassifier.assessTask(parsedTask, executorKind,
   process.cwd(), riskAssessmentText)` (L350), persisted to `risk_assessments` and
   broadcast as `RISK_DETECTED` by `persistRiskAssessment` (L352, L1690-L1718).
7. **Policy evaluation** — `policyDecisionService.evaluate(assessment)` (L351);
   without a matching policy the classifier's `recommended_decision` is the fallback.
8. **Gate tightening** — `governanceGate.assess(...)`; on `require_approval` with a
   current `allow`, the decision is replaced and POLICY_DECISION evidence captured
   (L355-L374).
9. **Outcomes** — `deny` cancels the task, captures POLICY_DECISION evidence,
   records `EXECUTION_DENIED`, and returns `denied` (L376-L409);
   `require_approval` without a valid grant creates the approval, moves the task to
   `awaiting_approval`, broadcasts `EXECUTION_PAUSED_FOR_APPROVAL`, and records
   `EXECUTION_PAUSED` (L411-L454); otherwise the task is queued (L458).

Admission is revalidated end-to-end after the `runtimeConcurrencySemaphore` capacity
wait (L500-L548): the task must still be `QUEUED`, its input hash must be unchanged,
and risk classification, policy evaluation, and gate assessment run again — a
tighter decision after the wait aborts with `EXECUTION_POLICY_DENIED` /
`EXECUTION_APPROVAL_STALE` rather than dispatching on stale authority.
`fallbackAdmitted()` (L889-L895) applies the same classify → evaluate →
approved-grant test to every fallback executor.

## Stage 1 — CommandRiskClassifier

`CommandRiskClassifier` (packages/server/src/services/command-risk-classifier.ts) is a
pure, stateless pattern-based classifier.

- `classify(command)` screens raw commands against ordered regex tiers: critical
  patterns (e.g. `~/.ssh`, `rm -rf /`, `DROP TABLE`, pipe-to-shell, crypto/ransomware
  markers) recommend `deny`; a redirect writing outside the configured workspace is
  also `deny`; high-tier mutation patterns (`rm`, `chmod`, `sudo`, `git reset
  --hard`, docker-socket curls) and medium-tier patterns recommend
  `require_approval`; low-tier read-only patterns (`pwd`, `ls`, `git status`,
  test/lint/typecheck) recommend `allow` (L9-L76).
- **Unknown commands are fail-closed:** with no pattern hit the classifier returns
  MEDIUM risk recommending `require_approval`, never `allow` (L73-L75).
- `assessTask()` starts from the task's stored risk level, bumps on sensitive
  keywords in the title/description (`delete`, `deploy`, `production`, `secret`,
  ...), treats `review_only` as low risk, raises the baseline for local opencode
  execution, and — if `task.metadata.requested_command` is present — defers entirely
  to `classify()` for that command. Any `CRITICAL` outcome forces `deny` (L78-L135).

## Stage 2 — PolicyDecisionService

`PolicyDecisionService.evaluate()`
(packages/server/src/services/policy-decision-service.ts#L25-L52) loads enabled
policies from `approval_policies` ordered by `priority DESC, created_at DESC` and
takes the **first** matching policy as the decision source. Matching checks
`action_type` (with a `tool_call` ↔ `mcp_tool_call` alias), the risk-level set, an
optional `match_pattern` compiled through `ReDoSGuard` (dangerous patterns compile to
`null` and never match), and allowed/blocked tool lists against
`assessment.metadata.tool`. A matched policy that blocks the specific tool overrides
its own decision to `deny`; with no match the result is the classifier's
`recommended_decision`.

When call-site context (`{ task, executorKind }`) is supplied, `evaluate()` also runs
its internal GovernanceGateService and folds the verdict in — again only tightening
`allow` → `require_approval` (L47-L51). The engine's own flow calls `evaluate()`
**without** context and applies the gate explicitly instead (so both paths converge
on the same semantics).

## Stage 3 — GovernanceGateService (optional, tighten-only)

`GovernanceGateService` (packages/server/src/services/governance-gate-service.ts)
is **default-off** (`GOVERNANCE_GATE_ENABLED=true` to arm) and consults
`openmythos_eval_runs` for benchmark evidence about the executing agent:

- Evidence lookup order: the task's `agent_id`, then `nightly:<model>` from
  `GOVERNANCE_GATE_MODEL_MAP` (`kind=model` pairs), then any completed run whose
  metadata `subject_model` matches (L23-L25, L108-L113).
- **No evidence → allow.** The gate only acts on measured behavior (L115-L117).
- If the latest of up to 3 recent completed runs scores below `floor()`, the verdict
  is `require_approval` with a human-readable reason; a trend over the last runs
  marks `improving`/`stable`/`declining`, and three consecutive below-floor declining
  runs set `flagRetirement` (evidence only — nothing is auto-retired) (L119-L141).
- The gate never turns `deny` or `require_approval` back into `allow`; consumers
  apply it exclusively as an `allow → require_approval` upgrade.

**Operational trap (documented in the service header):** `GOVERNANCE_GATE_FLOOR`
defaults to `3`, calibrated for a 0–5 score scale, while observed
`openmythos_eval_runs.overall_score` values in production span roughly 0–95. A
former clamp to ≤5 was removed because it made any realistic floor impossible to
configure; today `floor()` accepts any finite non-negative number and only falls back
to `3` on invalid input (L58-L66). **Set the floor explicitly (e.g. 30–40, based on
your own score distribution) when arming the gate** — with the default on a 0–95
distribution it catches only near-zero/degenerate runs. Behavior across these cases
is pinned by packages/server/src/__tests__/governance-gate.test.ts.

## Stage 4 — ToolBroker (per-tool capability boundary)

`ToolBroker` (packages/server/src/services/tool-broker.ts) governs individual tool
calls, independent of the task-level spine:

- `evaluateToolCall()` rate-limits per principal (sliding 60 s window of 100 plus a
  per-second burst of 10, throwing `RateLimitExceeded`), assesses per-tool risk from
  the data classification and tool-name heuristics, evaluates `mcp_tool_call`
  policies, and escalates to `require_approval` when the risk level meets or exceeds
  `require_approval_above_risk` (default HIGH) — only when the policy decision was
  `allow` (L184-L212).
- **Default-deny:** with no matching policy the broker's `default_decision: 'deny'`
  becomes the classifier recommendation, so unknown tools are refused.
- **Separation of duties** (maker–checker): by default, a principal with more than 5
  `allow` decisions on the same task within one hour can no longer self-allow
  further tool calls on it (L289-L299).
- On `allow` it issues a **capability token** (`cap-<uuid>`) scoped to
  `<category>:<tool>`, the task, and the principal, persisted in
  `tool_broker_capability_tokens` with a 15-minute default TTL. Every decision —
  allow, deny, or approval — is persisted to `tool_broker_decisions` with an
  immutable `dec-<uuid>` decision id (L301-L335, L367-L383).
- `validateCapabilityToken()` is checked at the effect boundary: tool, task, **and
  presenting principal** must match and the token must be unexpired (expired tokens
  are deleted), so a durable token cannot be used as a bearer token (L244-L257).
  `reevaluateOnParameterChange()` invalidates the original token and re-runs the full
  evaluation when call parameters change (L263-L274).

**What the broker does and does not mediate (header-documented):** enforcement is
strictly *pre-execution* — the broker evaluates calls and tokens but performs no
runtime syscall or process-level mediation. CLI executors do not mediate their
internal tools through the broker, so constructing it inside `ExecutionEngine` does
not enforce per-tool policy for executor-internal calls — callers that want the
boundary must call `evaluateToolCall()`/`validateCapabilityToken()` themselves.

## Stage 5 — ApprovalService lifecycle and invariants

`ApprovalService` (packages/server/src/services/approval-service.ts) owns the
`approvals` table lifecycle. Its invariants are the core of the pipeline:

- **Configurable expiry, fail-closed:** `createApproval()` stamps
  `expires_at = now + approvalTtlMs()` (L93). `APPROVAL_TTL_MS` configures the
  TTL — default 1 hour, clamped to 5 minutes … 7 days on valid input; an expired
  approval still never executes anything (L29-L32; pinned by
  packages/server/src/__tests__/approval-ttl.test.ts). Expiry is lazy — realized on
  read or on a decision attempt (below).
- **Pending-query semantics:** `getLatestPendingForTask(taskId, { executionOnly })`
  (L71-L88) first runs an **expiry sweep** — every `pending` row whose `expires_at`
  is missing or already past is moved to `expired` (with its audit row, outbox event,
  publish, and ledger record) before any read. With `executionOnly: true` it filters
  out `metadata.manual_action === true` reviews via
  `COALESCE(json_type(metadata,'$.manual_action'), 'null') != 'true'` — `json_type`
  deliberately distinguishes the server-owned boolean `true` from strings/numbers —
  applied **before** `ORDER BY created_at DESC LIMIT 1`, so a newer manual review
  cannot hide an older execution gate. The engine's pending check
  (`execution-engine.ts` L308) always passes `executionOnly: true`.
- **Transaction-wrapped create/decide (required outbox event included):**
  `createApproval()` writes the approval row, its `djimitflo.approval.requested`
  outbox event (`enqueueRequiredEvent`), and its canonical `APPROVAL_REQUESTED`
  audit entry in one `db.transaction().immediate()` (L95-L143). If the audit insert
  fails, the approval row rolls back with it (pinned by
  packages/server/src/__tests__/approval-atomicity.test.ts); because the outbox
  insert is *required*, an outbox failure also rolls back the approval — a committed
  approval always has its promised bus event (pinned by
  packages/server/src/__tests__/event-outbox-atomicity.test.ts). `decideApproval` and
  the expiry path do the same for their status UPDATE plus
  `djimitflo.approval.approved|denied|expired` event plus
  `APPROVAL_GRANTED`/`APPROVAL_DENIED`/`APPROVAL_EXPIRED` audit (L189-L251,
  L278-L317). The outbox insert is a no-op (nothing promised) unless
  `EVENT_PUBLISH_ENABLED=true`.
- **Post-commit notifications are best-effort:** only after commit does
  `createApproval()` schedule the optional Telegram push (off unless
  `TELEGRAM_PUSH_ENABLED`, delayed by `TELEGRAM_PUSH_DELAY_MS`, default 15 s), call
  `publish()` for the WebSocket `APPROVAL_REQUESTED` broadcast, and call
  `recordDecision()` (L144-L154). A failed broadcast is only `console.warn`'d, never
  a domain failure (L319-L327).
- **`decideApproval` ordering of checks:** it requires a boolean `approved` (else
  `INVALID_APPROVAL_DECISION`, thrown before the transaction, L185-L188), then inside
  its immediate transaction loads the row (404), rejects an already-`expired` row with
  `APPROVAL_EXPIRED`, rejects any non-`pending` row as "Approval already processed"
  — the double-process/double-decide guard — then realizes TTL expiry: if
  `expires_at` is missing or past, `expireApprovalRecord()` persists `expired`, its
  audit, and its outbox event **inside the same transaction**, commits, broadcasts
  `APPROVAL_EXPIRED`, records a ledger `DENY`, and only then throws
  `APPROVAL_EXPIRED` — so the refusal is durable evidence, written exactly once
  (L194-L203, L252-L261; test "persists expired decision refusal and its audit once,
  outside the throwing transaction"). Only a still-pending, unexpired row reaches the
  decision UPDATE.
- **Self-approval is forbidden at the data layer:** `decideApproval` throws
  `SELF_APPROVAL_FORBIDDEN` when `decidedBy === approval.requested_by`, independent
  of any route-level permission check (L204-L209). Status transitions to `approved`
  or `denied` set `decided_at`/`decided_by`/`decision_reason` (and
  `approved_at`/`denied_at`/`denial_reason`) via a guarded
  `WHERE id = ? AND status = 'pending'` update (L210-L236).
- **Expired approvals unstick their tasks:** realizing expiry cancels a task still
  in `awaiting_approval` (guarded, so a task that moved on is untouched), with its
  own `task_cancelled_after_approval_expiry` audit row — mirroring what a denial does
  (L278-L317).
- **`manual_action` approvals never gate execution:** approvals created via
  `POST /api/approvals` for human action review carry `metadata.manual_action: true`
  (packages/server/src/routes/approvals.ts#L37-L63). Besides the `executionOnly`
  filter above, `handleApprovalDecision` records their decision as evidence and
  returns without dispatching (execution-engine.ts L916-L927), and `hasApprovedStart`
  applies the same `json_type(...) != 'true'` exclusion (L1741).

Every lifecycle step also calls `recordDecision()` (L154, L259, L262, L275), which
appends a **best-effort, never-blocking, post-commit** event to the append-only
`authority_events` ledger (sequenced per `correlationId` = task id, with a sha-256
payload digest, swallowing failures and returning `null` on error;
packages/server/src/services/authority-ledger-service.ts#L1-L42). Unlike the ledger,
the `event_outbox` mirror is part of the domain transaction (above):
`enqueueRequiredEvent` throws `REQUIRED_EVENT_OUTSIDE_TRANSACTION` when called
outside a transaction and throws any insert failure so the state change rolls back
(packages/server/src/services/event-outbox-service.ts#L33-L41). The rows are drained
by `EventOutboxService.publishPending()` — compare-and-set claims, retry up to 10
attempts, stable `dedupe_key = djimitflo:<event_id>` so the bus dedupes retries —
POSTed to `${DJIMIT_EVENT_BUS_URL}/events/${DJIMIT_EVENT_STREAM}` (L75-L113); the
drain is started in bootstrap only when publishing is armed
(packages/server/src/bootstrap/autonomous-services.ts#L131-L142).

### Approvals are bound to the exact execution input

An approval is not a reusable grant. `ExecutionEngine.hasApprovedStart()`
(execution-engine.ts L1735-L1749) only honors an approval for the same `executorKind`
whose `expires_at` is still in the future, whose metadata is **not** a manual action,
and whose stored `executionInputHash` equals a fresh hash of the task's dispatch
relevant bytes (title, description, priority, risk, mode, agent, repository,
instruction profile, tags, instructive metadata; runtime output/recovery stamps
excluded, L1720-L1733). Any task edit, expiry, or executor-kind change forces a new
approval — pinned by
packages/server/src/__tests__/execution-approval-binding.test.ts. An opt-in escape,
`LOOP_REVIEWER_APPROVAL_INHERIT=true`, lets read-only checker/security-checker tasks
inherit their loop run's human-approved maker approval under strict conditions
(`reviewerInheritsRunApproval`, L1759-L1791). After a granted approval,
`handleApprovalDecision` resumes by re-entering `executeTask()`, where the full
preflight runs again (L987-L988).

## Two-layer audit: AuditService façade over a hash-chained canonical log

Auditing has two layers with a single physical store:

- **AuditService** (packages/server/src/services/audit-service.ts) is the façade all
  the services above call. `record()` maps the rich `AuditEventCreateInput` shape
  onto a canonical `ComplianceAuditService.appendEntry()` call, deriving `outcome`
  from the event type (`denied`/`violation` → denied, `failed`/`error` → failure,
  else success) and defaulting actor to `system` (L12-L35). Its `query()` reads the
  same `audit_events` table for the API.
- **ComplianceAuditService** (packages/server/src/services/compliance-audit-service.ts)
  is the canonical writer. `appendEntry()` chains every entry to its predecessor:
  `previousHash` is the hash of the latest entry (or `'genesis'`), `hash` is a
  sha-256 over canonical JSON with deeply sorted keys, and `chain_sequence` is
  `MAX+1` (L54-L127). SQLite triggers make the underlying `audit_events` table and
  the `compliance_audit_log` compatibility view append-only — UPDATE/DELETE raise an
  error — while an `INSTEAD OF INSERT` trigger on the view keeps legacy writers
  appending (L553-L601). `verifyChain()` replays the chain in sequence order,
  checking both linkage and recomputed hashes (L132-L164), and `generateReport()`
  folds chain integrity, governance-certification coverage (reusing the armed gate
  floor), human-approval coverage, and runtime-governance status into
  NORA/SOC2/ISO27001 reports stored in `compliance_reports`.

## Failure semantics at a glance

- Fail-closed defaults: unknown commands classify MEDIUM/require_approval; unknown
  tools default to `deny`; no gate evidence means allow but never loosens policy;
  expired approvals count as `DENY` in the ledger.
- Durable-before-notify: approval, outbox, and audit state commit in one transaction;
  broadcasts, Telegram push, and ledger writes are post-commit and best-effort.
- Freshness is enforced, not assumed: approval grants are bound to an input hash and
  a 1-hour expiry, and the whole classify → policy → gate pipeline re-runs after any
  capacity wait before a provider process starts.
- Enforcement boundary: the pipeline (risk → policy → gate → approval) runs before
  any executor process starts; it does not mediate runtime behavior of a launched
  CLI, and ToolBroker's capability tokens only guard callers that opt in.

## Related pages

- [Roles & Permissions](/openwiki/concepts/roles-and-permissions.md) — who may call
  the approval decision routes (`approve:task`), task visibility filters, and the
  role/governance model this pipeline's checks sit on top of.
- [Approval Decision Flow](/openwiki/workflows/approval-decision-flow.md) — the
  human-facing approve/deny UX on top of `handleApprovalDecision`.
- [Data Model](/openwiki/architecture/data-model.md) — the `approvals`,
  `audit_events`, `authority_events`, `event_outbox`, and
  `tool_broker_capability_tokens` tables this pipeline writes.
- [Test Strategy](/openwiki/testing/test-strategy.md) — where the atomicity, TTL,
  outbox, and approval-binding pins referenced above live in the test suite.
