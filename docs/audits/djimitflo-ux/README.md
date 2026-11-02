# DjimitFlo platform forensic audit

Audited 2026-10-23, authenticated admin/default organization, Safari, `https://djimitflo.agentical.nl`.

**Assessment: substantial operational capability, uneven trustworthiness of its summaries.** The highest-risk confirmed defects are incompatible governance score scales and timestamp comparisons that hide stale leases. Existing review bundles, provenance queries, interaction correlation and uncertainty labels provide a strong foundation; extend them before adding systems.

## Deliverables

| Artifact | Contents |
|---|---|
| [A. Platform inventory](A-platform-inventory.md) | Navigation, routes, capabilities, APIs, coverage |
| [B. UX/UI audit](B-ux-ui-forensic-audit.md) | Page findings, HCI consequences, screenshots |
| [C. Verification matrix](C-functional-verification-matrix.md) | Exercised actions and bounded verdicts |
| [D. Metrics audit](D-data-metrics-audit.md) | Definitions, SQL reconciliation, lifecycle semantics |
| [E. Configuration and integrations](E-configuration-integration-audit.md) | Effective settings, dependencies and diagnostic gaps |
| [F. Observability and journeys](F-observability-diagnostic-journeys.md) | Actual paths, correlation, dead ends |
| [G. Target architecture](G-target-experience-architecture.md) | Changes consistent with existing implementation |
| [H. Implementation backlog](H-prioritized-backlog.md) | Priorities, alternatives, risks, tests, acceptance |
| [I. Executive assessment](I-executive-assessment.md) | Consequences and implementation sequence |
| [Evidence index](evidence-index.md) | Saved screenshots, source anchors, reproduction, limitations |
| [Route/API inventory](route-api-inventory.json) | Exact-SHA static component/API wiring; 50 route declarations and 7 additional public Explore endpoints |
| [Database evidence](db-evidence.json) | Timestamped aggregate queries, parameters, results and errors |
| [Panel review evidence](panel-review-evidence.json), [lane evidence](panel-lane-evidence.json) | Default consensus states and explicit oracle approval linkage |
| [Runtime evidence](runtime-evidence.json) | Container/image/build identity |
| [Methodology](methodology.md) | HCI rubric, measurement validity and accessible-use limits |
| [Engineering correlation](engineering-correlation.md) | Framework/data flow, reuse, loading/errors and test blind spots |
| [Artifact checksums](SHA256SUMS) | SHA-256 manifest of retained audit files; integrity check, not a signed attestation |

## Method and confidence

Production is container `djimitflo-live` on `vps-agentical`, image `djimitflo:main-be0b3ab`, source `be0b3ab05b8f2cd2e676ea6ceddf4f2140ae6fb6`. The running health response reports matching built/declared commit. Source was reviewed in an isolated checkout of that SHA. The dirty working checkout (`9946ea4`) was preserved; application code, configuration, deploys and existing user files were not changed.

**LIVE** means rendered browser evidence or a read from the current container/database. **SOURCE** means deployed-SHA implementation evidence. **INFERRED** means a hypothesis not causally reproduced. **NOT_TESTABLE** describes an audit boundary, not a defect. A WORKING verdict applies only to the named action and observed case. No write workflow is claimed end-to-end proven.

All **20 primary and 17 Lab navigation destinations** were visited. Task, review, repository, expert and proof detail samples were inspected; agent detail remains source-covered. One linked public repository explainer was inspected. There are 49 distinct dashboard route patterns: 37 navigation destinations, 6 contextual detail patterns, 4 aliases, login and wildcard. The root layout plus root index explains the 50 declarations. This is not exhaustive testing of every entity, action, permission role, error branch or metric card.

Safe interactions included search/filter/tab changes, refresh, task/review navigation, expert/proof detail navigation, a read-only health scan and an economy recommendation. Read-only SQLite connections used `readonly` and `query_only`. No approve/deny/requeue/execute/heal/configure/register/publish/deploy action was invoked. **Boundary exception discovered:** MCP page loading automatically requests `GET /mcp/servers?refresh=true`; its handler updates probe status and can import a missing tool catalog. Thus ordinary browsing is not strictly free of metadata writes. This is documented as a product defect, not concealed as a mutation-free run.

## Corrections to the preliminary assessment

The earlier assessment overstated completion and several findings. This pack supersedes it. Panel goal rate is arithmetically correct for stored consensus states, but follow-up found 195 unreviewed defaults counted as decisions; 192 goal-created panels have oracle-lane approval references. Unreferenced panels are not proven unrelated. Refinement 0% counts current statuses, whereas 18 children historically linked to goals. Federation recovered on recheck. Configuration already has a working filter/restart guidance. Interaction Board has populated correlation views. Existing provenance/review services must be reused. The earlier 7-panel/24 h and future-row claims came from an invalid ISO-versus-SQLite text comparison and are withdrawn; normalized queries are retained here.

## Coverage limits

Production mutation E2E, external-provider internals, every detail record, mobile/touch/multiple viewport sizes, assistive-technology task completion, instrumented contrast, browser network/performance traces, fault injection, scheduler-to-durable-gain causality and all small Lab metric calculations remain unverified. Existing application tests were inspected, not executed against production. Database and browser observations are separate live snapshots, not one transaction. See A/C/D and the evidence index for specific boundaries.

## Repository note (2026-10-23)

The 12 screenshots (`01-…png` … `12-…png`) referenced above are kept outside this public repository (admin UI captures, not reviewed for sensitive content). The text, scripts and aggregate `db-evidence.json` are complete. Items already fixed after this audit: funnel truth + future stall time (#974), integration state ladder (#975), configuration provenance (#976).
