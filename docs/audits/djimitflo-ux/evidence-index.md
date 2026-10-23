# Evidence index and reproduction

## Saved visual evidence

All 12 PNGs were captured from Safari and visually inspected. Images show a real authenticated desktop session, not mockups. Browser chrome includes other tab titles; unrelated tab contents were not used as audit evidence. Capture is a visible-window state, not full-page or network trace. Screenshots are distinct snapshots and may not match the frozen DB count exactly.

| File | Route / reproduced state | What it proves / does not prove |
|---|---|---|
| [01-cockpit.png](01-cockpit.png) | `/`, loaded overview | Process/status/guardrail distinctions and outcome honesty; not correctness of every card |
| [02-failed-loop-evidence.png](02-failed-loop-evidence.png) | `/goals-loops`, selected170a58d4… and scrolled review | Existing failure narrative/checker-dispatch context; no execution initiated |
| [03-configuration-filter.png](03-configuration-filter.png) | `/configuration`, filter LOOP_CHECKER_RUNTIME | Working filter, hermes effective env, masked catalog/global guidance; not DB/default precedence |
| [04-task-review.png](04-task-review.png) | `/tasks/loop-worker-9adc00ca-872e-4ce4-87a3-315dffe8bdfc-33107fd4/review` |80 events/20 errors/26 tools and summary overlap; not 20 independent failures |
| [05-agents-layout.png](05-agents-layout.png) | `/agents`, long role cards | Actual overflow/zero-sample/connection labels; AX omission was not a blank page |
| [06-governance-scale.png](06-governance-scale.png) | `/governance`, scorecard |93.00 under 0–5 scale; source/DB establish incompatible measurement cause |
| [07-audit-loop-filter.png](07-audit-loop-filter.png) | `/audit?tab=logs`, Loop selected | Empty body/Next enabled; DB establishes records actually exist under loop_run |
| [08-evolution-gates.png](08-evolution-gates.png) | `/evolution`, Realm Gates | Unknown/red/sample requirements, no valid readiness claim |
| [09-federation-recovered.png](09-federation-recovered.png) | `/federation`, fresh load | Recovered page,0 peers/34 local capabilities; no network peer capability proof |
| [10-interaction-relations.png](10-interaction-relations.png) | `/interaction-board`, Relations selected |500 loaded/276 threads/79 relations, filters and tab; relation table below fold verified through AX |
| [11-public-explainer.png](11-public-explainer.png) | `/explore/djimit/djimitflo` | Malformed badge/Markdown fence and public generated content; no publication/change made |
| [12-health-false-zero.png](12-health-false-zero.png) | `/self-healing`, Run Health Check | Read-only result 0 stale/0-of136failure, DBsize 523.8 MB; normalized DB query disproves stale zero |

## Runtime and database artifacts

- [runtime-evidence.json](runtime-evidence.json): selected Docker inspect and container health fields; image ID/build SHA. Process/build identity, not universal functional proof.
- [db-evidence.json](db-evidence.json): retained 19:57:52Z aggregate SQL/parameter/results snapshot. No prompts, descriptions, credentials or raw user rows exported. `verification_hours.summary` retains n/upper median.
- [panel-review-evidence.json](panel-review-evidence.json): follow-up 20:17:40Z panel status/review coverage/recent creation data.195 unreviewed default consensus states; 242 goal_created includes 192 unreviewed.
- [panel-lane-evidence.json](panel-lane-evidence.json):20:18:53Z EXISTS-based count; all 192 unreviewed goal-created panels have a current oracle-lane approval reference. EXISTS avoids shared-panel proposal multiplicity.
- [route-api-inventory.json](route-api-inventory.json): AST extraction of 50 dashboard declarations/49 distinct patterns and 7 public Explore endpoint patterns, component/import/API call sites. Dynamic expressions remain source text; no HTTP success inferred.

To refresh the main aggregate snapshot, with existing authorized SSH only:

```sh
ssh vps-agentical 'docker exec -i djimitflo-live node --input-type=module' \
  < docs/audits/djimitflo-ux/collect-db-evidence.mjs \
  > /tmp/djimitflo-audit-db-refresh.json
```

This opens `/data/djimitflo.sqlite` with readonly/query_only and prints safe aggregates. Inspect errors and compare timestamps; do not overwrite retained evidence without an explicit new audit snapshot. SQL for panel follow-ups is embedded in their JSON artifacts and can be rerun with the same read-only wrapper. No credentials/new access are needed.

To regenerate static wiring, provide an existing checkout of the recorded exact SHA and use the workspace's installed TypeScript (no dependency install):

```sh
node docs/audits/djimitflo-ux/collect-source-inventory.mjs \
  /path/to/exact-source-checkout /tmp/djimitflo-route-inventory.json
```

The script asserts Configuration, Review, Audit fetch wiring and public route count. It follows static relative imports; dynamic import/callback binding and shared bootstrap/WS sources require human review. It inventories linked Explore public routes, not every backend endpoint.

## Exact-source anchors

[Engineering correlation](engineering-correlation.md) explains framework/state/API/test implications; the table below pins individual observations to source.

All paths refer to **be0b3ab05b8f2cd2e676ea6ceddf4f2140ae6fb6**, reviewed from isolated `/private/tmp/djimitflo-audit-src.fLJTl1`. Do not interpret current dirty checkout content as identical evidence. Prefixes: D=`packages/dashboard/src`, S=`packages/server/src/services`, R=`packages/server/src/routes`.

| Source / line or symbol | Finding established |
|---|---|
| D/App.tsx:48 DataLoader; route declarations 89–151 | Bootstrap Promise.all/console-only error; full route wiring and outer Suspense |
| D/pages/GovernanceScorecardPage.tsx:5,52,96 |≥4 green; 0–5 label; raw score rendering |
| S/openmythos-eval-service.ts:591,732,764 | Latest/raw cross-agent leaderboard vs existing model-only eligibility filter |
| S/explainer-generation-service.ts:219–241; explainer-critic-service scoring contract | Critic 0–100 score inserted into shared eval table |
| S/self-healing-service.ts:57–90,111,226–233 | Mixed datetime text comparisons, fixed size threshold, shared repair predicate |
| `packages/server/src/execution/executors/opencode-executor.ts`:428 step_finish | Non-stop/complete includingtool-calls→TASK_FAILED/ERROR |
| S/improvement-funnel-service.ts:54,108–164 | SQLerrors→empty, all consensus count, status-based cohorts, LIMIT12 total, median/window |
| D/pages/ImprovementFunnelPage.tsx:49 | Current-status refinement numerator excludes terminal no_change/regressed/archived |
| S/specialist-panel-service.ts:328–366,715 | createPanel initializes default no-consensus/needs_more_evidence JSON |
| S/self-improvement-service.ts:220–278,482 | Explicit oracle skip/authorization; regressed/verified allowed transition sources |
| D/pages/AuditLogViewer.tsx:25–51,76–86, paging block | Exact loop filter value, export scope and offset/hasMore gaps |
| R/mcp.ts:85–137 | refresh GET writes probe timestamps/status and can sync missing tools |
| S/runtime-config-view.ts:7–24; R/health.ts:249 | Redacted process.env projection, not default/DB resolver |
| S/meta-orchestration-service.ts:180–227,402–495; S/loop-service.ts:1589,1605,1614 | Heuristic tuning confidence, active DB config/audit, process-local counters, real consumers |
| S/service-map.ts:10–67 | Configured targets, unauthenticated bounded probe,60 s cache,429→up |
| S/stall-watch.ts:192–194; D/lib/format.ts:15–18 | Experiment deadline used as since; negative elapsed age falls into<1 h |
| S/experiment-registry.ts experimentsReport | Existing target/deadline/verdict/WIP/mode/protocol registry, no new subsystem needed |
| S/provenance-dag.ts exported provenanceDag; R/health.ts:238 | Existing explicit evidence DAG; endpoint `/health/provenance-dag`, edge cap 2000 |
| D/pages/OperatorCockpitPage.tsx:18–21,150–153,218–230 | Digest/efficiency mount-time,30 s poll/service map separate |
| D/components/ExecutionTimeline.tsx:125–127 | View Artifact styled div without click/link |
| D/pages/AgentsPage.tsx:12–20,154–212; ReviewPage summary grid | Agent detail exists; 0/0→0%; card/summary layout boundaries |
| D/components/GlobalErrorBoundary.tsx:13–29; D/lib/chunk-reload.ts | Existing automatic one-reload chunk recovery and Retry; no proven permanent Federation outage |
| S/cognitive-loop-closure-service.ts:449–470 | Deduplicated episode stats and observational success |
| R/swarms.ts:428 economy/allocate | Read-only recommendation, not budget dispatch |
| R/explore-public.ts:33–146; S/explore-public-page-service.ts:315 | Additional public routes; model-only public leaderboard; minimal Markdown rendering |

## Verification performed and threats to validity

Both evidence collectors' assertions passed. The retained DB JSON contains no query errors. A local Python SQLite **in-memory** assertion confirmed an ISO 08:00 timestamp compares incorrectly as text against same-day 19:00 space-datetime but correctly with julianday; no production fixture inserted. Documentation/artifact links, route counts and metric reconciliation were checked locally. Existing application tests were source-reviewed only; no test suite was run against production and no deploy occurred.

Selection is purposive, one admin/org/desktop/time period. Native AX/UI and direct DB snapshots differ in time, and browser requests were not captured with CDP; UI→API mappings are source correlation, not complete request traces. Recent panels/usage can change while auditing. Counts establish stored states, not causal effectiveness. A failed task sample does not estimate platform-wide failure rate; success transport flags do not prove solved tasks. Partial/silent query failure is itself a finding; never interpret missing evidence as zero health risk. Recommendations remain hypotheses about efficiency until measured acceptance tests pass.

## Acceptance coverage ledger

| Requested criterion | Evidence / status |
|---|---|
| Accessible navigation inventory / major pages |37 nav destinations visited; 49 dashboard patterns/7 public endpoints inventoried; contextual entities sampled, agent detail source-only |
| Relevant operator journeys |Task/loop/config/audit/interaction/proof paths exercised; proposal-specialist, real spike and causal-gain journeys remain partial/unanswerable with current UI evidence |
| Core semantic metrics |Funnel/governance/health reconciled by DB+deployed source; other major families contracted, not every small counter recomputed |
| Configuration/integration health |Important surfaces inspected; external auth/provider internals/current every-capability E2E unknown |
| Logs/diagnostics |Local review, threads, audit/authority and source DAG assessed; retention/replay/SSE reconnect unproven |
| Major frontend functions |32 named action cases in C; mutation chains, some safe controls/exports and failure branches explicitly untested |
| Implementable recommendations/architecture/security |17 prioritized items, existing components/services, alternatives/risks/tests; current boundaries preserved |
| Complete platform verification |**Not claimed.** Read-only/access/method coverage limits above remain; artifacts are the bounded audit result, not blanket E2E certification |
