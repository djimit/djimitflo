# Current-principal enforcement — G62

Severity: high. Existing bearer holders retained prior administrator authority after account role changes: the HTTP middleware verified current active status but assigned the old JWT role. Existing WebSocket clients retained role and active status across subsequent deliveries. This was reproduced locally, not probed against production users.

## Executable evidence

- `auth-principal-red.log`: all11 new real HTTP/SQLite/WebSocket assertions failed before repair. Three middleware paths retained old roles; new sockets retained token roles; all/admin/user/task/debate/direct delivery continued after disablement; existing administrator sockets continued after demotion.
- `auth-principal-green.log`: first integration attempt had11 obsolete mock-fixture failures; the11 new real transport tests and real task-wire test passed. Existing mocks represented active users without roles/emails and used the nonexistent `UserRole.OPERATOR`; fixtures were corrected to complete current users/actual maker roles. No production fallback to stale claims was added.
- `auth-principal-final.log`:42 scoped checks passed before the later login/organization additions.
- `auth-login-input-red.log`:7 malformed-login cases failed,12 checks already passed. Non-string email/password and whitespace email previously reached credential operations or returned an authentication failure instead of validation errors. Existing input boundary now rejects these with400.
- `auth-principal-verified.log`:58 checks passed across five suites, including20 current-principal/login/organization tests, existing middleware/socket tests, actual owner-scoped task delivery and critical HTTP contracts. Test server binds loopback; socket messages are observed on actual TCP clients, not inferred from mocked sends.

## Shared corrections and independent review

`packages/server/src/middleware/auth.ts` resolves current role/email before permissions or ownership checks for required, optional and bearer-or-spawn authentication. Current membership validates the selected organization. The explicitly supported `default` selection remains valid; stale non-default membership returns401 (or anonymous under optional authentication), rather than silently rebinding to another tenant.

Independent review found a regression in the first draft: blindly copying current membership erased a legitimate `/organizations/switch` to `default`. Actual route/signature/middleware reproduction showed signed default but effective assigned organization. That draft was corrected; a new real HTTP switch→replacement-token→identity test retains default and rejects stale assigned membership. This review finding was not an original product defect.

`packages/server/src/services/websocket-service.ts` reads current account authority before delivery and disconnects disabled/deleted or role/email-changed clients. Generic and debate broadcasts now reuse the existing filtered delivery boundary; direct sends also validate the client. Token-expiry and backpressure behavior remain. No timer, revocation registry or new authentication framework was introduced.

`packages/server/src/routes/auth.ts` validates request field types before calling credential operations. It does not change password policy or rate-limiter semantics.

## Limits

- In-flight HTTP work is not revoked retroactively. Socket checks run before subsequent protected delivery/access, not by an immediate idle-connection timer.
- No universal multi-tenant WebSocket isolation claim: the existing socket model has no organization context/filter. This fix addresses current role, account status and identity, not that separate architecture gap.
- Existing access JWT logout/revocation and automatic session refresh are not implemented by this patch. The separately repaired refresh service remains disconnected from routes/frontend.
- Browser token storage is still the existing short-lived bearer model; no persistent refresh credential, cookie migration or weakened CSP was added.
- No production account, provider, approval or external authority was modified. Local patch remains REVIEW_REQUIRED.

Guidance applied: existing security-best-practices trust-boundary rules and testing-strategy transport/rollback checks, under Ponytail reuse of existing middleware and socket delivery paths.
