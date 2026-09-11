# G66 browser cookie session — execution evidence

Status: **local HTTP + SQLite session behavior verified**, integrated with the parent-owned session-family service implementation. This report does not claim live-browser or production completion.

## Existing seams and compatibility

Browser clients opt in with `X-Djimitflo-Session: browser`. Legacy `/api/auth/login` remains `{token,user}` without cookie issuance; existing MCP/API clients need not adopt browser sessions. Browser login returns `{token,user,expires_in}` and issues refresh material only in `djimitflo_refresh`, never JSON. The cookie is HttpOnly, SameSite=Strict, scoped to `/api/auth`, with a rolling thirty-day lifetime. `NODE_ENV=production` enables Secure by default; `AUTH_COOKIE_SECURE=true|false` explicitly overrides it. Unknown override values retain the environment default.

`POST /api/auth/refresh` requires the browser header and reads only the cookie. Optional `organization_id` is shape-validated here and membership-validated in the existing service. Browser logout requires the same header, revokes the cookie's session family including an already rotated predecessor, and clears the cookie. A valid current Bearer principal with `sid` can also revoke its own session when the cookie was cleared. If two distinct valid session credentials are presented, both are revoked atomically; arbitrary body session IDs are ignored. Legacy logout without a cookie retains its prior semantics; it does not claim stateless legacy JWT revocation. A cookie-bearing logout without the browser header is rejected.

Cookies are emitted only after the enclosing immediate SQLite transaction commits both session changes and canonical audit. Auth responses use `Cache-Control: no-store`. The custom header is not a secret: it works with explicit-origin credentialed CORS and SameSite cookies as the browser CSRF boundary, not as protection from same-origin script compromise.

## Local proof and limitations

- Initial real Express + isolated SQLite regression run: **15 failed / 2 passed** before route implementation (`auth-cookie-session-red.log`). These assertions demonstrate missing cookie/refresh/logout behavior, not a failure of external login delivery.
- The additional missing-cookie boundary was independently reproduced: browser logout with a valid session Bearer returned 200 but `/me` still returned 200. Preserved in `auth-cookie-session-missing-cookie-red.log`; now corrected using only authenticated ownership.
- Integrated `auth-cookie-session.test.ts`, `refresh-token-continuation.test.ts`, `refresh-token-rotation.test.ts`, and `auth-principal-chain.test.ts`: **67 passed / 4 files**, `auth-cookie-session-green.log` (16:48 checkpoint). Includes real `/me` rejection after logout, hash lineage, expiry, current-role refresh, inactive-account refusal, replay, org validation, Secure overrides, legacy compatibility and header/CORS boundaries.
- Audit failure tests prove rollback for login, refresh, cookie logout, and two-credential logout when the second audit append fails: neither cookie response nor partial revocation/audit survives. These execute the real canonical audit store and SQLite transaction, with only the deliberate failing append substituted.
- Focused source/test lint and server type-check both exit 0 (`auth-cookie-session-lint.log`, `auth-cookie-session-type-check.log`).
- No real credentials, provider execution, production API or browser were used in these HTTP tests. Passwords and JWT secrets are synthetic disposable fixture values; test helpers avoid logging tokens.
- User-wide refresh replay revocation remains deliberate existing policy. Independent simultaneous renewals using one old cookie can revoke sessions; browser renewal must be single-flight. Cross-tab coordination is not proven by route tests.
- Cookie transport and durable session-family behavior are separate from parent-owned browser memory storage, reload restoration, HTTP retries, WebSocket reauthentication and live-browser evidence. Do not infer their completion from this report.
