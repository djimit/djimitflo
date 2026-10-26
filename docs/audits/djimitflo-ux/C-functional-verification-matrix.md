# C. Functional verification matrix

WORKING is specific to the action/case below. PARTIALLY_WORKING means usable output with a verified limitation. BROKEN means expected action failed. MISLEADING means output can support an incorrect interpretation. NOT_IMPLEMENTED is reserved for source-confirmed missing behavior. NOT_TESTABLE includes safe-but-unexercised coverage; the reason is explicit. SOURCE alone does not certify a live function.

| ID / action | Expected → actual | Evidence | Verdict |
|---|---|---|---|
| V01 Existing session / protected entry | Valid session opens shell/data → authenticated admin/default organization | Live browser; 01 | WORKING for this session; auth errors/other roles untested |
| V02 Navigate primary/Lab destinations | Open 37 nav destinations → settled major content/empty states, Federation recovered after earlier chunk error | A route observations; 09 | PARTIALLY_WORKING: transient chunk failure, loading shell loss |
| V03 Cockpit Refresh | Fresh cockpit values/age → updated age and sections; digest/efficiency separate source lifecycle |01; OperatorCockpitPage | PARTIALLY_WORKING: not one full-page snapshot |
| V04 Config positive filter | Find checker runtime → `LOOP_CHECKER_RUNTIME=hermes` |03 | WORKING |
| V05 Config no-match/reset | Nonsense key → explicit no matches; clearing restores groups |Live `audit-no-such-setting` | WORKING |
| V06 Task search | `knowledge-gaps` → two failed tasks, narrowed list |Live Tasks | WORKING for title query |
| V07 Task detail | Select failed task → correct task identity/status and review link |task ID in A | WORKING |
| V08 Review navigation | Click Review → same task 80 events 20 errors 26 tools,5 evidence 8 audit |04; `/evidence/review/:id` wiring | WORKING navigation; error semantics MISLEADING |
| V09 Goal run selection | Select blocked loop → review bundle, checker dispatch skipped/maker failure narrative |02, loop170a58d4-bc70-4013-96b3-3d013d63ec0d | PARTIALLY_WORKING: context lower on page, no shareable selection |
| V10 Repository detail | Select repository → path,100/100 scan health, AGENTS.md validation |314e23d9…; live/source | WORKING read view; score scope limited |
| V11 Frontier Checked filter | Narrow identities →8 checked records |Live filter | WORKING |
| V12 Expert detail | Coding agents → identity/evidence/capability distinction |`area:coding_agents`; live | WORKING read view; operational competence unproven |
| V13 Governance Assurance tab | URL tab and content change → assurance/spec cards |`?tab=assurance`; live | WORKING |
| V14 Spec evidence expansion | Open spec → L1–L7 evidence and generation time |Live 3 specs/7-of-7 display | WORKING expansion; underlying test claims not independently rerun |
| V15 Governance scorecard | Comparable 0–5 agent scores →93.00 critic alongside 4.20 |06; DB governance_scales; source writer/query | MISLEADING, P0 |
| V16 Audit tabs | Trail→Log viewer → separate log/filter UI |07 | WORKING |
| V17 Audit Loop filter | Filter loop records → empty despite 1,082 loop_run events |07; DB audit_resource_types; exact API predicate | BROKEN |
| V18 Audit empty pagination | No results should stop paging → Next remains enabled |07 + source | BROKEN exhausted-state affordance; next click not needed to establish enabled state |
| V19 Authority DENY filter | Show denied ledger →8 expiry events, no ALLOW rows in resulting sample |Live popup/result | WORKING; expiry is not human rejection |
| V20 MCP search |148 tools→query `djimit`→57 tools; clear restores |Live tool list | WORKING |
| V21 MCP inspection | Read-only inventory should not change domain state → load calls refresh=true, handler persists probes and may sync catalogs |Live Last probe; source routes/mcp.ts:85–137 | PARTIALLY_WORKING; read-only boundary violated by GET |
| V22 Interaction search/no-match | Nonsense search →0 counts and “No interactions match these filters” |Live `audit-no-such-interaction` | WORKING |
| V23 Interaction reset/Relations | Clear→500/276/79 restored; Relations renders observed actor→target rows |10; live AX | WORKING; loaded500 cap, not global graph |
| V24 Proof detail navigation | Existing proof link → count/minimum deficits and narrative |proof-1789943717354-916bc3ea | WORKING read view; completed but incomplete certification |
| V25 Federation fresh load | Render peers/capabilities →0 peers/34 candidate capabilities |09 | WORKING read view, recovered; network federation NOT_TESTABLE |
| V26 Earlier chunk Retry | Retry after module-import failure → initially same error; later fresh navigation recovered |Earlier live error; current 09; chunk-reload source | PARTIALLY_WORKING; cause and recovery mechanism unproven |
| V27 Health scan | Safe GET reports checks →0 stale healthy,0/136 failures, DBsize degraded |12; source read-only checkHealth/worktree dryRun | MISLEADING: stale predicate false-zero, window overcount |
| V28 Economy recommendation | Budget 0 → Funded 0/Deferred 0 preview |Live; GET allocate handler read path | WORKING for 0 case; no funds moved; nonzero allocation quality untested |
| V29 Pipeline Add Goal | Add in-memory node → Goal visible on canvas |Live node rendered; no save | WORKING for node creation; connection/drag/export/save untested |
| V30 Catalog empty state | No imports → explicit empty row and 0 counters |Live | WORKING empty state; activation untested |
| V31 Cognitive rendering | Stored stats/advice →282 episodes/3 patterns/2 strategies/41%, explicit advisory scope |Live + DB 282 distinct runs | WORKING display; no causal strategy benefit claim |
| V32 Process/build health | Read health identity → matching be0b3ab build, healthy container 0 restarts |runtime-evidence.json | WORKING process/identity only |

## Source-confirmed limitations not live-validated

| Function | Source finding | Classification / next validation |
|---|---|---|
| Timeline View Artifact | Styled cursor-pointer div has no click handler/link | NOT_IMPLEMENTED affordance; test artifact-bearing task in isolated fixture |
| Audit export scope | Export URL contains format only, excludes active entity/action filters | MISLEADING source contract; download scope not live-tested |
| Audit filter change/paging | Does not reset offset, Next lacks hasMore; actions sourced from current page only | BROKEN source paths; isolated multi-page fixture needed |
| Initial Tasks loading failure | App Promise.all couples tasks and agents; catch console-only; Tasks has no list REST fallback | PARTIALLY_WORKING resilience risk; dependency fault not injected |
| Agent detail | Valid-ID route filters agent cards and loads runtime-governance status | NOT_TESTABLE: not exercised, not absent |
| Pipeline save/export/edge manipulation | LocalStorage validation/export exists, no execution API | NOT_TESTABLE: not exercised; preserve existing browser draft |
| Approval filters/sort/other list filters | Controls/source present | NOT_TESTABLE: not individually exercised; not evidence of a defect |
| JSON/CSV/task/compliance export | Download implementation present | NOT_TESTABLE: content/completeness unverified |
| SSE/WS reconnect and error state | Implementation exists | NOT_TESTABLE: no network instrumentation/fault injection |
| Role-based authorization | Existing guards/permission checks retained | NOT_TESTABLE beyond existing admin session; no bypass attempted |

Production mutations deliberately excluded: create/execute/cancel tasks; create/start/step/verify/complete/override/retry/stop loops; approve/deny/requeue/label/promote; policy/server/config changes; scheduler ticks; assurance/benchmark/council/proof/debate/reasoning/prediction runs; federation registration; fleet commands; rollback; bounded tuning; publication/deployment. Their buttons are not counted as working business behavior. Future isolated E2E tests must verify request→authorization→domain effect→persistence/audit→UI feedback, including failure and retry/idempotence.
