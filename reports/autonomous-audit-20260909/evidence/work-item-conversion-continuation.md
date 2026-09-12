# Backlog work-item conversion: bounded correction

Date: 2026-09-09. Scope: isolated audit checkout only. No production calls, provider execution, persistent audit-database mutation, merge or deployment.

## Outcome

Two reproduced defects at one shared boundary are corrected:

1. **Repeated Goal actions duplicated goals and overwrote work lineage.** `/swarm-resources` kept Goal enabled on planned/leased items. Every POST generated a fresh goal, replaced `parent_goal_id`, and rewound status to planned, even when the original loop relationship remained in metadata.
2. **Failed conversion left an orphan goal.** `convertToGoal` inserted a goal before calling guarded `update`, without a transaction. A terminal security finding correctly rejected reopening, but its goal insert survived. A real SQLite update-trigger failure reproduced the same atomicity defect independently of security semantics.

The UI now disables creation when a goal is already linked, the item is not candidate/triaged, or its source is protected `agent_board`. It displays the actual linked goal ID. The service wraps read/insert/link in one SQLite transaction, returns an existing valid link without mutating status or metadata, rejects missing linked goals and ineligible new conversions, and preserves the specific board/security reopening guards. State conflicts map to HTTP409. Existing HTTP201 response shape remains unchanged for successful idempotent retries.

## Executed baseline evidence

An inline Node/tsx probe used the actual `WorkItemService` and existing `createTestDb()` helper, which creates only an in-memory SQLite database. Output before correction:

```json
{"probe":"repeat conversion","differentGoalIds":true,"goals":2,"itemStatus":"planned"}
{"probe":"rejected conversion","error":"SECURITY_FINDING_REOPEN_IMPORT_REQUIRED","goalsBefore":2,"goalsAfter":3,"status":"discarded","parentGoal":null}
```

The rejected fixture was a synthetic low-risk security finding with valid fingerprint and false-positive disposition. No finding scanner, worker or external authority executed.

Red regressions before implementation:

- Server conversion suite: **9 failed, 3 passed**. Failures include duplicate identity, blocked/planned/leased/done/discarded admission, real SQLite trigger rollback, security rejection orphan and HTTP201 where conflict was required.
- New dashboard suite: **6 failed, 3 passed**. Existing linked/blocked/planned/leased actions remained enabled; persisted goal identity was not displayed after success.

## Trace and owned correction points

| Boundary | Actual location |
|---|---|
| UI row and action handler | `packages/dashboard/src/pages/SwarmResourcesPage.tsx`, `WorkItemRow`, `onGoal` |
| Existing authenticated client | `packages/dashboard/src/lib/api.ts`, `convertWorkItemToGoal` (unchanged) |
| HTTP POST and conflict mapping | `packages/server/src/routes/work-items.ts`, `/:id/convert-to-goal`, `mapWorkItemError` |
| Transactional domain conversion | `packages/server/src/services/work-item-service.ts`, `convertToGoal`, `convertToGoalInTransaction` |
| Other production caller inspected | `SwarmStatusService.planTriagedWorkItems` already skips linked goals and calls the same shared service |
| Security and board guards inspected | `WorkItemService.update`, terminal recurrence import, `IntegrationInboxService`; existing integration-spine/apex regressions retained |

## Verification

```sh
npm run test --workspace=@djimitflo/server -- src/__tests__/work-item-evidence-conversion.test.ts src/__tests__/integration-spine-service.test.ts src/__tests__/apex-integration.test.ts
npm run test --workspace=@djimitflo/dashboard -- src/pages/SwarmResourcesPage.test.tsx
npm run type-check --workspace=@djimitflo/server
npm run type-check --workspace=@djimitflo/dashboard
npm run lint --workspace=@djimitflo/server
npm run lint --workspace=@djimitflo/dashboard
npm run build --workspace=@djimitflo/server
npm run build --workspace=@djimitflo/dashboard
```

- Server: **78/78 passed**, including 14 conversion tests. Existing security recurrence, evidence closure and board-authority tests remain green.
- Dashboard: **9/9 passed**, using actual component handlers and mocked API dependencies; no real-browser proof claimed.
- Both workspace type-check, lint and build passed. Owned-source `git diff --check` passed.
- Actual Express/Supertest route → SQLite roundtrip proves two POSTs return one goal ID, subsequent GET preserves the link/status, and both task and worker-lease counts stay zero. This router fixture does not assert authentication integration; parent owns auth/session verification.
- Actual SQLite `BEFORE UPDATE` trigger raises an abort through HTTP: response500, zero goals, original candidate/unlinked item unchanged. Removing only the in-memory fixture trigger permits retry201 and exactly one goal.
- HTTP terminal-state refusal is409 and leaves zero goals. Existing security refusal remains `SECURITY_FINDING_REOPEN_IMPORT_REQUIRED` and cannot leave a goal.

## Limits and retained behavior

Parent integration subsequently joined actual browser evidence: `work-item-browser-{before,converted,reloaded}.log`, the duplicate API result in `work-item-browser-repeat.log`, and independent file-SQLite assertions in `work-item-browser-db.json` and `work-item-browser-after-restart.json`. One goal remains created and linked after browser reload and actual server restart, with no linked loop. `output/playwright/work-item-conversion-final.png` was visually inspected. The fixture was initially created through authenticated API, then converted using the actual Goal button; no nonexistent UI create form is claimed. Console diagnostics were only known automation `data:,` CSP refusals. `node reports/autonomous-audit-20260909/evidence/session-conversion-proof.mjs` reruns the read-only persisted-state assertions.

- These are local service/HTTP/database and component regressions, not the complete browser/provider backlog execution chain. No full-workspace aggregate result is inferred from the scoped counts.
- A recurrent imported security finding may retain a historical `parent_goal_id` under existing import/update semantics. This correction deliberately preserves that identity instead of inventing a replacement. A new security remediation cycle against that historical association is **not proven**. Its explicit re-link/reopen semantics require separate authority-aware work; no import, closure, promotion or recurrence policy was changed here.
- No migration removes duplicate/orphan goals created by earlier versions; exact remediation requires provenance review. No existing user data was deleted.
- Other Swarm Resources actions, scheduling, memory promotion and specialist panels were outside this correction. Their previous PARTIAL status remains.

Review conclusions: correctness defects reproduced and fixed; security gates retained with existing regression proof; constant-size conversion queries inside one short transaction; no new dependency, framework or control-plane abstraction. Source changes are local and uncommitted, pending parent review.
