# G66 — actual browser session closure

The previously dormant refresh service is now connected through the existing auth routes, browser request boundary, organization selector and WebSocket hook. No new dependency, cookie/session framework, identity provider or parallel session ledger was introduced. The original checkout and production deployment were not modified.

## Executed chain

Actual isolated Chromium used `/login`, `/tasks` and `/agents` at `127.0.0.1:3187`, with the existing disposable organization fixture. The server deliberately issued twenty-second access tokens. Browser session `eb9de2b1-96b0-4ed8-9335-5c212d920440` is identified without disclosing any bearer or refresh credential.

1. Login issued a twenty-second access JWT and an actual HttpOnly, SameSite=Strict `/api/auth` cookie, invisible to `document.cookie`. Secure was deliberately false for local HTTP; production defaults and overrides have separate real-HTTP tests. See `browser-session-initial.log`.
2. Tasks navigation reused already loaded data and did not refresh; its expired token correctly returned401 in a direct diagnostic. This is retained in `browser-session-refreshed.log`, not relabeled as success.
3. A real organization select triggered `/organizations/switch`401 → `/auth/refresh`200 → switch200 → full reload. The same session ID and selected `default` scope survived, and `/auth/me` returned200. Wire evidence: `browser-session-switch-requests.log`; domain/UI assertion: `browser-session-switch-proof.log`.
4. Two existing tabs reloaded concurrently with an expired token. Both regained protected access with the same session ID/default scope. SQLite grew from three to four refresh generations with exactly one new refresh audit and one active generation. Native Web Locks were present. See `browser-session-multitab-proof.log` and `browser-session-db-{before,after-tabs}.json`.
5. The actual server stopped and restarted against the same file database; normal fifteen-minute TTL was restored. Reload renewed the expired access token to a900-second token with the same family/default scope and successful `/me`. See `local-server-browser-session-restarted.log` and `browser-session-restart-proof.log`.
6. The actual Sign out button returned both tabs to `/login`, removed local access state and the refresh cookie, and made a previously valid900-second JWT return401. All five refresh generations became durably revoked. The audit has login, four refreshes, one organization switch and logout. See `browser-session-logout-proof.log` and `browser-session-db-final.json`.

Runnable independent join of browser/wire/file-SQLite evidence:

```sh
node reports/autonomous-audit-20260909/evidence/browser-session-proof.mjs --final
```

The logged-out screenshot `output/playwright/browser-session-logged-out.png` was visually inspected. The named browser context and both tabs were closed. Captured console failures are explained401 expiry/absence/revocation probes and the previously identified automation `data:,` CSP refusals. They are not suppressed or called a zero-error console. A fresh browser's cookie probe currently shows the explicit invalid/expired-session message before login; no authenticated access is granted.

## Defect detection and integration

- Backend route baseline:15red/2green, plus independently red missing-cookie logout. Audit insertion failure rolls back login, rotation and one-/two-credential logout, including a failure on the second audit append. See `auth-cookie-session.md`.
- Session family baseline:3newred/14existinggreen. AccessJWT family binding, invalid/expired/wrong-owner IDs and selected-organization refresh are now checked. Browser logout can also revoke the currently authenticated `sid` when the cookie was removed; arbitrary body session IDs have no authority.
- Independent review reproduced changed-membership HTTP401/WSdata mismatch (`ws-session-membership-review.log`). New and already-open sockets now validate selected membership; explicitly selecteddefault remains valid. Sixty scoped WS/principal/refresh checks pass (`browser-session-ws-membership.log`). No immediate idle-socket timer or cancellation of already admitted work is claimed.
- MCP review reproduced signature-only acceptance of revoked browser-session JWTs. Ten red cases now pass; all39MCP tests pass. Live HTTP MCP uses its existing canonical database for current account/membership/family checks on GET/POST and binds its SSE session to subject/role/org/sid. Actual SDK direct-DB tool execution is refused after revocation without creating another row. Snapshot/no-database transports reject browser-session tokens; their legacy sidless behavior remains signature-only.
- Frontend regressions cover one shared401retry for JSON/download/SSE, in-tab refresh coalescing, native-lock ordering, cross-tab account/session substitution, delayed response-body overwrite, logout/login races, organization switch after refresh and socket reconnection.34focused assertions pass; these fixtures alone are not called actual browser proof. See `g66-browser-session-client.md`.
- Full integrated workspace suite: **2572passed,20skipped** — server2294, dashboard140, catalog26, MCP39, ransomware40, shared3, Telegram30 (`browser-session-tests-integrated.log`). Full build plus final dashboard build, final type-check and lint pass. Configured mutation remains73/73killed, zero survivors/uncovered/errors, only the existing three regions (`browser-session-mutation.log`), not session-specific mutation coverage.

## Explicit boundaries

The final assurance run is BLOCKED (`assurance-browser-session.json`), with only OpenMythos evaluation and dirty/live identity unresolved. The first attempt's source-buffer infrastructure failure is repaired under G67. The contract inventory's critical refresh classification was resolved by making one existing real-HTTP canary's POST method explicit; all cookie/lineage/state assertions remain. Final inventory:572routes,190source execution-pattern matches,56MCPtools. These counts are not endpoint certification.

Legacy headerless bearer clients retain their login shape and sidless token behavior; legacy logout does not revoke them. XSS can still act on browser access credentials in localStorage; HttpOnly refresh storage does not solve XSS. Cross-tab rotation without native Web Locks is not certified. Session authority does not establish tenant-row isolation, rollback completed actions, undo in-flight MCP calls, certify every dashboard route or prove production deployment. No new paid provider task, approval, merge, push or deployment occurred.
