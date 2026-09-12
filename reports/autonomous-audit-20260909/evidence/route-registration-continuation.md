# E2: actual API registration, source declarations and bounded HTTP proof

Scope: isolated audit worktree, disposable in-memory SQLite and local HTTP fixtures. No server3187 restart, production writes, provider calls, or external webhook changes.

## Proven defects and correction

- Original inventory considered any mount middleware authentication. A no-op middleware regression failed: `authenticated: true` for a public route. Inventory now recognizes the existing explicit `requiresAuth` marker, not middleware count/name. This remains declared auth metadata, not universal authorization proof.
- Original OpenAPI collector omitted direct aggregator routes and all four nested swarms routers. Existing `RouteMount` registration now records prefixes against actual Express layers through `mountRoutes`; collection traverses real stacks, includes direct routes and aliases, and rejects unrecorded nested routers rather than silently dropping them. Domain handlers and mount order are unchanged.
- Static regex missed array paths, direct aggregator routes, repeated factory aliases and return-wrapper factories. The existing installed TypeScript parser now reconstructs these declarations and imported mount relationships. Unresolvable source constructs are explicit and fail the comparison.
- Eight source declarations are outside the API mount graph: seven `/explore` routes mounted separately by startup, and the GitHub webhook factory found only in its standalone tests, not startup. This is not eight missing API implementations. GitHub webhook production reachability remains unproven/unmounted; no webhook was activated.

## Executed evidence

- `route-inventory-runtime-red.log`: 2 failed / 2 passed, proving auth metadata and omitted direct-route defects.
- `route-inventory-fixture-health-red.log`: intermediate fixture error, not a product defect: `/api/health` is intentionally public; the protected probe was corrected to `/api/health/deep`, while public health is asserted 200 separately.
- `route-inventory-runtime-final.log`: 9 passed across actual registration/OpenAPI HTTP fixture, role permission vocabulary contract, and OpenMythos status HTTP projection.
- `route-source-inventory-test.log`: 4 passed; synthetic source fixtures cover array/alias/return-wrapper paths, ignored comment/unused factories, unresolved computed paths, both registration mismatch directions, and dynamic client uncertainty.
- `route-inventory-type-check.log` and `route-inventory-lint.log`: pass.
- `route-runtime-registration.json`: 610 explicit instantiated API method/path records, 610 distinct keys; anonymous 401 checks for OpenAPI, deep health, OpenMythos status, tasks and nested swarm scheduler. Public version/basic health and authenticated OpenAPI return 200. No tasks created.
- Superseding auth-boundary sweep: `route-inventory-all-auth.log` has 9/9 tests green; `route-runtime-registration-all-auth.json` records **604/604 auth-marked API registrations individually requested and rejected with HTTP 401**, including concrete fixture parameter substitutions and response error codes. There are 610 total registrations and six unmarked exclusions: login, logout, refresh, basic health, version, Telegram webhook. Unmarked does not mean unrestricted: session and webhook endpoints have different credentials/guards, covered separately by their own tests. Provider fetch is forbidden; engine/operator runtime are disabled. Fresh identical router instances on the same disposable DB every 100 probes preserve actual rate limiters without having their 300/min window mask later authentication with 429. No proxy spoofing or limiter bypass; this is not a burst/rate-limit test. `route-inventory-all-auth-lint.log` passes.
- `contract-inventory-runtime.json` / `.log`: runtime/source comparison has zero missing or phantom API registrations and zero unsupported source declarations. 577 source declarations expand to 610 mounted records through aliases/nesting. Legacy static references: 245 routes, 194 module-only, 136 unclassified, 2 explicit exemptions; zero critical unclassified after the status projection test. MCP 56 declarations / 28 static references, not new MCP execution proof.
- `contract-inventory-runtime-all-auth.json` / `.log` repeats that comparison against the complete 604-route auth sweep; the earlier five-probe artifact remains historical, not silently upgraded.
- Dashboard API-class comparison: 100 registered method/path matches, 22 dynamic unresolved expressions, zero definite missing matches. Other direct fetch clients, auth channels, response shapes and domain outcomes are not covered by this matcher.

The two newly exposed critical OpenMythos status routes were not greened using 401 or registration assertions. Their real HTTP tests read seeded SQLite runs and verify no-evidence, per-agent filtering, latest global run, failure superseding historical completion, null failed scores, corpus/certification holds, incomplete-run inadmissibility and no fallback for an absent agent. These are **status projection** semantics only. Seeded metadata is fixture data, not certified evaluation evidence; no judge/provider was run and no corpus authority changed.

## Reproduce

```sh
RUNTIME_ROUTE_INVENTORY_PATH=reports/autonomous-audit-20260909/evidence/route-runtime-registration-all-auth.json npm run test --workspace=@djimitflo/server -- route-inventory.test.ts openmythos-status-http.test.ts route-permission-contract.test.ts
RUNTIME_ROUTE_INVENTORY_PATH=reports/autonomous-audit-20260909/evidence/route-runtime-registration-all-auth.json CONTRACT_INVENTORY_PATH=reports/autonomous-audit-20260909/evidence/contract-inventory-runtime-all-auth.json node scripts/contract-inventory.mjs
node --test scripts/route-source-inventory.test.mjs
```

Runtime comparison requires a current route/auth source fingerprint; a changed source rejects stale evidence. Without the runtime artifact, the script explicitly reports `NOT_EXECUTED`, retaining legacy static-test fields for existing consumers. Neither those fields nor green registration comparison constitutes full functional closure.

Limits: this fixture instantiates the API with operator runtime disabled, no execution engine/providers. Explicit `/api` registrations only; startup `/health`, `/metrics`, `/explore`, static SPA fallback, and Express implicit HEAD/OPTIONS are outside this runtime map. Every auth-marked registration now has an anonymous HTTP check; role matrices, invalid/current/revoked credential variants and other authorization semantics are not exhaustive. Registered routes may still have broken domain state, response contracts, unavailable dependencies or permission semantics. The overall mission is not declared complete.
