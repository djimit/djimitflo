# Engineering correlation and test assessment

Source reviewed at `be0b3ab05b8f2cd2e676ea6ceddf4f2140ae6fb6`, matched to running build/image. The local dirty branch was not treated as deployed authority. Package versions below describe this source manifest, not a separately audited installed dependency tree.

## Framework and data flow

The npm workspace monorepo has a React19 dashboard, React Router7, Vite8, Tailwind4, Zustand5 and TypeScript strict/ESM. Server is Express5 with better-sqlite3 and ws; shared TypeScript contracts are imported from `@djimitflo/shared`. Vitest is the existing test runner; dashboard build runs tsc then Vite. No framework migration is justified by the observed defects.

Data enters the dashboard through several existing paths:

- App DataLoader fetches Tasks/Agents together into Zustand, with WebSocket updates thereafter. One Promise.all failure prevents both initial writes; catch only logs. Agents has its own empty-store REST fallback, Tasks list does not. This is a source-confirmed resilience risk, not a live injected-outage result.
- `useResource` already handles data/loading/error/refresh/poll, sequence-guards stale responses, keeps last good data on error and invalidates in-flight updates on unmount. Reuse it where independent page loaders repeat this need; do not add a new request-state framework.
- Some pages still use direct mount effects and `softFail`/LoadErrorNotice. Cockpit uses separate digest, efficiency, service-map and cockpit lifecycles, plus30s polling/events. A global Refresh therefore need not refresh all visible values. Metadata must describe each resource's own as-of and failures.
- `api.ts` and authenticatedFetch apply the production `/api` base/session mechanism. Generic get/post/request callbacks remain dynamic expressions in the AST inventory. Source wiring is not captured browser request evidence, and a matching route does not prove downstream business correctness.
- Public Explore pages are server-rendered generated bundles outside the SPA/authenticated shell, intentionally public only for published records. Their seven endpoints are included separately. Their model-only public leaderboard has eligibility filtering that the authenticated scorecard lacks.

## Existing composition worth preserving

GovernanceHub already composes scorecard, assurance/spec evidence and improvement inbox. AuditHub composes Trail/Log viewer; legacy routes redirect instead of duplicating screens. Goals & Loops review bundles, Task Review, proof detail, Interaction Board and provenance DAG are complementary evidence surfaces. They should be connected, not replaced by another orchestration/log/config subsystem.

Several screens independently fetch swarm status (Swarm, Resources, Fleet Cockpit, Mission Control) because they serve different tasks. That is repeated retrieval, not proof their components should be merged. Activity overview overlaps the newer Cockpit, but unique spec/activity functions must move before retirement. Agent Catalog, agents, registry agents, skill cards, social identities and federation capabilities are distinct contracts; physical consolidation could destroy useful boundaries. No exhaustive dead-code or clone analysis was performed, so obsolete implementation is not asserted from an unpopular-looking route.

The backend already exposes provenance DAG, scheduler health, forecasts, value allocation, skills and experiment evidence. Some endpoints have no clear contextual UI discovery in the inspected pages; `/health/provenance-dag` is the strongest example. Training/config/advanced endpoints can require manage:config; exposing them must preserve current roles. No inference that every backend endpoint needs a new page.

Confirmed frontend affordance without behavior: ExecutionTimeline View Artifact is a styled div without a handler/link. Conversely, Pipeline drafts explicitly has no execution backend, Catalog explicitly distinguishes prepared artifacts from runtime dispatch, MCP explicitly says catalog decisions are unenforced, and proof completion explicitly is not certification. These are honest scope boundaries, not automatically missing implementation defects.

## Error, loading and caching behavior

Outer Suspense wraps the routes/shell; lazy loading can temporarily replace navigation with Loading. GlobalErrorBoundary already detects chunk failures and invokes bounded reload logic; Retry reloads. Federation recovered in this audit, so cache/deploy mismatch remains an unproven hypothesis. Preserve recovery and test stale-chunk behavior rather than adding a duplicate boundary.

Service-map probes cache60s; statuses measure transport. Runtime config is masked process.env projection. Improvement-funnel optional-table catches convert query errors to empty rows/zeros, while newer provenance/stall detectors explicitly carry errors/UNKNOWN. Follow the stronger existing pattern. Audit Log viewer has exact-filter/value, paging and export-scope defects; these are local contract repairs, not a logging architecture rewrite.

## Tests: what exists and why defects can survive

| Suite inspected | Existing useful coverage | Additional case supported by this audit |
|---|---|---|
| server `self-healing.test.ts` | Checks, stale lease, failure rate, memory and heal stats | Stale fixture uses SQLite datetime(now,−48h), failure fixture same SQL format. Neither reproduces same-date production ISO T/Z comparison; add that exact boundary and both scan/repair predicates |
| server `improvement-funnel.test.ts` | Empty/source conversion, judgment agreement, yield/zombie counts, skill-outcome cost, panel specialist calibration | Initial unreviewed consensus vs actual reviews/oracle lane, archived refinements with linked goals, metadata-only updates,>12work groups, query error vs healthy zero |
| server `opencode-executor.test.ts` | CLI arguments, JSON parsing, tool mapping, verification grounding, metric extraction | Full tool-calls continuation stream vs true terminal task result; assert event/count semantics, not only parsed JSON shape |
| server `openmythos-eval-service.test.ts`; dashboard GovernanceScorecardPage test | Existing score/run and page behavior | Mixed critic/model scale/corpus, eligible cohort ranking/trend and out-of-range presentation |
| server `service-map.test.ts` | Env targeting/credential stripping,404reachability,5xx/error/cache/timing |429must not imply healthy business capability; transport/auth status separate from relevant success |
| server runtime-config/provenance/stall/meta-tuning-chain suites | Existing masking, explicit edges, detector states, bounded applied tuning path | Per-key effective precedence, target-reached before future deadline, preserved UNKNOWN/cap scope and run-linked overrides |
| dashboard GoalsLoopsPage/TaskRuntime/ReviewPage/useResource/chunk-reload tests | Existing runtime/detail/loading/race/reload contracts | Cross-entity navigation, long-ID responsive fixtures, partial dependency failure, artifact link, stale-chunk recovery retaining useful navigation |

No coverage percentage was collected. Test existence and even passing assertions would not validate the live cohorts above. Application suites were **not executed** during this docs-only audit; no test/build/dependency install was run on production. Audit collectors' assertions, isolated SQLite time reproduction and local artifact/reconciliation checks did run. The backlog specifies targeted isolated regression tests for future repairs using existing conventions.
