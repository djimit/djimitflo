# Organization switch token adoption — scoped UI proof

2026-09-09; isolated audit checkout. No external requests, provider execution or actual browser session was used for this correction.

## Reproduced defect

`OrganizationSelector` sent POST `/organizations/switch` but ignored `{token}` in the successful response. It updated only its displayed selection. Shared API requests continued reading the old token from `djimitflo_auth_session`, while WebSocket/session state retained the old Zustand token. The initial list also selected the first row, regardless of the active signed token's organization. Failed requests were invisible.

Current server code already signs the requested organization into the replacement JWT. Parent separately owns current-user/tenant validation and HTTP route tests; this frontend correction does not change those authorization rules.

## Correction

- The component uses the existing authenticated `apiRequest`, including its configured API base and existing expiry behavior.
- Active selection reads only the token's organization display claim, never the first list row. Decoding a claim is not signature verification or permission authority; the server remains authoritative.
- A successful response adopts its nonempty token through one minimal auth-store action: existing localStorage first, Zustand second, retaining the user. Storage failure leaves the prior in-memory token unchanged.
- `window.location.reload()` follows both writes, requesting reconstruction of page caches, REST data and WebSocket connections under the new token. This is not an added refresh-token/cookie/persistence subsystem.
- Pending switches disable interaction; GET/POST errors are visible; failed listing can be retried; failed switches preserve actual selection/token. An obsolete switch response cannot restore a session after logout or a token change. Obsolete list responses are ignored after effect cleanup.

Owned source: `components/OrganizationSelector.tsx`, `lib/auth-store.ts`, and their new `.test.tsx`/`.test.ts` files under `packages/dashboard/src`. No login/restore/logout implementation was rewritten, no server code changed in this subtask.

## Executed verification

Before the fix, the new eight tests failed: missing replacement action, wrong initial selection, ignored token/reload, failed pending guard, invisible refusal/malformed-response/list errors, and stale-session handling. After correction plus one storage-fault regression:

```sh
npm run test --workspace=@djimitflo/dashboard -- src/components/OrganizationSelector.test.tsx src/lib/auth-store.test.ts
# 9 passed
npm run test --workspace=@djimitflo/dashboard
# 115 passed across 24 files
npm run type-check --workspace=@djimitflo/dashboard
npm run lint --workspace=@djimitflo/dashboard
npm run build --workspace=@djimitflo/dashboard
# all exit 0
```

Tests render the actual component with real Zustand/localStorage and intercepted fetch. They assert the original bearer and requested organization in POST; one request despite repeated pending input; replacement token present in both stores before the reload callback; no token change or reload on403 or missing token; list retry; late response after logout; and storage rejection.

The reload callback is intercepted. Therefore these tests establish requested reload and correct adoption order, not a real browser reload, live tenant-data refresh, cross-tab lifecycle or production tenant isolation. Those claims require joined server/browser evidence. No new credential or session lifetime is introduced.

## Parent integration: actual browser and server roundtrip

The actual browser subsequently logged in with a dedicated disposable audit identity, selected default, survived server restart/reload, and selected its assigned organization again. `organization-browser-{default,return}-proof.log` contains only the observed selection, token organization claim and available choices, never a raw bearer. `organization-browser-db.json` independently asserts both correct canonical audit transitions and unchanged durable membership. The final console contains only known automation `data:,` CSP refusals. `node reports/autonomous-audit-20260909/evidence/session-conversion-proof.mjs organization` repeats the read-only evidence assertions.

Parent also repaired two actual server siblings: GET organizations must enumerate current membership plus default, not only the currently selected context (otherwise default hides the return choice); audit.from must use the selected request context, not the assigned membership. `organization-return-red.log` and `organization-audit-red.log` each preserve a failing actual HTTP/SQLite assertion. `auth-principal-verified.log` passes58checks including the return list, two switch audit transitions and stale-membership rejection.

This proves the token/context and audit workflow, not row-level tenant isolation in every API or multi-tenant WebSocket delivery. No new membership/authority model was added.
