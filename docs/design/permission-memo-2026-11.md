# Permission memo (UX-4b / UXE-11), 2026-11

Stage: **memo**. No code changes come from this file. Every proposal below needs the operator's answer first (program
§4.6, §9 "Authority"). Each one then ships as its own PR. All `file:line` references point at `origin/main` `ea65fd07`.
Paths are relative to `packages/`. Production role counts, user lists and flag values are unknown here (R10), so this
memo does not fill them in.

## 1. Current role × permission matrix

Source: `shared/src/types/auth.ts:15-83`. Server checks (`server/src/middleware/auth.ts:55-72`) and dashboard gating
(`dashboard/src/lib/auth-store.ts:235-238`) both read this constant. A JWT carries only the role
(`shared/src/types/auth.ts:104-112`), and `requireAuth` re-reads the role from the user row on every request
(`server/src/middleware/auth.ts:41-47`). A change to this matrix therefore takes effect at the next deploy without
reissuing tokens. A revert takes effect the same way.

| Permission | ADMIN | PLATFORM_ADMIN | APPROVER | MAKER | CHECKER | AUDITOR | VIEWER | Mutating routes needing it |
|---|---|---|---|---|---|---|---|---|
| `read:evidence` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 12 |
| `read:repository` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 1 |
| `read:audit` | ✓ | ✓ | | | | ✓ | | 1 |
| `create:task` | ✓ | | ✓ | ✓ | | | | 32 (+2 with `execute:task`) |
| `execute:task` | ✓ | | | ✓ | | | | 4 (+2 with `create:task`, +2 with `manage:config`) |
| `approve:task` | ✓ | | ✓ | | | | | 11 |
| `delete:task` | ✓ | | | | | | | 1 |
| `scan:repository` | ✓ | | | ✓ | ✓ | | | 3 |
| `write:evidence` | ✓ | | | ✓ | ✓ | | | 3 |
| `write:agents` | ✓ | | | ✓ | | | | 0 alone (+2 with `write:skills`) |
| `write:skills` | ✓ | | | ✓ | | | | 3 (+2 with `write:agents`) |
| `write:capability` | ✓ | | | ✓ | | | | 5 |
| `write:claim` | ✓ | | | ✓ | | | | 12 |
| `write:swarm_action` | ✓ | | | ✓ | | | | 55 |
| `write:runner_manifest` | ✓ | | | | | | | 1 |
| `write:governance` | ✓ | | | | | | | 57 |
| `manage:config` | ✓ | ✓ | | | | | | 40 (+2 with `execute:task`) |
| `manage:users` | ✓ | ✓ | | | | | | 0 in `routes/*.ts` |
| `manage:backups` | ✓ | ✓ | | | | | | 3 |
| `manage:policies` | ✓ | ✓ | | | | | | 0 in `routes/*.ts` |
| `manage:tokens` | ✓ | ✓ | | | | | | 6 |
| *(no permission check)* | | | | | | | | 27 (§4) |

Role rows: ADMIN `:16-38`, PLATFORM_ADMIN `:39-48`, APPROVER `:49-54`, MAKER `:55-67`, CHECKER `:68-73`, AUDITOR
`:74-78`, VIEWER `:79-82`. The last column counts the 283 `router.post|put|patch|delete` registrations in the 64 files
`server/src/routes/*.ts`. Aliases are resolved: `requireBackupPermission` → `manage:backups` (`backup.ts:16`),
`canManage` and `requireAdmin` → `manage:config` (`federation.ts:116`, `intervention.ts:10`), `requireGovernanceWrite`
/ `requireEvidenceRead` (`meta-orchestration.ts:25-30`), and segml's `requireAuth(perm)`, which is
`requirePermission` (`segml-federation.ts:13`). No mutating route is registered outside `routes/`. The scan counts
registrations, not reachable paths: `swarm-orchestration.ts` is mounted twice (`routes/index.ts:208-209`).

Row-level rules sit on top of the matrix:

- Task and approval visibility. ADMIN and PLATFORM_ADMIN are "privileged" (`authorization-service.ts:14-16`). For
  approvals, AUDITOR and APPROVER also see every row (`authorization-service.ts:87-89`). VIEWER, MAKER and CHECKER see
  only approvals on tasks they own or created (`:90-93`).
- Self-approval is refused in the service (`approval-service.ts:208`) and mapped to 409 (`routes/approvals.ts:80-85`).
  `AuthorizationService.canApproveForTask` (`authorization-service.ts:39-44`) has no caller outside tests.

## 2. APPROVER and `write:governance`

APPROVER holds `approve:task`, `read:evidence`, `read:repository` and `create:task` (`shared/src/types/auth.ts:49-54`).
It does not hold `write:governance`, and only ADMIN does (`:23`). The effect on the operator's decision surfaces:

- An APPROVER can decide task approvals (`routes/approvals.ts:160,195,228,260`) and memory candidates
  (`swarm-governance.ts:207`, `ACTION_PERMISSIONS.memoryReview`, `dashboard/src/lib/permissions.ts:18`).
- An APPROVER cannot approve, reject, requeue, dismiss or label self-improvement proposals. Those routes require
  `write:governance`: `self-improvement.ts:65,81,107,121,147,169,191,235`. In the dashboard they show "Needs
  write:governance" (`permissions.ts:12-17`). On Telegram, label buttons check the same permission
  (`telegram-bot-service.ts:301`).
- `write:governance` gates 57 mutating routes in 18 files, beyond these 8 operator decisions. Per file: explainer 13,
  self-improvement 9, agi 5, swarm-governance 4, openmythos 4, cognitive 3, memory 3, runtime-governance 3, compliance 2,
  council 2, gym 2, and 1 each in capabilities, intelligence, meta-orchestration, platform, red-team, remote-gym and
  retirement. Examples: the explainer fleet kill switch (`explainer.ts:412`), runtime-governance release/reset
  (`runtime-governance.ts:74,93`), agent retirement (`retirement.ts:15`), proof-run create/rollback
  (`swarm-governance.ts:107,128`), evolution run/close-loop (`swarm-governance.ts:133,137`), council session execute
  (`council.ts:128`) and compliance audit append (`compliance.ts:45`).

Giving APPROVER all of `write:governance` therefore grants far more than "decide proposals". §5 lists the options.

## 3. Reads that return free text or identifiers to low-privilege roles

### 3.1 `GET /approvals` and `GET /approvals/:id`

- Mount: `requireAuth` only (`routes/index.ts:146`). The handlers have no `requirePermission`
  (`routes/approvals.ts:102,142`). The mutating routes in the same file do have one (`:36,160,195,228,260`).
- Row filter: per-task visibility, as described in §1 (`routes/approvals.ts:106,119-131`; `:148` for `/:id`).
- Payload: the full `approvals` row (`routes/approvals.ts:15-21`). That row includes `command`, `target_path`,
  `title`, `description`, `request_message`, `request_data` and `metadata` (`database/schema.ts:273-284`,
  `database/migrate.ts:19-25`, written at `approval-service.ts:96-101`). It also includes
  `context = approvalContext(db, task_id)` for loop-worker tasks. That context carries `working_directory`
  (`approval-context.ts:15,37`) and a 500-character `prompt_preview` of the task description (`:16-17,38`), plus a
  400-character `goal_objective` (`:32`). The dashboard renders both on the approval card (`ApprovalCard.tsx:112-113`).
- The list has no `LIMIT` and the `status` filter is unvalidated (`routes/approvals.ts:104-116,124-131`).
- Who receives it today:
  - ADMIN, PLATFORM_ADMIN, APPROVER and AUDITOR receive every row with all of the fields above.
  - VIEWER, MAKER and CHECKER receive rows only for tasks they own or created.
  - Pinned by `server/src/__tests__/approvals-http.test.ts:68-82`.
- Correction to the program text (§2.2): "no `requirePermission`" is accurate, but VIEWER does **not** see other
  users' approvals. Apart from the two admin roles, a non-owner sees prompt and path text only as APPROVER or AUDITOR.

### 3.2 `GET /self-improve/decisions`

- Gate: `requirePermission('read:evidence')`, which every role holds (`self-improvement.ts:101`).
- The `telegram` block comes from `decisions-inbox.ts:169-170` with the shape `decisions-inbox.ts:41`. Callers without
  `manage:config` get `email` and `role` nulled (`self-improvement.ts:103-104`). They still receive
  `telegram_user_id`, `user_id` (the internal user id), `added_by` and `created_at`. `added_by` is the actor's
  `sub`, or the actor's email when `sub` is empty (`self-improvement.ts:205`, stored at `decisions-inbox.ts:282-284`).
  Pinned as intended behaviour by `decision-audit-integrity.test.ts:134-136` ("F6: viewers see Telegram ids").
- The same payload also gives every role the first 600 characters of memory-candidate `content`
  (`decisions-inbox.ts:172`). Acting on a memory candidate needs `approve:task` (`swarm-governance.ts:207`). This
  item was not in the brief but falls under the same R6b rule.

## 4. Mutating routes without `requirePermission`

There are 41 registrations without a literal `requirePermission`. Fourteen of them use an alias that resolves to a
permission (§1), which leaves **27 with no permission check at all**.

**Machine routers (18). Each authenticates by its own token, signature or secret; counts only:**

| Router | Mutating routes | Credential |
|---|---|---|
| `host-agent.ts` | 4 | per-host signed token, `X-Host-Token` (`host-agent.ts:21-39`) |
| `remote-gym.ts` | 7 (its 8th, `/kb/release`, needs `write:governance`, `:84`) | per-host signed token, `X-Gym-Worker-Token` |
| `swarm-orchestration.ts` social runtime | 4: 3 token-gated + public open-door `/join` (invite code, 60/min limiter, `:344,352`) | `X-Agent-Social-Token` (`:370-389`) |
| `spawns.ts` | 1 (`POST /` child spawn, `:78`) | `X-Spawn-Token`, validated in the service (`:87-88`) |
| `telegram.ts` | 1 (`/webhook`, `:89`) | webhook secret header (`:95-100`) |
| `github-webhooks.ts` | 1 (`:78`, mounted at `server/src/index.ts:163`) | HMAC signature (`:84`) |

**Authentication endpoints (3).** `auth.ts:61` POST `/login`, `:128` POST `/refresh`, `:177` POST `/logout`. These are
public by design.

**Human-facing routes behind `requireAuth` only (6):**

| Method + path | file:line | What it does | Proposal |
|---|---|---|---|
| POST `/api/telemetry/pageview` | `routes/index.ts:120` | increments a page counter (path sanitised, `:121-123`) | keep: self-scoped, no data returned |
| POST `/api/organizations/switch` | `organizations.ts:25` | mints a token for the caller's own organization (membership check `:43-46`) | keep: self-scoped |
| POST `/api/exports/task/:taskId` | `exports.ts:50` | read-only export; `canReadTask` in the service (`export-service.ts:57`) | keep |
| POST `/api/exports/evidence/:taskId` | `exports.ts:62` | read-only export; `canReadEvidenceForTask` (`export-service.ts:166`) | keep |
| POST `/api/exports/repository/:repositoryId` | `exports.ts:86` | read-only export; `read:repository` in the service (`export-service.ts:278`) | keep |
| POST `/api/exports/report/summary` | `exports.ts:98` | read-only export; admin-only in the service (`export-service.ts:339`) | keep |

**Mutating routes gated only by a permission every role holds (13).** `read:evidence` or `read:repository`. Most
compute and return a result. Three of them do more:

- `explainer.ts:640` POST `/explainer/ask` calls a local LLM (`explainer-ask-service.ts:91`) and writes an audit row
  (`explainer.ts:654-657`). It is rate-limited to 20/min (`:637`).
- `swarms.ts:294` POST `/swarms/expert/resolve` records a knowledge gap when the flag is on and the resolver abstained
  (`swarms.ts:298`, `knowledge-gaps.ts:88-89`).
- `apex.ts:153` POST `/apex/llm/route` refreshes provider health before routing (`apex.ts:161`).

The other 10 are pure compute:

- `council.ts:239`
- `goals.ts:56`
- `intelligence.ts:29`
- `multi-model.ts:50`
- `research.ts:77`
- `runtime-governance.ts:67`
- `swarm-intel.ts:264`
- `swarm-workers.ts:51`
- `meta-orchestration.ts:74`
- `segml-federation.ts:36`

**UXE-10 cross-check.** UXE-10 has not landed. I mapped every mutating call on its 7 pages to the server route it
reaches:

- FleetCockpit → `swarm-workers.ts:43,55,59,63`
- SwarmMissionControl → `goals.ts:68`, `swarm-governance.ts:107,128,137`, `swarm-knowledge.ts:62`
- AgentCommons → `swarm-orchestration.ts:215,236,267,300`
- Tasks and TaskDetail → `tasks.ts:131,399,452`, plus the export above
- ProofRunDetail → `swarm-governance.ts:128`
- Federation → `federation.ts:149`

All of them have a server permission check, except the read-only task export. **So UXE-10 should find no route that is
missing a server check.** Separately, two UI actions have no `ACTION_PERMISSIONS` entry: proposal approve/reject
(`dashboard/src/lib/api.ts:2085,2089`). That is UI parity work for UXE-10, not a server gap.

## 5. Proposed matrix (each row is a separate decision; default for all: no change)

| Id | Change | Recommended |
|---|---|---|
| a | APPROVER and proposal decisions. **A:** add `write:governance` to APPROVER (one line, `auth.ts:49-54`; grants all 57 routes in §2). **B:** a new permission `decide:proposals` for ADMIN and APPROVER. The 8 routes `self-improvement.ts:65,81,107,121,147,169,191,235` move to it, together with `permissions.ts:12-17`, the Telegram label check `telegram-bot-service.ts:301`, and an `ACTION_PERMISSIONS` entry for proposal approve/reject. `/reconcile` (`:243`) and the other 48 routes stay on `write:governance`. **C:** no change. | B |
| b | `GET /approvals` and `GET /approvals/:id` get an explicit `requirePermission('read:evidence')`. No behaviour change, because every role holds it. It makes the gate visible to route scans and to R6b. | yes |
| c | Approval reads strip `context.prompt_preview`, `context.working_directory`, `command`, `target_path`, `request_data` and `metadata` for callers that hold neither `approve:task` nor `manage:config`. Affected: AUDITOR (all rows) and VIEWER/MAKER/CHECKER (own rows). APPROVER and admins are unchanged. | yes |
| d | `GET /self-improve/decisions`: callers without `manage:config` get `telegram: []` and a count in place of the rows. `telegram_user_id`, `user_id` and `added_by` no longer reach them. | yes |
| e | `GET /self-improve/decisions`: callers without `approve:task` get memory candidates without `content`. Title, type, status and dates are unchanged. | yes |
| f | The three read-gated POSTs with side effects (§4: `explainer.ts:640`, `swarms.ts:294`, `apex.ts:153`). **A:** keep (each is per-router or `/api` rate-limited, `routes/index.ts:110`). **B:** raise `/explainer/ask` to `create:task`. | A |

The 6 human-facing `requireAuth`-only routes and the 18 machine routes stay as they are (§4).

## 6. Blast radius

- **a-A.** Every APPROVER account gains 57 routes, including the kill switch, quarantine release/reset, retirement and
  proof-run rollback. So does every Telegram identity mapped to an APPROVER, through the delegation rule at
  `self-improvement.ts:209-215`. That rule compares `ROLE_PERMISSIONS` at mapping time, so after the change a
  `manage:config`-only caller can no longer map to an APPROVER (the target would hold permissions the caller lacks).
- **a-B.** APPROVER gains exactly 8 routes. ADMIN is unchanged, because ADMIN gets the new permission. A server that
  is not redeployed together with the dashboard shows the wrong buttons: both read the constant at build time, so ship
  in one deploy.
- **b.** None at runtime.
- **c.** An AUDITOR loses prompt and path text on the approval card. The audit trail itself is unchanged. The approval
  card must render `unknown` for the stripped fields, not an empty row (R8).
- **d.** The `/decisions` Telegram table shows a count for non-`manage:config` roles. The program already plans to
  move this table off `/decisions` (UXE-20). `decision-audit-integrity.test.ts:134-136` must change from "viewers see
  ids" to "viewers see a count". This is a tightening, made on the operator's decision.
- **e.** A viewer's memory-review rows lose their 600-character preview.
- **f-B.** VIEWER, CHECKER and AUDITOR lose `/explainer/ask` (dashboard Explainer page) on their own accounts.
- **Unknown:** how many active accounts hold each role in production. The operator can check one aggregate number per
  role: count of active users by role. No names are needed.

## 7. Migration steps (only after a yes; one PR per decision)

1. Red tests first, with titles `'UXE-11<x>: …'`:
   - a role × route table for the changed routes (403 for roles without the permission, 2xx for roles with it);
   - extend `cockpit-decisions-authz.test.ts:85` (low-privilege 403 list);
   - extend `approvals-http.test.ts:68-82` (field presence per role);
   - update `decision-audit-integrity.test.ts:134-136` (d);
   - extend the dashboard permission pin `UX4.test.tsx`.
2. Smallest change:
   - a-B: one string in `shared/src/types/auth.ts` (ADMIN and APPROVER), 8 route literals, 6+1 `ACTION_PERMISSIONS`
     entries, 1 Telegram check;
   - b and c: `routes/approvals.ts` only, with stripping in `parseApproval`;
   - d and e: `self-improvement.ts:103-104` next to the existing F6 strip.
3. No schema change and no data migration, because permissions are code, not rows (§1). No new flag: a server-only
   flag would desync the dashboard's build-time gating. The operator's merge is the switch.
4. Deploy server and dashboard together. Verify with one aggregate: as an APPROVER test account, `POST
   /self-improve/proposals/<id>/requeue` returns 2xx (a-B), and `GET /self-improve/decisions` as a viewer has an empty
   `telegram` list (d).

## 8. Rollback

Each decision is one PR, and its rollback is `git revert` of that PR plus a normal deploy. There is no schema or data
to undo. Tokens need no reissue, because the role is re-read per request (§1). A Telegram mapping created under a-A or
a-B stays valid after a revert. The mapped user simply loses the extra permission again.

## 9. Decisions for the operator

1. **D-UXE-11a:** Should APPROVER be able to decide self-improvement proposals? Options: A = add `write:governance`
   (57 routes), B = new `decide:proposals` permission on the 8 decision routes only, C = no change. Default: C.
   Recommended: B.
2. **D-UXE-11b:** Add an explicit `requirePermission('read:evidence')` to `GET /approvals` and `GET /approvals/:id`
   (no behaviour change)? Default: no.
3. **D-UXE-11c:** Strip `prompt_preview`, `working_directory`, `command`, `target_path`, `request_data` and `metadata`
   from approval reads for callers without `approve:task` or `manage:config` (AUDITOR, and task owners)? Default: no.
4. **D-UXE-11d:** Replace the Telegram allowlist rows in `GET /self-improve/decisions` with a count for callers
   without `manage:config`? Default: no.
5. **D-UXE-11e:** Drop memory-candidate `content` from `GET /self-improve/decisions` for callers without
   `approve:task`? Default: no.
6. **D-UXE-11f:** Keep `/explainer/ask`, `/swarms/expert/resolve` and `/apex/llm/route` on `read:evidence` (A), or
   raise `/explainer/ask` to `create:task` (B)? Default: A.
