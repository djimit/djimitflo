# DjimitFlo full-platform forensic audit

Audit date: 2026-10-23 (Europe/Amsterdam)  
Production target: `https://djimitflo.agentical.nl`  
Production artifact: `djimitflo:main-be0b3ab`, full SHA `be0b3ab05b8f2cd2e676ea6ceddf4f2140ae6fb6`  
Audited role: authenticated admin in the default organization  
Method: Safari computer-use inspection, production container and SQLite read-only queries, exact-production-SHA source review.

## Evidence levels

- **LIVE PROVEN**: rendered in the authenticated production UI or read from the running container/database.
- **END-TO-END PROVEN**: a safe action was followed through request, state change and UI feedback. No mutating action was authorized, so this tier is intentionally rare.
- **SOURCE PROVEN**: exact deployed SHA implementation or test evidence.
- **INFERRED**: explanation supported by correlated evidence but not causally reproduced.
- **NOT TESTABLE**: mutation, destructive behavior, external dependency internals, mobile/responsive hardware, or an inaccessible detail route.

## Deliverables

1. [A-platform-inventory.md](A-platform-inventory.md)
2. [B-ux-ui-forensic-audit.md](B-ux-ui-forensic-audit.md)
3. [C-functional-verification-matrix.md](C-functional-verification-matrix.md)
4. [D-data-metrics-audit.md](D-data-metrics-audit.md)
5. [E-configuration-integration-audit.md](E-configuration-integration-audit.md)
6. [F-observability-diagnostic-journeys.md](F-observability-diagnostic-journeys.md)
7. [G-target-experience-architecture.md](G-target-experience-architecture.md)
8. [H-prioritized-backlog.md](H-prioritized-backlog.md)
9. [I-executive-assessment.md](I-executive-assessment.md)

## Coverage and constraints

All 22 top-level navigation destinations and all 17 Lab destinations were opened. Routes with identifiers were inspected through their parent lists but were not exhaustively enumerated. Safe read-only filters, navigation, refresh and one stale-bundle Retry were exercised. Create, approve, deny, requeue, label, configure, execute, allocate, run-proof, scheduler, health-check and policy-toggle controls were not activated because they mutate production. Safari's accessibility tree occasionally captured a preceding lazy route while a new route loaded; such observations are not treated as page evidence. Screenshots were captured through computer use for the cockpit, Decisions and persistent lazy-module failure; the environment did not expose a file export path, so this audit references the captured states rather than committing image files.

The checked-out workspace was dirty and not production (`9946ea4`; local `origin/main` `a9979610`). It was left untouched except for this new audit directory. Production source was reviewed from an isolated checkout of the exact deployed SHA.

## Verification note (2026-10-23, after the audit)

- DF-01, DF-02, DF-03 and DF-05 confirmed in source on `be0b3ab0` (`improvement-funnel-service.ts:123-165`, `stall-watch.ts:194` uses `stop_by` as `since` even when an experiment is overdue by reaching its target before that date). Fixes follow in a separate PR.
- DF-06 not reproduced on the live build: `FederationPage-DzTK1yZS.js` and its imports (`globe`, `index`, `jsx-runtime`) return 200 `text/javascript`; `index.html` is sent with `Cache-Control: public, max-age=0` + ETag, so browsers revalidate it. The persistent failure is most consistent with a stale Safari tab (the audit's own noted risk). If it recurs, record the failing chunk URL from the console.
