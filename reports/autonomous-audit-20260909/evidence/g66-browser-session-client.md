# G66 browser-session client: bounded implementation evidence

2026-09-09. Audit checkout only. This document records client execution in fixture tests; actual browser/cookie/server evidence is maintained separately by the parent agent. No provider or production call was made by this subtask.

## Implemented existing client boundaries

- Browser login uses the existing `/auth/login` endpoint with `X-Djimitflo-Session: browser` and `credentials: include`. Only the returned access token remains in the existing `djimitflo_auth_session` storage; refresh credentials are never read by JavaScript.
- The existing auth-store now owns shared `authenticatedFetch`. `apiRequest`, the regular `ApiClient.request`, export downloads, audit-log requests/downloads and the observability SSE fetch all use it. Public health lookup remains public.
- A rejected bearer receives at most one rotation and one request retry. Concurrent in-tab failures share one promise. Supporting browsers use a named native Web Lock; after acquiring it, the client rereads storage and reuses another tab's token only when its expiry is still future and user/session-family/organization identity matches. A different but already-expired token still requires rotation. Missing Web Locks fall back to in-tab serialization, not a claimed global cross-tab lock.
- Refresh sends the current access token's selected organization to `/auth/refresh`; authorization of that selection remains server-owned. Cookie-only restoration can recover after access storage is absent. `restoreSession` retains the new token rather than rewriting its captured expired token.
- Logout clears local identity immediately, then waits for pending login/refresh responses before calling cookie-family revocation. It includes the captured bearer as the backend's signed-session fallback. A new login waits for pending logout. Login holds its Web Lock through JSON decoding and state adoption, not merely receipt of headers.
- Epoch and storage checks prevent logout/identity changes from being overwritten by delayed refresh responses. Checks occur before and after response JSON decoding, including when access storage was initially null. Storage events invalidate logout or changed user/session/organization; same-family rotations do not invalidate a lock waiter. Scope changes request a page reload.
- Token changes reconnect existing WebSocket hooks. AUTH_EXPIRED permits a refresh attempt; a replacement rejected before opening does not trigger an unbounded retry chain. AUTH_INVALID/REQUIRED stop reconnection. Unmount/logout cleanup and pending-refresh guards remain in place.
- OrganizationSelector accepts refreshed access tokens from the same logical family when applying a legitimate switch. Different user, family, organization or logout still reject it. Non-identical legacy tokens without a nonempty session ID do not qualify for identity equivalence.

## Tests executed against actual client code

Focused final command:

```sh
npm run test --workspace=@djimitflo/dashboard -- src/lib/auth-session.test.ts src/hooks/useWebSocket.test.ts src/components/OrganizationSelector.test.tsx
# 34 passed: 19 session tests, 8 socket tests, 7 organization tests
npm run type-check --workspace=@djimitflo/dashboard
npm run lint --workspace=@djimitflo/dashboard
# both exit 0
```

The preceding full-dashboard checkpoint passed 137 tests before three additional focused regressions were added. Do not use that historical count as the final integrated total; parent runs the final build and full suite.

Executed properties include browser login header/credential mode; actual Zustand and localStorage adoption; concurrent API/auth-store401 singleflight; organization scope body; invalid/revoked refresh; one bounded retry; native-lock callback ordering; another tab's token arriving before its asynchronous storage event; changed user/session rejection; legacy exact-match fallback; logout during pending login/refresh; cross-tab logout invalidation; expired/cookie-only restoration; visible logout failure; export retry and blob cleanup; token-driven socket reconnect; socket expiry/rejection/unmount; and organization switching across an access refresh.

The additional delayed-response regression was first run against the intermediate implementation and **failed**: refresh resolved with the old family token after another identity had been written to storage. The run contained one failed selected test and18 skipped tests. Adding the post-JSON storage guard changed that exact test to green in the final34-test run. No test assertion was weakened.

## Proof boundaries and retained limits

- HTTP fetch and native lock callbacks are intercepted test fixtures. Socket instances are deterministic test doubles. They do not prove real cookie flags, browser cookie rotation, actual WebSocket transport, browser tab scheduling, server restart persistence or production deployment.
- The refresh cookie is deliberately absent from client state and test outputs. Backend-origin checks, session-family persistence/replay detection, current-user membership validation and revocation are parent-owned and must be joined with this client evidence.
- Logout network failure leaves the user locally signed out with an observable error; it does **not** claim successful server revocation. LoginPage already displays auth-store errors.
- Browsers without native Web Locks receive in-tab singleflight only. Cross-tab concurrency without those locks is not certified by these tests.
- Decoding token claims is used only for session continuity/display, never as a replacement for server-side JWT validation or permissions.
- No refresh-token JavaScript storage, cookie subsystem, dependency, alternate API client or background provider was introduced.

Owned source: dashboard `lib/auth-store.ts`, `lib/api.ts`, `hooks/useWebSocket.ts`, the authorized `OrganizationSelector`, `AuditLogViewer` and `ObservabilityPage` sibling callers, plus focused tests. Existing catalog/task/runtime logic and server/shared code were not changed in this client subtask. Source is frozen for parent integration and actual browser QA.
