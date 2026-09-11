# Catalog UI tranche — 2026-09-09

Scope: catalog filtering and artifact-preparation controls only. Source ownership: `useCatalog.ts`, `AgentCatalogTable.tsx`, `AgentCatalogPage.tsx`, their test files and the explicitly delegated `ApiClient.getCatalogAgents` method. No server, provider or master-report edits by this agent.

## Corrections

- Clearing search now requests the unfiltered catalog. Search and division controls reflect the same mutually exclusive state.
- Division options come from the complete catalog response and survive filtered or empty results. Controls stay mounted during loading, errors and empty results.
- Request ownership rejects stale responses. After a mutation completes, refresh uses the current filter rather than its earlier closure.
- GET errors remain visible with previously loaded rows, explicitly label those rows stale, and offer Retry. Loading/unavailable states do not claim that nothing was imported.
- Per-agent in-flight guards prevent repeated activation/deactivation requests, disable the corresponding button and release on failure or completion. Errors remain visible and retryable.
- Existing activation APIs receive the selected OpenClaw/Codex artifact target. Labels describe artifact preparation and explicitly disclaim runtime registration, provider startup or work dispatch. Ranked search is labeled as up to20 results.
- Actual browser execution found an additional shared-client defect: optional `division: undefined` became literal `?division=undefined`, returning zero rows despite counts showing two imports. The client now omits undefined/empty filters; actual-client fetch regressions also cover selected division/status preservation. Hook avoids passing an absent filter explicitly.
- Static verdicts with no measured score display `passed/rejected — score unavailable`, never invented100 or misleading `Not evaluated`. Preparation requires a current passed verdict; the rejected fixture's button is disabled.

## Executed checks

- Final targeted catalog tests:21/21 passed across two files, including real-client request serialization and hook tests.
- Final full dashboard suite:77/77 passed across20 files at12:53:15 local; `catalog-ui-tests-final.log`. Earlier73-test log predates browser-discovered corrections.
- Final dashboard build/type-check, dashboard lint and `git diff --check` passed; built index-Blf0Mg3z.js for browser execution.

## Actual browser and database proof

Local3187, isolated standalone session `catalog-audit`, existing synthetic admin, parent-imported fixtures `engineering-secure-coder` (passed) and `security-helpful-assistant` (rejected). Browser discovery returned no connected in-app browsers; documented standalone fallback used. No production/provider actions.

- Selected Codex, clicked Prepare artifact: actualPOST200, compiled `agent.toml` persisted in `.data/agent-catalog.sqlite` and catalog audit recorded target/evaluation. Reload showed Target: codex. Read-only DB evidence: `catalog-ui-codex-db.json`; request29 in `catalog-ui-requests.log`. A later successful Codex retry captures full response and reload in `catalog-ui-mutation-error.log` and `catalog-ui-final-deactivate.log`.
- Deactivated Codex through UI withPOST200 (`catalog-ui-deactivate-codex.log`); prepared OpenClaw through UI withPOST200 (`catalog-ui-openclaw.log`). Read-only DB contains compiled SOUL.md/AGENTS.md/IDENTITY.md (`catalog-ui-openclaw-db.json`). ReloadGET200 showed active target, static verdicts without scores and rejected button disabled (`catalog-ui-reload.log`). Desktop screenshot: `output/playwright/catalog-artifact-prepared.png`.
- Engineering division yielded only Secure Coder while both division options remained. Search Secure returned the matching profile. Clearing search returned both actual profiles with no literal undefined query (`catalog-ui-filters.log`).
- Browser-only injected searchGET503 exposed exact error plus explicitly stale existing rows; removing interception and clicking Retry returned200 (`catalog-ui-get-error.log`). Browser-only injected preparationPOST503 kept inactive state and retry enabled; removing interception and retrying produced actual CodexPOST200 (`catalog-ui-mutation-error.log`). These injections are not genuine server outages.
- Final UI deactivationPOST200 and subsequent reloadGET200 show inactive catalog activation. Final deactivation observation had page errors[] and failed API responses[] (`catalog-ui-final-deactivate.log`, `catalog-ui-final-refresh.log`). Expected automation CSP `data:,` probes and the two deliberate503 responses are separately visible in browser console; CSP was not weakened.
- Read-only final DB proof (`catalog-ui-final-db.json`): activation status deactivated, prior Codex target/compiled artifact retained as provenance, both measured scores null, rejected fixture never activated, auditseq1–8 contains two imports and three matched preparation/deactivation cycles. Core runtime `agents` table has no rows matching either fixture identity or name. No registration or dispatch claim is inferred from catalog activation.
-360px follow-up measured actual element bounds after a fresh navigation: prior summary/description clipping was not reproduced (`catalog-mobile-widths-before.log`, screenshot `catalog-mobile-before-fresh.png`). No shared Layout defect was established. The search input did measurably shrink to133.5px beside the division control, so its existing wrapper now takes a full mobile row while retaining desktop flex layout. After rebuilding, all description/card/input/select bounds are within32–328px, no measured content overflow, and search width296px (`catalog-mobile-widths-final.log`). Wide table intentionally retains its own horizontal scroll (294px viewport /516px content). Final screenshots `output/playwright/catalog-mobile-final.png` and `catalog-mobile-controls-final.png` were visually checked. This verifies the bounded360px layout, not exhaustive mobile touch QA.

Mobile follow-up verification:21/21 targeted catalog tests passed at12:59:26 local; dashboard build/type and lint passed. Final index-D0H_f8Sx.js. Only one existing CSS-class list changed in AgentCatalogTable; no catalog mutations or shared Layout changes.

Instrumentation limits: initial Codex response-capture attempted to read a response after navigation and failed; `catalog-ui-codex.log` records that harness error, not an activation failure. A planned delayed deactivation failure injection used unsupported CLI `setTimeout`; interception failed and real deactivation200 occurred. That attempt is not counted as failure-handling proof. The subsequent immediate preparation503 injection is the valid mutation-error proof. No provider execution, artifact deployment to runtime directories, or model compatibility is claimed; compiled Codex template remains the existing artifact format, not an executed Codex session.
