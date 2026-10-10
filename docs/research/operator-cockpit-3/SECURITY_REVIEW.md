# Operator Cockpit 3.0 — security review

Review by B4 on 22f7fcf7 (= prod), tests in #740; fixes in #743 (merged 4d4f8b2a, deployed da864adf). Auth behaviour was **not** widened or narrowed except F6 (masking for viewers, operator-approved 10-10).

## Fix status

| # | Finding | Resolution | Status |
|---|---|---|---|
| F1 | approval audit names `system` | approver user id passed to audit | I T D |
| F2 | fleet root shell: requester may approve own command | **not blocked** (single operator, operator decision 10-10); audited `self_approved=true`, shown on /fleet | I T D (by design) |
| F3 | PATCH approved:'false' approves | false positive — decideApproval already 400s on non-boolean; guard test kept | T |
| F4 | approval cancel unaudited | audit event with actor | I T D |
| F5 | memory promote/reject only in mutable metadata | audit events with session user; promoted_by = session user | I T D |
| F6 | viewers see Telegram email/role | masked without manage:config (ids stay) | I T D |
| F7 | webhook secret `!==` | open (info) | NP |
| F8 | no per-router limiter on self-improve/swarms/telegram/fleet (global 300/min) | open (info) | — |
| K1 | POST /api/federation/register login-only | **open — operator decision** | — |
| K2 | GET /api/approvals login-only | mitigated by per-role row filter | — |

Read-only cockpit changes (#738, #739, #741, #742, #749, #750) add no mutation endpoint; #739's /schedulers and
/evolution-evidence stay manage:config. Production validation of authz = none beyond CI (no prod probe with a viewer token).


Base: origin/main 22f7fcf7 (= prod). Read-only review; no auth behaviour changed. Tests:
`packages/server/src/__tests__/cockpit-decisions-authz.test.ts` (4 pass, 2 `it.fails` documenting gaps).

Roles (packages/shared/src/types/auth.ts:15): viewer = read:evidence, read:repository; auditor + read:audit; checker + scan,
write:evidence; maker + create/execute task, write:claim/swarm_action/…; approver = approve:task, create:task, read:*;
platform_admin = manage:config/users/backups/policies/tokens, read:*; admin = all.
Mounting (routes/index.ts): /self-improve, /approvals, /swarms, /fleet, /fleet-hosts, /federation behind requireAuth;
/health, /host-agent, /telegram mount without it and authenticate per route. Global /api limiter 300/min; per-router 600/min
limiters only on health, approvals, host-agent (self-improve, swarms, telegram, fleet rely on the global one).

## Route table

| Method | Path | Permission | Mutates | Audit | Rate limit |
|---|---|---|---|---|---|
| GET | /api/health | none | no | — | router 600/min |
| GET | /api/health/{cockpit,stalls,attribution,digest,knowledge,runtimes,scorecards,forecasts,forecasts-v2,efficiency,shipped-code,services,metrics,deep} | read:evidence | no (verified: backing services contain no writes on the GET path) | — | router |
| GET | /api/health/{schedulers,evolution-evidence,config} | manage:config | no | — | router |
| GET | /api/self-improve/decisions | read:evidence | no | — | global |
| POST | /api/self-improve/proposals/:id/approve | write:governance | yes | proposal row (approved_by = session) | global |
| POST | …/proposals/:id/requeue | write:governance | yes (new linked proposal) | requeue-of link + actor in evidence | global |
| POST | …/proposals/:id/requeue-dismiss | write:governance | yes | `requeue_dismiss` judgment, actor = session | global |
| POST | …/proposals/:id/prescreen-label | write:governance | yes | `operator_label` judgment, actor = session | global |
| POST | …/attribution-audit/:runId | write:governance | yes | `attribution_audit` operator_label, actor = session | global |
| PUT/DELETE | …/telegram-identities/:id | manage:config | yes | `telegram_access` judgment, actor = session | global |
| POST | /api/swarms/memory/candidates/:id/promote | approve:task | yes (+ OKF file) | candidate metadata.promoted_by only | global |
| POST | /api/swarms/memory/candidates/:id/reject | approve:task | yes | candidate metadata.rejected_by (session) | global |
| GET | /api/approvals, /:id | login only; rows filtered by canAccessApprovalTask (viewer/checker see none) | no | — | router |
| POST/PATCH | /api/approvals/:id/{approve,deny}, PATCH /:id | approve:task | yes | approvals.decided_by = session; audit_events row (actor 'system', see F1) | router |
| POST | /api/approvals/:id/cancel | approve:task | yes (→ expired) | none (F4) | router |
| GET | /api/fleet-hosts | read:evidence | no | — | router |
| POST | /api/fleet-hosts/commands | manage:config | yes (queues root shell, pending approval) | fleet_commands.requested_by | router |
| POST | /api/fleet-hosts/commands/:id/{approve,deny} | approve:task (+ sha256 of the text) | yes | fleet_commands.approved_by | router |
| POST | /api/host-agent/{poll,commands/:id/result,shadow/*} | host token (scope host-agent) | yes | fleet_commands / fleet_hosts | router |
| POST | /api/telegram/webhook | X-Telegram-Bot-Api-Secret-Token | via mapped user (D3) | `telegram_access` judgments + same web routes as the mapped user | global |
| GET | /api/telegram/status | login only | no | — | global |
| POST | /api/federation/register | login only (known gap, verified) | yes | — | global |

## Original findings (B4, pre-fix)

**Scenario 9 holds.** viewer / auditor / checker / maker get 403 on all 16 decision endpoints (requeue, dismiss, label,
proposal approve, attribution audit, telegram identity, memory promote/reject, approval approve/deny/patch/cancel, fleet
approve/deny/request); no judgment, proposal, audit_event, approval, memory or fleet row changes. Authorized paths take the
actor from the session; body fields (`actor`, `decided_by`, `rejected_by`) are ignored (tested). No GET in scope writes.
Telegram callbacks re-check the D3 allowlist + role permission per action and run through the same web routes as the
mapped user (services/telegram-bot-service.ts:247–257, telegram-identity.ts:38–49).

| # | Severity | Finding | Where | Decision |
|---|---|---|---|---|
| F1 | Medium (audit integrity) | approval_granted / approval_denied audit_events rows name `system`, not the approver: decideApproval calls auditService.record without user_id; AuditService falls back to 'system'. The approver lives only in the mutable approvals row, so the hash-chained trail cannot attribute a human approval. `it.fails` test | services/approval-service.ts:230–239, services/audit-service.ts:16 | operator: pass `user_id: decidedBy` (audit content change, low risk) |
| F2 | Medium (separation of duties) | Fleet root shell: the requester can approve their own command; FleetCommands.approve never compares approver with requested_by (approvals have SELF_APPROVAL_FORBIDDEN). Admin holds both manage:config and approve:task. With one operator this is by design today; with a second admin it is a 1-person root path. `it.fails` test | services/fleet-commands.ts:39–48 | operator (auth change) |
| F3 | Low (input validation) | PATCH /api/approvals/:id takes `approved` unvalidated: `{ "approved": "false" }` is truthy → approves | routes/approvals.ts:162,180 | fix: require boolean (z.boolean) — validation, not an auth change |
| F4 | Low (audit) | POST /api/approvals/:id/cancel sets status expired with no audit_events row and no actor | routes/approvals.ts:265–275 | add record() with user_id |
| F5 | Low (audit) | Memory promote/reject are recorded only in memory_candidates.metadata (mutable), not audit_events; promote without `human_approved: true` stores promoted_by 'system' although a session user exists | routes/swarm-governance.ts:193–201, services/memory-candidate-service.ts:204 | always pass the session actor; audit row |
| F6 | Low (personal data) | GET /api/self-improve/decisions (read:evidence = viewer) returns telegram_identities with user email + role and memory candidate content | services/decisions-inbox.ts:47–48 | consider manage:config for the telegram block |
| F7 | Info | Telegram webhook secret compared with `!==` (not constant-time); Telegram is the only caller, secret is random 32 B | routes/telegram.ts:100 | crypto.timingSafeEqual when touched |
| F8 | Info | self-improve, swarms, telegram, fleet have no per-router limiter (global /api 300/min applies) | routes/index.ts | none |
| K1 | Known, verified | POST /api/federation/register needs only login (any viewer can register a peer) | routes/index.ts:170, routes/federation.ts | operator (open) |
| K2 | Known, verified — mitigated | GET /api/approvals needs only login, but rows are filtered per role (viewer/checker get an empty list; approvals-http.test.ts) | routes/approvals.ts:101 | no action |

## Residual risks
- One human operator holds admin: every separation-of-duties control (F2, U1 earned autonomy, D5 labels) degrades to
  one person; the audit trail (F1/F4/F5) is the only after-the-fact control and is incomplete.
- Host-agent tokens (365 d, scope host-agent) can poll and post results for their host; shell needs a human sha-bound
  approval within 15 min. Token revocation path not reviewed here.
- Secrets in fleet command output are redacted with prepareState before storage (fleet-commands.ts:76); viewers can read
  command text and output via GET /api/fleet-hosts.
- Not covered: OAuth/OIDC (none in use — local JWT), token audience/scopes on user JWTs, prompt injection into makers.

## Supply chain (this batch)
- CVE-2026-78669 (gh, golang.org/x/net http2 SETTINGS DoS) ignored in .trivyignore (#744) with the #717 justification: gh is
  a short-lived HTTPS client to api.github.com, never an HTTP/2 server; revisit when cli/cli ships x/net ≥ 0.60 / Go ≥ 1.27.2.
- Not reviewed: OAuth/OIDC (not in use), user-JWT audience/scopes, prompt-injection resistance of makers, host-agent token revocation.
