# Approval mutation / canonical audit atomicity

Scope: existing `ApprovalService` create, decision and lazy-expiry methods plus a new focused test file. No execution-engine, request metadata, permission or provider changes are included here.

## Proven defect and correction

An actual SQLite trigger rejecting canonical `audit_events` insertion reproduced approval rows remaining created, approved, denied or expired after the caller received an audit exception. Such a row could be consumed without the corresponding audit record. Independent notification fault injection also reproduced a successfully persisted decision appearing to fail because WebSocket publication threw.

Each approval transition now acquires an immediate SQLite transaction before reading/updating the decision and commits its canonical audit in the same transaction. Expired decisions persist expiry plus audit before returning the explicit `APPROVAL_EXPIRED` refusal. Audit errors roll the transition back. Notifications run after commit and fail with a sanitized warning rather than preventing the caller from consuming the persisted domain outcome.

Self-approval rejection, strict boolean decisions, manual-review isolation, one-hour request lifetime and already-processed rejection are retained. No new approval authority or bypass is introduced.

## Execution evidence

- `approval-atomicity-red.log`: **8 failed / 3 passed** before correction. Real canonical audit insertion faults cover create, both decision values, read-triggered expiry and decision-triggered expiry; three notification-failure cases also fail before repair.
- `approval-atomicity-green.log`: **12 passed** after correction. The additional file-backed test uses two real SQLite connections: another reader still sees `pending` while the primary audit is running; a competing decision cannot acquire the write lock; after commit it sees `approved` and cannot decide again. Canonical audit count remains exactly one request plus one decision.
- `approval-atomicity-integration.log`: **58 passed / 4 files** across focused approval service, HTTP role checks, manual approvals and execution-engine regressions (17:21 checkpoint).
- `approval-atomicity-type-check.log` and `approval-atomicity-lint.log`: exit 0; focused diff whitespace check also exit 0.

All database faults and actors are disposable local fixtures. The temporary file-backed database directory is removed after both handles close; no user data or existing evidence is removed.

## Bounds

Current inspected callers invoke these service operations without an outer database transaction. The post-commit publication guarantee assumes that existing calling pattern; a future caller wrapping the operation in an outer transaction must defer publication until that outer commit. No durable notification outbox is added: missed events require existing state refresh/reload. The two-connection test proves SQLite transaction ordering, not distributed coordinator correctness or live provider behavior. Parent-owned execution-input binding and historical-approval reuse repairs are separate evidence.
