# Local approval DENY browser proof — 2026-09-09

Scope: localhost3187 only, two new disposable manual approval/task fixtures; no external provider or task execution. Browser skill discovery returned no in-app browsers, so isolated standalone Playwright session `djimitflo-audit-deny` was used. Existing synthetic local maker/admin and distinct approver identities were used; this is software identity separation, not independent human judgment.

## Actual chain

1. Existing authenticated REST endpoints created task/approval pairs (both201): `deny-ui-fixtures.log`.
2. Approver clicked Deny on normal fixture and entered `Independent fixture denial: missing execution evidence; no dispatch authorized.` Actual POST200 response persisted in `deny-ui-normal-response.json`.
3. Error/retry fixture: whitespace reason rejected locally; deliberately injected browser-only POST503 showed exact inline failure, retained pending state, and left Deny usable. After removing interception, retry POST200 succeeded with `Retry fixture denied after error recovery.` Screenshot `output/playwright/deny-ui-mutation-error.png`; evidence `deny-ui-mutation-error.log`. The injected503 is not represented as a genuine server outage.
4. Deliberately injected list GET503 showed an error and Retry, not an empty or unblocked state. Removing interception and clicking Retry loaded the actual empty pending queue. Denied tab after reload displayed both titles, reasons, identities and decision times: `deny-ui-list-retry-history.log`, screenshot `output/playwright/deny-ui-history-reloaded.png`.
5. Read-only verification against `.data/audit.sqlite`: both tasks remain pending, review_only, started_at/completed_at null, execution_events count0. Both approval rows are denied by approver `3d073bca-f8e6-42f1-bee2-bed20ec6119e`, distinct from requester `f0997a41-1d2c-4833-8102-86ea30f33ead`. Each has exactly one approval.denied audit record with the entered reason. Full data in `deny-ui-durable-proof.json`.
6. Restored the admin session and refreshed both task pages: pending/review-only state, recorded denial reason/identity and no execution events remain visible (`deny-ui-task-refresh.log`). The distinct approver can decide these approvals but receives404 for maker-owned task/detail/event reads (`deny-ui-task-read-probe.log`); this authorization boundary was not widened.

Fixtures retained in disposable audit DB for reproducibility:

| Fixture | Task | Approval |
|---|---|---|
| normal | 65db4507-0844-4cf3-8884-9851c50eadd6 | 8201c306-d503-45a4-9cda-432eba45b13c |
| error-retry | 8a2d3a03-e61f-43a9-ac4c-e6654a47347c | 757c976c-604f-4f88-ba57-51ee2a184bbe |

## Proven defects and corrections

- Before repair, historical Denied list rendered `unknown`, risk and creation date, omitting actual reason/decider. Now reuses existing ApprovalCard, preserving real title, decision identity/time and reason.
- Before repair, failed approval-list requests showed `No pending approvals. Execution is currently unblocked.` Actual browser fault evidence is in `deny-ui-baseline-gaps.log`. Now explicit error/retry; ordinary empty queue makes no claim about global execution readiness.
- ApprovalCard now displays API errors inline, rejects whitespace-only denial reasons, consumes returned decision state and synchronizes refreshed props. It does not invent a successful decision on failure.
- Request sequence ownership prevents stale responses from previous tabs overwriting the active filter. WebSocket refresh failures are caught through the same loader.
- A seventh regression reproduced a late denial completion reloading its old tab after the user switched filters. The completion callback now reads the current tab from a ref, so it refreshes the active filter instead. The test failed before the fix and passed afterward.

Changed source scope: ApprovalCard.tsx, ApprovalQueuePage.tsx, ApprovalQueuePage.test.tsx only. No server or master-report edits.

Verification before the final tab-completion correction at12:22 local: dashboard61/61 tests across18files; TypeScript/build and lint passed. After the correction at12:30 local: all seven targeted ApprovalQueuePage tests passed (`deny-ui-final-tests.log`), and `git diff --check` passed. Tests cover outage/retry, denial provenance, late previous-tab response, whitespace rejection/no mutation, failed decision/retry, externally refreshed decision state and mutation completion after tab switching. Parent owns the subsequent joint full build/type/lint/test verification; earlier aggregate results are not presented as verification of the final patch.

Limits: no runtime approval/resumption/cancellation claim; no real human decision claim. Historical source privacy/permissions remain enforced by backend. Expected CSP `data:,` automation probes remain documented elsewhere and were not bypassed. User-visible denial still uses the existing native reason prompt, not a new form system.
