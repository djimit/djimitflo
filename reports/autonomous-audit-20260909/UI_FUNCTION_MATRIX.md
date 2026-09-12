# Dashboard functional inventory — 2026-09-09

G388 fixes anonymous refresh noise at the shared auth boundary; login remains clean while expired authenticated sessions still surface errors. [Evidence](evidence/auth-session-repair-g388.md).

G388 confirms the dashboard auth-session repair survives the complete workspace suite (2,864 passed / 20 skipped). [Evidence](evidence/workspace-regression-g388.log).

G387 crawls all 32 authenticated local SPA navigation routes; each rendered, with only the explicitly unavailable authority ledger and expected SSE abort observed. [Evidence](evidence/browser-local-crawl-g387.md).

G386 directly validates the production login rendering and fail-closed 401 response with Playwright; authenticated dashboard actions remain unverified. [Evidence](evidence/live-browser-login-g386.md).

G385 confirms local server startup for live checks; no authenticated production-browser claim is added. [Evidence](evidence/live-identity-g385.md).

G383 adds no new browser claim; the repeated evolution check is server-side and locally verified. [Evidence](evidence/loops-self-check-g383.log).

G381 adds no production-browser claim; the metric correction is server-side and locally verified only. [Evidence](evidence/loops-self-check-g381.log).

G379 confirms no authenticated production-browser evidence became available; local route/test evidence remains the boundary. [Evidence](evidence/assurance-recheck-g379.md).

G378 re-inspects the live bundle (37 explicit React routes) and confirms anonymous shell access only; authenticated production controls remain unexercised because `/api/*` protected calls return `AUTH_REQUIRED`. [Evidence](evidence/live-github-recheck-g378.md).

G375 adds no new live-browser claim; all route declarations now have direct local test references, while authenticated production UI remains unverified. [Evidence](evidence/module-covered-routes-g375.md).

G374 adds no production-browser claim. Local authenticated route semantics, full workspace regressions and governed loop checks remain green; live authenticated UI remains unavailable. [Evidence](evidence/workspace-regression-g372.log), [Evidence](evidence/assurance-recheck-g374.md).

G333 adds no authenticated production-browser claim; current UI capability evidence remains local authenticated HTTP/SQLite with external identity gates blocked. [Evidence](evidence/verification-g333.md).

G304 adds no authenticated production-browser claim; operator resume and advisory override semantics are proven through local authenticated HTTP/SQLite only. [Evidence](evidence/intervention-route-g304.md).

G303 adds no authenticated production-browser claim; citation research and contradiction/report projections are proven through local authenticated HTTP/SQLite only. [Evidence](evidence/research-route-g303.md).

G302 adds no authenticated production-browser claim; meta stats, tuning-history, routing and strategy projections are proven through local authenticated HTTP only. [Evidence](evidence/meta-orchestration-route-g302.md).

G301 adds no authenticated production-browser claim; red-team assessment and persisted latest/history projections are proven through local authenticated HTTP/SQLite only. [Evidence](evidence/red-team-route-g301.md).

G300 adds no authenticated production-browser claim; governance-feedback analyze/stats/apply semantics are proven through local authenticated HTTP/SQLite only. [Evidence](evidence/governance-feedback-route-g300.md).

G299 adds no authenticated production-browser claim; evidence, file-change and audit-trail projections are proven through local authenticated HTTP/SQLite only. [Evidence](evidence/evidence-route-g299.md).

G298 adds no authenticated production-browser claim; legal classification, ECLI lookup and status semantics are proven through local authenticated HTTP only. [Evidence](evidence/legal-route-g298.md).

G297 adds no authenticated production-browser claim; catalog counts and evaluation summary are proven through local authenticated HTTP/catalog-SQLite evidence only. [Evidence](evidence/catalog-route-g297.md).

G296 adds no authenticated browser claim; proactive-memory promotion/top/discovery/consolidation semantics are proven through local HTTP/SQLite only. [Evidence](evidence/memory-evolution-route-g296.md).

G295 adds no authenticated production-browser claim; authority/risk/canvas semantics are proven through local HTTP fixtures only. [Evidence](evidence/risk-canvas-authority-g295.md).

G294 adds no production-browser claim; the self-hosted improvement proof is a disposable local worktree execution with Astra maker/checker roles. [Evidence](evidence/self-hosted-improvement-g294.md).

G293 adds no authenticated browser claim; usage/economy and governance-feedback semantics are proven through local HTTP/SQLite only. [Usage](evidence/usage-route-g293.md), [Governance feedback](evidence/governance-feedback-route-g293.md).

G291 adds no authenticated browser claim; memory-evolution governance is proven through local HTTP/SQLite only. [Evidence](evidence/memory-evolution-route-g291.md).

G281 adds no authenticated browser claim; cognitive learning semantics are proven only through local HTTP/SQLite. [Evidence](evidence/cognitive-evolution-route-g281.md).

G280 adds no authenticated browser claim; Apex inventory/status semantics are proven only through local HTTP/SQLite. [Evidence](evidence/apex-inventory-route-g280.md).

G279 adds no authenticated browser claim; discussion governance semantics are proven only through local HTTP/SQLite. [Evidence](evidence/discussion-governance-route-g279.md).

G278 adds no authenticated browser claim; swarm-orchestration semantics are proven only through local HTTP/SQLite. [Evidence](evidence/swarm-orchestration-route-g278.md).

G277 adds no authenticated browser claim; swarm-intel plan/evolution semantics are proven only through local HTTP/SQLite. [Evidence](evidence/swarm-intel-evolution-route-g277.md).

G276 adds no authenticated browser claim; explainer pipeline execution is proven through local HTTP/SQLite synthetic-repository evidence only. [Evidence](evidence/explainer-pipeline-route-g276.md).

G275 adds no authenticated browser claim; explainer task create/list/retrieve is proven only through local HTTP/SQLite. [Evidence](evidence/explainer-route-validation-g275.md).

G274 adds no browser claim; the advanced governance boundary is proven through local HTTP/SQLite and remains subject to authenticated UI validation. [Evidence](evidence/advanced-governance-g274.md).

G273 adds no authenticated browser claim. Advanced compression and workflow routes are proven through local HTTP/SQLite only; dashboard reachability and production behavior remain separately classified. [Evidence](evidence/advanced-route-validation-g273.md), [Browser boundary](evidence/browser-availability-g267.md).

G272 proves the observability backend projections locally (metrics, trends, policies and execution activity), but adds no authenticated browser claim. [Evidence](evidence/observability-route-validation-g272.md).

G271 proves the backend `/skills` read contract only; no authenticated browser claim is added. Dashboard skill controls remain governed by the existing explicit-unavailable activation boundary. [Evidence](evidence/skills-route-validation-g271.md).

G270 adds no UI claim: route registration and backend contract inventories were rechecked, while authenticated browser interaction remains unavailable. The controlled evolution preparation is a backend/fixture proof and does not imply dashboard execution. [Routes](evidence/route-contract-recheck-g270.md), [Browser boundary](evidence/browser-availability-g267.md).

G266 keeps the UI contract honest: Astra selection is an explicit governed loop/API choice, not inferred from advisory recommendations; no new UI control is claimed without an authenticated browser session. [Evidence](evidence/astra-loop-forwarding-g266.md), [Browser boundary](evidence/browser-availability-g265.md).

G265 exposes authenticated `/swarm-v2/socialize` behind the existing swarm-action permission boundary; signed runtime callbacks are intentionally not browser controls. Dashboard exposure of social rounds remains partial until authenticated UI state is traced and exercised. [Evidence](evidence/social-runtime-g265.md).

G264 changes no dashboard interaction semantics; worker outcomes behind runtime views are now durable across service restart and metrics is labeled as a snapshot. [Evidence](evidence/worker-result-persistence-g264.md).

G263 changes no dashboard interaction semantics; memory maintenance now reports intentional TTL deletion rather than implying archival. [Evidence](evidence/memory-ttl-purge-truth-g263.md).

G262 changes no dashboard interaction semantics; the background-worker controls now expose explicit unavailable state for four unconfigured workers rather than implying completed work. No new authenticated production-browser claim is made. [Evidence](evidence/background-workers-truth-g262.md), [Browser boundary](evidence/browser-availability-g254.md).

G253 hardens the Predictive Analytics action's API admission; the dashboard continues to send the required goal type, runtime and mode. No new browser execution claim is inferred. [Evidence](evidence/predictive-validation-g253.md).

G254 attempted a fresh browser revalidation, but no connected browser instance was available; no UI behavior is claimed from that attempt. [Evidence](evidence/browser-availability-g254.md).

G258 hardens compliance audit append and report-generation actions at the API boundary; no new browser claim is made because browser access remains unavailable. [Evidence](evidence/compliance-report-boundary-g258.md), [Audit](evidence/compliance-audit-boundary-g257.md).

G259 hardens the swarm mission-control backend permission boundary; no new browser claim is made because browser access remains unavailable. [Evidence](evidence/swarm-mission-permissions-g259.md), [Browser boundary](evidence/browser-availability-g254.md).

G260 hardens memory-evolution API permissions; no new browser claim is made because browser access remains unavailable. [Evidence](evidence/memory-evolution-permissions-g260.md), [Browser boundary](evidence/browser-availability-g254.md).

G261 hardens meta-orchestration API permissions for reads, prediction and tuning; no new browser claim is made because browser access remains unavailable. [Evidence](evidence/meta-route-permissions-g261.md), [Browser boundary](evidence/browser-availability-g254.md).

G261 live probing confirms only the public shell/version and protected API boundary; no authenticated production UI action is claimed. [Evidence](evidence/live-public-recheck-g261.md).

G252 changes no dashboard semantics; the SEGML production cycle now reports promotion eligibility separately from deployment, while the local dashboard and workspace regression remain green. [Evidence](evidence/segml-production-cycle-g252.md), [Workspace](evidence/workspace-regression-g252.md).

G244 re-crawls all 38 declared dashboard route patterns in authenticated local Chromium after a clean server restart and re-runs `/loops` (291 passed, 1 skipped). Screens render non-empty with no page errors; clean six-route batches have no failed HTTP requests. Fixture 404 and authority-unavailable states are explicit and expected. [Evidence](evidence/browser-local-crawl-g244.md), [Loops](evidence/loops-self-check-g244.md).

G243 changes no UI semantics; it makes the capability graph's two local database scopes explicit. [Evidence](evidence/database-scope-reconciliation-g243.md).

G239 changes no UI semantics; it refreshes the evidence baseline only. Authenticated production UI remains uninspected because the in-app browser is unavailable; local dashboard tests and builds are green. [Evidence](evidence/workspace-regression-g239.md).

G160 adds no new UI proof; assurance remains blocked by external evaluation and live deployment identity gates. [Evidence](evidence/assurance-truth-g160.md).

G159 adds fail-closed pagination for task and discussion list consumers; no new dashboard behavior is inferred beyond the corrected API contract. [Evidence](evidence/tasks-discussions-pagination-g159.md).

G158 revalidated the governed `/loops` control surface after the latest route-boundary repairs; no new UI capability is inferred from this backend regression. [Evidence](evidence/loops-self-check-g158.md).

G93 adds supervised product-source self-improvement evidence through the existing Goals & Loops governance path; it does not make dashboard controls or production Astra execution VERIFIED. [Evidence](evidence/controlled-product-improvement-g93.md).

G94/G95 add full workspace and build rechecks; no new authenticated production UI session or route semantics are inferred from these package-level results. [Evidence](evidence/workspace-recheck-g94.md), [evidence](evidence/build-assurance-recheck-g95.md).

G96 adds no UI certification: external evaluation and live authenticated deployment identity remain unavailable. [Evidence](evidence/external-prerequisite-recheck-g96.md).

G97 rechecked the public UI bundle and confirms the production Save control remains alert-only; local functional semantics are still not live. [Evidence](evidence/live-differential-recheck-g97.md).

G99 rechecked the authenticated Goals & Loops route chain and current contract/table inventories; no new production UI action is inferred. [Evidence](evidence/loops-recheck-g99.md).

G100 records a backend validation repair for the SEGML Level 3 scenario endpoint; no unverified dashboard semantics are inferred. [Evidence](evidence/segml-l3-route-validation-g100.md).

G101 adds no UI certification; it preserves the scheduler test-environment uncertainty. [Evidence](evidence/workspace-recheck-g101.md).

G102 adds workspace regression evidence only; production UI behavior remains separately gated. [Evidence](evidence/workspace-recheck-g102.md).

G103 adds backend OpenMythos query validation evidence without inferring new dashboard semantics. [Evidence](evidence/openmythos-limit-validation-g103.md).

G104 adds server regression evidence only; production UI behavior remains separately gated. [Evidence](evidence/server-recheck-g104.md).

G105/G106 add backend research validation and full regression evidence only; no production UI semantics are inferred. [Evidence](evidence/research-limit-validation-g105.md), [evidence](evidence/server-recheck-g106.md).

G107 adds backend advanced-feedback validation evidence without inferring new production UI semantics. [Evidence](evidence/advanced-limit-validation-g107.md).

G108 adds only server regression evidence; no new production UI semantics are inferred. [Evidence](evidence/server-recheck-g108.md).

G109 adds complete workspace regression evidence; no new production UI semantics are inferred. [Evidence](evidence/workspace-recheck-g109.md).

G110 adds assurance-gate evidence only; production UI behavior remains unverified beyond the recorded anonymous boundary. [Evidence](evidence/assurance-recheck-g110.md).

G111 adds audit pagination backend evidence; no new production UI semantics are inferred. [Evidence](evidence/audit-pagination-validation-g111.md).

G112 adds governance-feedback pagination backend evidence; no new production UI semantics are inferred. [Evidence](evidence/governance-feedback-pagination-g112.md).

G113 adds assurance-only evidence; production UI remains outside authenticated proof scope. [Evidence](evidence/assurance-recheck-g113.md).

G114 adds SEGML history backend evidence; no new production UI semantics are inferred. [Evidence](evidence/segml-history-validation-g114.md).

G115 adds memory-evolution backend evidence; no new production UI semantics are inferred. [Evidence](evidence/memory-evolution-validation-g115.md).

G116 adds gym governance-history backend evidence; no new production UI semantics are inferred. [Evidence](evidence/gym-history-validation-g116.md).

G72–G92: dashboard remains scoped within the full workspace audit; server proof now includes hashed advisory task/loop context, confidence-gated durable loop-parameter tuning, authenticated OpenMythos attestation intake, promotion-safe WorldLab retest intake, persisted Codex/Astra runtime dispatch, authenticated `/loops` planning/review persistence and a disposable maker/checker route chain. A production/local differential shows the deployed Pipeline Builder Save control is alert-only while local Save persists drafts; local jsdom regression is 3/3 green. Cognitive Runtime shows advisory-only strategy semantics and visible error/Retry. Actual browser fault recovery and restart render50%/N10; Goals & Loops exposes all six evolution goals. G86/G89 remove false-green Level 5 self-improvement claims at both service and authenticated HTTP boundaries; this has no direct dashboard control. G91 proves planning/review and G92 proves controlled maker/checker execution with approval gate; neither proves live Astra quality or deployment. [G92 route proof](evidence/loops-maker-checker-route-g92.md), [G91 route proof](evidence/loops-http-proof-g91.md), [G89 route proof](evidence/segml-level5-http-g89.md), [G86 proof boundary](evidence/segml-level5-no-false-proof-g86.md), [G84 isolation proof](evidence/proof-run-cwd-isolation-g84.md), [Differential proof](evidence/live-local-differential-g82.md). Remaining page/control coverage stays partial;608 API denials do not prove UI actions. The following G68–G71 results are historical.

Current G68–G71: dashboard **147 tests pass** in the 2,656-test integrated run. Factory-created pending agents no longer crash; review pending/unknown is neutral and configured executor is explicitly unproven. Independent review separated current recorded execution approvals from manual/history rows and retained post-wait policy denial. [Scoped evidence](evidence/evidence-summary-continuation.md), [review](evidence/evidence-summary-review.md). Actual browser pending-agent and held/completed-review snapshots exist; [joined restart proof](evidence/lifecycle-closure.md) passes. No provider or complete page capability is newly certified.

Historical G66–G67: dashboard140tests passed. Actual login, expired-token organization switch, coordinated Tasks/Agents tab reload, server restart and Sign out close the session chain. The same family/default scope persists until logout revokes all five generations, clears both tabs and rejects the previously valid token. [Joined browser/network/SQLite proof](evidence/g66-session-closure.md). HttpOnly refresh material is not exposed to JavaScript; access localStorage and non-Web-Locks limitations remain explicit. This does not reclassify every control or route as verified.

Previous G62–G65 continuation: dashboard115tests passed, including9new backlog-conversion and9organization/auth-store checks. Actual browser Goal click→repeat API request→reload→server restart retains one SQLite goal and zero linked loops ([proof](evidence/work-item-browser-after-restart.json)). Actual organization assigned→default→restart/reload→assigned adopted replacement tokens and recorded both canonical audit transitions ([proof](evidence/organization-browser-db.json)). These are historical bounded chains, not full page or tenant-isolation certification.

Previous operator continuation: actual create→discover→quiescent pause→knowledge proposal→gate advice→server restart→resume→reload is evidenced in [intervention-continuation.md](evidence/intervention-continuation.md), [paused restart state](evidence/intervention-paused-after-restart.json) and [resumed state](evidence/intervention-resumed-db.json). Zero tasks/leases executed; real claim and authenticated audit IDs persist; original gates/risk/contract stay unchanged. Controls show operation semantics and errors, cancel submits nothing, viewer intervention controls are absent, paused admission is visibly disabled. That dashboard checkpoint had97tests including20GoalsLoopsPage tests.

Goals & Loops continuation: [browser/REST/SQLite/restart proof](evidence/g54-browser-proof.json) covers explicit manual runtime, security approval HOLD, cancellation without completion POST and confirmed completion with server-owned identity. In-flight loops interrupt on restart while pending native approval remains unexecuted; completed fixtures retain completion. Makers in these UI fixtures are explicitly synthetic mocks. [Start-form bounds](evidence/g54-layout-proof.json) and [final header bounds](evidence/g54-header-proof.json) pass at1200/1440pixels after native CSS wrapping; no mobile/exhaustive-page certification.

Latest exercised subchains: Tasks now has real browser repository selection→Astra-low execution→fixture edit/test→structured live events→terminal audit→reload proof (`BROWSER_TASK_EXECUTION.md`). Catalog now has real browser artifact preparation/deactivation for both targets, persisted artifact/audit and error/filter/reload evidence (`evidence/catalog-ui-summary.md`); it explicitly does not register or execute agents. These bounded chains do not upgrade every action on either page to VERIFIED. Catalog mobile360 and desktop1200 measured bounds pass; the wide table retains its own horizontal scroll.

Scope: isolated, currently uncommitted audit checkout based on `origin/main` c0c8d72b. Route source is `packages/dashboard/src/App.tsx`; page filenames below are relative to `packages/dashboard/src/pages/`. API methods resolve through `packages/dashboard/src/lib/api.ts`; registered middleware and routers resolve through `packages/server/src/routes/index.ts`. All API paths below have `/api` prefix.

`PARTIAL` means a real implementation/caller was traced or tested, but the entire user-action → persistent domain effect → runtime outcome chain is not yet proven. A passing mocked-fetch component test establishes wiring/render/error behavior only. Browser and backend evidence must be joined from `VERIFICATION_REPORT.md`; no row below silently treats source code as live proof.

## Route and action matrix

| Route / page | Meaningful controls and frontend handler | API / runtime or storage | Execution evidence and state |
|---|---|---|---|
| `/login` — LoginPage | Email/password submit; restore session; expired session redirect | auth-store.login → POST `/auth/login`; restoreSession → GET `/auth/me` and cookie `/auth/refresh`; browser access-token storage | G66 actual expiry/refresh, two-tab coordination, restart and family revocation supersede the earlier disconnected refresh observation. PARTIAL for the full auth surface: legacy sidless revocation and universal tenant isolation remain unproven. |
| `/` — DashboardPage | Task/agent/status summaries; shared compliance refresh and spec expansion | DataLoader/getTasks/getAgents → `/tasks`, `/agents`; store subscribes WS task/agent/system events; compliance `/compliance/specs` | BROKEN baseline: Zustand array selectors created unstable snapshots and React maximum-depth crash. Fixed using installed `useShallow`; real-store regression failed before fix and passes after; counts update after task transition. PARTIAL for live operational counts. |
| `/tasks` — TasksPage | New Task modal; title, description, priority, agent, execution mode, advertised runtime/model/Codex reasoning; submit/cancel; search and status filters; task links | createTask → POST `/tasks`; store.addTask; global task WS handlers | Browser-created review-only fixture `13a04fbe-a55e-4891-8f69-5c2ff72dd478`: POST201; appears once; reload detail retains codex / gpt-6-astra / max. No execution requested. Shared addTask idempotent and preserves newer status. PARTIAL for complete task-execution chain; parent separately proves API/WS. |
| `/tasks/:taskId` — TaskDetailPage | Runtime selector; Execute; Cancel; export format menu; task review link; approvals through ApprovalCard; execution stream | GET `/tasks/:id`, `/events`, `/approvals`; POST `/execute`, `/cancel`; POST `/exports/task/:id`; WS execution/approval events | Baseline forced OpenCode. Repaired selection from `/loops/runtime-contracts` and persisted task metadata.executor; unavailable runtimes disabled. Create now stores optional model and Codex reasoningEffort. Actual ApiClient component workflow proves create Astra/max → navigate → execute codex; real runtime proof remains separate. Cancellation relies on WS refresh. PARTIAL. |
| `/tasks/:taskId/review` — ReviewPage | Export menu; expand per-file diff; evidence/diff/snapshot inspection; recorded execution approval and executor attribution | `/evidence/review/:id`, `/tasks/:id/diff`, `/tasks/:id/snapshots`, POST `/exports/task/:id` | PARTIAL. G70 actual browser pending/configured-only→completed mock review joins HTTP/SQLite/restart with stable identity. Historical diff503 recovery retained. Configuration is not provider proof; current recorded execution approval is not authorization. Final rebuilt browser has13audit-trail entries, exactly2canonical grants with matching timestamps and no duplicate/backdated grants. [Joined evidence](evidence/lifecycle-closure.md). |
| `/agents` — AgentsPage | Agent status/capabilities/task counters and retirement metadata (read view) | global store; GET `/agents` fallback | PARTIAL. G69 factory/API pending_approval no longer crashes. Actual rebuilt browser shows pending fixture and retired offline fixture with timestamp/reason; HTTP/SQLite archive and tombstone survive restart. No create/retire/configure controls exist on this read page; lifecycle mutations used actual authenticated HTTP. [Joined evidence](evidence/lifecycle-closure.md). |
| `/agents/:agentId` — AgentsPage | Selected agent card; All agents backlink | same agent API/store, filtered by route parameter | MISSING at baseline despite Swarm card links. Existing route/view now has actual selected pending and retired fixture browser evidence after rebuild. PARTIAL: read view only, not complete agent management. [Joined proof](evidence/lifecycle-closure.md). |
| `/catalog` — AgentCatalogPage | Search, division filter, retry, activate/deactivate cards | useCatalog → `/catalog/counts`, `/catalog/agents`, `/catalog/search`, POST `/catalog/activate/:id`, `/catalog/deactivate/:id` | Existing component tests exercise API calls, search/filter/activation and error states with mocks. PARTIAL: activation metadata is not executor availability proof. |
| `/swarm` — SwarmOverviewPage | Agent-card navigation; status/capability/discussion/learning views | `/swarms/status`, `/swarms/intelligence/capabilities`, `/agents`, `/tasks`, `/discussions`, `/learning`; multiple WS subscriptions | Agent links repaired via registered detail route; discussion subscriptions now use actual shared enums. Task total includes unassigned tasks. Existing tests normalize arrays. PARTIAL; fallback empty arrays hide optional errors. |
| `/approvals` — ApprovalQueuePage | Pending/approved/denied/all tabs; approve; deny with reason | `/approvals?status=...`; ApprovalCard → POST `/approvals/:id/approve` or `/deny`; approval WS updates | Actual maker UI approve rejected409; separate local approver accepted200. Two actual denial fixtures persist reason/decider/audit after reload, with tasks unchanged and no execution. VERIFIED distinct-identity manual decision chains only, not human judgment or runtime approval/resumption. Error/retry/tab races separately tested. |
| `/policies` — PolicyCenterPage | Enable/disable each policy | getPolicies → GET `/policies`; togglePolicy → PATCH `/policies/:id` | Browser policy-low-task-allow toggled enabled→disabled PATCH200 version2; reload confirmed disabled; restored enabled PATCH200 version3 and reload confirmed. VERIFIED persistence control; PARTIAL policy-enforcement chain. Action still lacks explicit pending/error display. |
| `/governance` — GovernanceScorecardPage | Refresh; agent/model fields; start evaluation | `/openmythos/leaderboard`, `/openmythos/runs`; POST `/openmythos/eval/:agent` | Existing component tests cover data rendering and evaluation request; PARTIAL until actual judge/evaluation provenance. |
| `/compliance` — CompliancePage / SpecComplianceWidget | Refresh; compliance filter; sort; expand spec; JSON/CSV export | GET `/compliance/specs[?refresh=1]`, GET `/compliance/export?format=...` | BROKEN baseline bearer omission in fetch and download anchors. Repaired via shared authenticated client/download. Component filtering and authenticated export checks pass. PARTIAL: SDD source-file metrics are not runtime assurance. |
| `/mcp-permissions` — MCPPermissionsPage | Server, decision, risk, search filters; tool permission inspection | `/mcp/servers?refresh=true`, `/mcp/permissions?...` | PARTIAL. Read/filter UI; updateMCPPermission exists in client but no mutation control on this page. Probe discovery is not tool execution proof. |
| `/observability` — ObservabilityPage | Metrics / live event stream inspection | `/observability/metrics`; authenticated fetch SSE `/observability/stream` | PARTIAL. Repaired infinite loading on failed metrics requests. Risk data comes from risk_assessments, not tasks: heading now Risk Assessments and denominator is total assessments; regression proves 2 of 4 is 50% despite 1 task. SSE is separate from WebSocket. |
| `/audit` — AuditPage | Canonical audit event list and Refresh | authenticated `/audit?limit=50` | PARTIAL. Corrected to persisted canonical audit events; separate from organization logs and authority ledger. Component/API contract has regression coverage; not a certification of all event-producing workflows. |
| `/audit/logs` — AuditLogViewer | Entity/action filter; Previous/Next; JSON/CSV export | authenticated raw GET `/audit-logs`, `/audit-logs/export` | PARTIAL. Authenticated client, visible request/export errors and object-URL revocation are implemented. No sidebar entry at baseline; pagination has no total/has-more contract, so the Next control remains intentionally open-ended. |
| `/authority` — AuthorityTracePage | ALLOW/DENY/HOLD/all filter; event detail table; retry on unavailable backend | `/authority/stats`, `/authority/events?decision=...` | PARTIAL. Added navigation; backend now reports missing canonical ledger as explicit 503. Page now displays error and hides event counts, with retry; test proves unavailable is not shown as zero. Source text explicitly identifies external emitters. |
| `/usage` — UsagePage | Provider quota/token/cost/history views | `/usage/quotas`, `/usage/tokens`, `/usage/recent` | PARTIAL. Each request failure becomes zero/empty; zero is not verified absence of cost/usage. |
| `/repositories` — RepositoriesPage | Scan path; rescan repository; detail navigation | POST `/repositories/scan`, POST `/repositories/:id/rescan`; GET `/repositories` | PARTIAL. List, scan and rescan failures now surface with retry; real repository scanning still requires a valid server-side path and persisted scan evidence. |
| `/repositories/:id` — RepositoryDetailPage | Health findings, AGENTS.md and repository details; back navigation | `/repositories/:id`, `/repositories/:id/health`, `/repositories/:id/agents-md` | PARTIAL. Three request failures converted to null; missing versus failed scan indistinguishable. |
| `/goals-loops` — GoalsLoopsPage | Create goal; explicit goal/loop/runtime/path; start; select run; step/continue/verify/confirmed complete/stop; maker/checker/security-checker execution; manual accept/revise/retry; split; quiescent pause/resume; inject proposal; record gate advice | `/goals`; `/loops/catalog`, `/loops/start`, `/loops/runs/:id/...`; `/intervention/:goal/...` | PARTIAL page; scoped browser governance/intervention chains proven. Blank/paused repository admission disabled; manual never substitutes mock; new start selects its own review bundle. Explicit Codex security dispatch yields approval-HOLD, no native provider approved in UI fixtures. Completion confirmation persists server actor.20focused UI tests cover stale/busy/terminal guards, intervention errors and cancellation. Actual pause/proposal/advice/restart/resume preserves original gates and executes zero workers. Busy workers return409, not a false drain/checkpoint. Advice never overrides executable verification. Separate product-source runtime benchmark is not claimed as this browser chain. |
| `/fleet-cockpit` — FleetCockpitPage | Runtime/checker/capacity controls; refresh; start-next; drain; scheduler plan/prepare; stop lease | `/swarms/status`, `/loops/runtime-contracts`, `/swarms/worker-pool/{plan,start-next,drain,stop/:id}`, scheduler tick | PARTIAL. Configured availability and pool planning are not dispatch proof. Whole hook lifecycle affected by repaired reconnect leak. |
| `/swarm-resources` — SwarmResourcesPage | Refresh; scheduler; work-item triage/discard/convert; worker plan/start/drain; memory eval/promote; specialist panel create/review/project; improvement proposal approve/reject | `/work-items`, `/swarms/worker-pool/...`, `/swarms/memory/...`, `/swarms/specialist-panels/...`, `/self-improve/proposals/...` | Historical candidates-envelope render crash repaired. G64 actual Goal click/repeat/reload/restart proves one durable link; failure rollback and state guards have HTTP/UI regressions. PARTIAL for remaining operations. Several pool actions explicitly use mock checker; external memory promotion needs sink evidence. |
| `/swarm-mission-control` — SwarmMissionControlPage | Refresh; runtime proof-run; capacity plan; expand capability/claim; knowledge sync preview/apply; goal batch preview/apply; low-capacity simulation; close learning loop; rollback | `/swarms/intelligence/...`, `/swarms/knowledge/...`, `/goals/batch/...`, proof run/rollback endpoints, `/swarms/evolution/close-loop` | PARTIAL. Tests cover helpers. Mock capacity simulation explicitly selected. Goal batch uses hardcoded flywheel batch path: environment dependency. |
| `/interaction-board` — InteractionBoardPage | Refresh; actor/type/state/search/thread filters; clear; chat/relations tabs; more items; evidence navigation | `/swarms/intelligence/interactions`, `/swarms/intelligence/mission-control` | PARTIAL. Existing tests cover grouping/filter helpers; event display is evidence projection, not conversation generation. |
| `/swarm-mission-control/proof-runs/:proofRunId` — ProofRunDetailPage | Proof evidence view; rollback | getProofRun / rollbackProofRun; proof-run WS updates | PARTIAL. Rollback must be verified against exact fixture worktree/artifacts, not success text. |
| `/workstation-urls` — WorkstationUrlsPage | Refresh; external runtime endpoint links | `/workstation/urls` | PARTIAL. Endpoint metadata does not prove destination reachable or authenticated. |
| `/economy` — EconomyPage | Aggregate resource economy view | GET `/swarms/economy` | PARTIAL. Read-only page; fetch error swallowed. Domain accounting/economics unproven from rendering. |
| `/pipeline-builder` — PipelineBuilderPage | Name; add Goal/Loop/Worker/Checker/Learning nodes; move/delete/connect nodes; clear; export; save draft | ReactFlow local nodes/edges; JSON download; browser localStorage draft | Local implementation: browser-local save/reload with validated node/edge shape, UUID IDs, visible failure; package jsdom 3/3. Production bundle drift: deployed Save only alerts `Pipeline saved!` and does not persist. Pipeline execution remains INTENTIONAL unavailable: no route/service/compiler connects canvas to runtime, and local page says so explicitly. [G82 differential](evidence/live-local-differential-g82.md). |
| `/federation` — FederationPage | Register peer modal; URL/trust; register/cancel; peer/capability views | `/federation/peers`, `/federation/capabilities`, POST `/federation/register` | PARTIAL. Registration is not peer handshake/work transfer. Request failures hidden; mutations require valid peer fixture. |
| `/agi-reasoning` — AgiReasoningPage | Run Reasoning; observations/hypotheses/strategy view | POST `/agi/reason` → AgiGoalReasoningEngine.reason | BROKEN baseline unauthenticated raw fetch. Authenticated request/render check passes after repair. PARTIAL for actual reasoning quality/execution. No baseline sidebar entry. |
| `/consensus-debates` — ConsensusDebatePage | Topic; independent judge toggle/model; Create; select debate; Run council | GET/POST `/council/sessions`, POST `/council/sessions/:id/execute` | PARTIAL. Page name differs from actual council API (not `/agi/consensus`); no error or pending handling on actions at baseline. No sidebar entry. |
| `/predictive-analytics` — PredictiveAnalyticsPage | Run Prediction; probability/duration/cost/risk view | POST `/intelligence/predict` → PredictiveAnalyticsService | BROKEN baseline unauthenticated raw fetch and silent failure. Repaired shared auth + visible errors; wiring tests pass. PARTIAL: fixed general/mock/closed scenario, estimate not measured operational prediction. |
| `/self-healing` — SelfHealingPage | Run Health Check; check results | GET `/intelligence/health` → SelfHealingService.checkHealth | BROKEN baseline bearer omitted and request failures silent. Repaired authenticated client + error states. PARTIAL. Page scans health; does not invoke server `/heal`. |
| `/cognitive` — CognitiveRuntimePage | Statistics, learned strategies/meta-learning display | `/cognitive/stats`, `/cognitive/meta-learning` | PARTIAL. Failure becomes null/empty. Displayed accumulated history does not prove recent adaptation. |
| `/self-driving` — SelfDrivingDashboard | Stats; Run tuning; embedded improvement inbox | cognitive/memory/meta/compliance stats; POST `/meta/tuning/run`; proposal endpoints via ImprovementInbox | BROKEN browser render: legitimate `{enabled:false}` meta stats called undefined.toFixed. Repaired discriminated client contract; disabled runtime explicit and tuning disabled; unavailable cognitive/memory/compliance no longer fake zero/valid. Regression covers real disabled shape. PARTIAL: unavailable autonomous runtime is not self-driving proof. |
| `/explainers` — explore/ExplainerFleetPage | Sync; refresh stale; Run fleet; pause/resume; Ask repository knowledge; select repository/regenerate; approve/reject review | `/explainer/fleet/{status,overview,health-drift,calibration-stats,sync,refresh-stale,run,pause,resume,regenerate}`, `/explainer/ask`, `/explainer/review-queue/:id/resolve` | PARTIAL. External repository/provider execution and approval semantics require controlled evidence. No baseline sidebar entry. |

## Shared shell and invisible surfaces

- Layout navigation has mobile open/close/backdrop actions and closes after navigation. G66 logout removes both tabs' browser state and revokes session-bound access JWTs server-side; legacy sidless JWTs remain stateless. OrganizationSelector adopts tokens through existing storage/Zustand and retains a successful switch across same-family automatic refresh. Actual browser expired switch, native-lock two-tab renewal, restart and canonical audit prove this session workflow. Universal tenant row/WebSocket isolation remains unproven.
- Current reconstruction inventories 38 mounted page routes including login; the earlier count of 39 incorrectly counted a route wrapper as a page. Baseline navigation directly links 24 routes. Unlinked mounted pages include pipeline builder, AGI reasoning, consensus, prediction, self-healing, explainers, audit logs and authority; reachability by direct URL is not discoverability.
- `SegmlGovernancePage.tsx` and `SwarmPage.tsx` exist but are not imported or mounted by App. Classify DEAD for dashboard routing only; corresponding server features may still have consumers.
- `ComplianceDashboard.tsx` is not mounted; its `/v1/eu-ai-act/scan` call is not evidence of implemented main-dashboard compliance.
- No catch-all route exists at baseline; unknown URLs render no routed content.
- Added native collapsible Research & evidence navigation for the eight previously unlinked primary routes; route-link test passes. No new screens or dependencies were introduced.
- Repaired dashboard running count (pending no longer called running), Swarm task total (includes unassigned tasks), and task-list synthetic progress (removed fixed 65%/30% values). Swarm creation events now share idempotent store ingestion; empty global task/agent lists clear local projections.
- Replaced uppercase string subscriptions for discussion creation/proposals/votes and Fleet proof updates with existing shared event enum values. Fleet `LOOP_RUN_UPDATED` remains unproven: no matching shared enum or publisher was found; periodic refresh is still available.
- useWebSocket is called by the provider plus TaskDetail, ApprovalQueue, SwarmOverview, FleetCockpit and ProofRunDetail. Before repair it saved socket ownership only after open; unmount could leak a connecting socket and explicit close scheduled another connection. Repaired immediate ownership, stale-callback guards and enabled lifecycle; tests prove unmount-before/after-open, network reconnect, logout cancellation and re-login.
- Read views with `.catch(() => [])`, zero or null may hide real backend failures; these are explicitly PARTIAL and must not be promoted to VERIFIED based on empty-state rendering.

## Executed frontend checks

1. Dashboard real-store render/transition regression executed against original code: failed with `getSnapshot should be cached` and `Maximum update depth exceeded`. Same test passes with stable selectors.
2. AuthenticatedActions tests exercise reasoning, prediction and health with actual ApiClient and mocked HTTP response; assert bearer header and response content, denied-state display, and authenticated GET compliance download.
3. Pipeline tests prove draft save/remount and unique post-remount nodes, and preserve corrupt data / report quota failure.
4. WebSocket fake transport tests exercise lifecycle transitions, not server protocol conformance.
5. Store test proves duplicate creation cannot duplicate task or overwrite later state.
6. Dashboard suite: 55 tests across 17 files passed at 11:40 local. Dashboard build (including TypeScript) and lint passed; generated entry `index-DtlCaDKZ.js`. Includes authenticated real-client wiring, optional-runtime contract, navigation, store/socket, review-failure and recovery-hold regressions. Parent final verification supersedes intermediate runs.
7. Parent browser evidence `evidence/browser-routes-1.log` traversed the first 17 routes after P0 repair. No page errors except a separately repaired authority permission failure; this is route rendering evidence, not exhaustive action proof.

The local browser, production UI, backend persistent state, and external runtime evidence remain separate sources. Parent report joins those sources; this inventory does not claim every mutation has already been exercised.

## Actual local browser actions

Executed in isolated Playwright session `djimitflo-audit-qa` against `http://127.0.0.1:3187`, using disposable local audit login. In-app Browser diagnostics returned no available browsers, so standalone Playwright was used. Screenshots and downloaded exports are in `output/playwright/`. Raw tracing remains local because it may contain fixture authentication headers.

| Action | Actual observation | Evidence limit |
|---|---|---|
| Pipeline name + Goal + Worker + Save draft locally + reload + Export | Name and two nodes retained after browser reload; actual exported JSON contains their types/positions and zero edges | VERIFIED browser-local draft and export only; no server persistence, node-edge connection or agent execution claimed. `audit-20260909-pipeline-reloaded.png`, `audit-20260909-pipeline-export.json`. |
| Run Prediction | Authenticated POST200; probability50%,10min,$0.050; UI explicitly reports zero samples/uncertain prediction | VERIFIED request/render only; heuristic/unvalidated quality, not measured forecasting accuracy. `audit-20260909-prediction.png`. |
| Run Health Check | Authenticated GET200; five checks render loop failures, stale leases, orphan worktrees, DB and process memory | VERIFIED read-check wiring; no automatic healing mutation performed. `audit-20260909-health-check.png`. |
| Run Reasoning | Authenticated POST200; loop-health observation renders, no anomalies/opportunities/hypotheses/strategies | VERIFIED computation/render only; no planning or runtime execution claimed. `audit-20260909-reasoning.png`. |
| Authority unavailable | Actual503; visible canonical-ledger-not-provisioned explanation and Retry, no fabricated zero counters | INTENTIONAL unavailable deployment dependency, not a populated authority ledger. `audit-20260909-authority-unavailable.png`. |
| Compliance Export JSON/CSV; Full filter | Downloaded JSON45 specs and CSV46 lines including header; Full filter shows exactly3 | VERIFIED download/filter; source-derived SDD scoring not security/runtime compliance proof. `audit-20260909-compliance-export.json`, `.csv`. |
| Create task with codex/gpt-6-astra/max | Actual201; review-only task appears and detail survives reload, runtime selected codex and model/reasoning visible | VERIFIED browser→API→persist→refresh configuration only; Execute deliberately not clicked. Task ID above. |
| Mobile navigation360×800 | Open and close navigation buttons worked; task detail Execute x503 and Export x744 offscreen; pipeline Save right502 | Real responsive defects found, then fixed wrapping action groups/pipeline header and mobile palette; final post-fix measurements in correction evidence. `audit-20260909-mobile-before.png`. |

Desktop organization picker overflow was also observed and corrected by keeping the sidebar header/selector inside its width. Concurrent local asset rebuild invalidated an already-open lazy chunk URL once; a full page reload restored the route. This is a deployment/stale-client limitation, not an API404. Screenshot capture initially timed out when the QA browser was backgrounded; bringing its page to front restored capture. No screenshot is claimed when the capture command failed.

### Post-repair browser evidence

- `evidence/browser-corrections-final.log`: complete actual main text for `/swarm-resources`, `/self-driving`, `/fleet-cockpit`, `/interaction-board`; all four have `errors: []`, `failed: []` after final API restart. Fleet loaded after its CLI probes completed: the earlier short observation was not an indefinite hang.
- `evidence/browser-mobile-final.log`: at viewport360×800 both pipeline and task detail have main scrollWidth360. Pipeline Save right169.95; task Execute right156.61 and Export right146.33. Before: pipeline main502, task main850. Palette is deliberately horizontally scrollable on mobile. Open/close navigation both exercised. Screenshots `audit-20260909-mobile-{pipeline,task,nav}-after.png` were captured and visually inspected.
- Desktop1200px screenshots `audit-20260909-astra-detail-after.png` and `audit-20260909-self-driving-after.png` preserve model/max and explicit disabled runtime display. Detail still says no execution events, correctly.
- `evidence/browser-policy-roundtrip.log`: authenticated actual policy mutation and restore with persistent versions2/3, not mocked responses.
- `evidence/browser-review-adversarial.log`: deliberate browser-only diff503 injection and successful unroute/reload. Fault snapshot `audit-20260909-review-fault.png`. Injection is labeled and is not represented as an actual backend outage.
- Catalog has zero imported records on this fixture instance, so activation/deactivation could not be browser-exercised without additional fixture import.
- Approval fixture `bd8980a9-3d0c-45ac-ae54-e44fdbd73706`: maker action rejected409 `SELF_APPROVAL_FORBIDDEN`, state remained pending. Parent provisioned a separate disposable approver using existing AuthService. Real UI approval then returned200 with `approved_by=3d073bca-f8e6-42f1-bee2-bed20ec6119e` distinct from requester; GET approved persisted after reload. Admin session restored; related task `873cb83b-4172-4bee-b010-49df1fb4c6d9` remained pending, Review Only, no execution events. Evidence: `browser-self-approval-response.json`, `browser-independent-identity-approval.log`, `browser-approved-reload-response.json`, `browser-approved-reload-settled.log`, `browser-approved-task-unchanged.log`; all under `evidence/`. This proves software identity separation on a manual fixture, not independent human authorization. The first immediate tab snapshot preceded request completion; settled evidence is authoritative.

Remaining limitations include untested policy-denial error UX, empty catalog activation, mutation-heavy loop/fleet/memory/explainer actions, tenant switch lifecycle, and stale-client lazy asset recovery. Approval denial/history/error behavior has subsequently been repaired and exercised below. These truth/UX limitations are explicit and are not silently promoted by route-render proof.

### Startup recovery and final CSP smoke

At 11:46 local, actual browser loaded persisted task `ff387422-f75c-470f-9c48-68b8c8e9a923`, which parent explicitly seeded as a **synthetic legacy running record; no external provider was started**. Startup changed it to paused with `metadata.execution_recovery_hold === true`. Browser showed the recovery alert (provider outcome unknown, provider may still be running), Execute disabled, Cancel absent under normal paused-state controls, Review link present and Export enabled. No replay/cancel was attempted. Component regression separately proves Cancel disabled if a stale queued status accompanies the same hold. This is persistent startup-to-browser simulation proof, not recovery/cancellation proof for a real provider.

Evidence: `evidence/browser-recovery-hold-synthetic.log`, screenshot `output/playwright/audit-20260909-recovery-hold-synthetic.png` (1200×850, visually inspected). Screenshot also confirms the organization selector stays inside desktop sidebar width.

Final `/` and `/audit` smoke after global CSP: HTML response carries CSP; root renders Connected and correct zero-running count; audit renders canonical rows including `execution_reconciled_after_restart` and policy/approval actions. Both pages have no page exceptions, failed HTTP responses or observed external requests. Exact response policies and page text are in `evidence/browser-csp-final-smoke.log`.

### Final rebuilt application

`evidence/browser-postbuild-authenticated-final.log` repeats seven actual routes after the final server/runtime build: root, tasks, held task detail, audit, approvals, agents and swarm-resources. All observed HTTP responses succeed and page exceptions are absent; each document has CSP. The800ms task-detail sample was empty and is not render proof: `browser-postbuild-recovery-settled.log` waits for the actual task heading and verifies the persisted hold and disabled Execute button. Earlier postbuild attempts hit an expired JWT/login redirect and an incorrect audit-script path; their timeout logs are retained, not counted as application successes. Explicit login then succeeds. Browser console data-URL CSP blocks remain attributable to the previously captured automation evaluation, not silently suppressed.

### Continued action verification — repository and denial chains

- `/repositories`→`/repositories/:id`: actual disposable Git scan, rescan, detail and refresh exposed missing persisted Git fields and blank instruction paths/sizes. After repair, `browser-repository-roundtrip-verified.log` and independent `repository-durable-proof.json` agree on branch, exact commit, nested instruction scope and latest scan findings. Actual authenticated `/agents-md/effective` distinguishes `/packages/demo/index.ts` from sibling `/packages/demo-other/index.ts` (`repository-effective-stack-http.json`). Heuristic health scoring is not evidence that repository scripts ran.
- `browser-repository-fault-recovery.log`: deliberate browser-only health503 retains repository/instructions and shows unavailable findings, then restores the real finding after interception removal/reload. List failure/retry, scan failure and viewer restrictions have four component regressions. Legacy unbound findings explicitly require rescan rather than silently appearing clean.
- `/approvals`: [deny-ui-summary.md](evidence/deny-ui-summary.md) and [deny-ui-durable-proof.json](evidence/deny-ui-durable-proof.json) prove two distinct-identity manual denials through browser→REST→SQLite/audit→reload. Tasks stay pending/review-only with zero execution events. Fault/retry, whitespace reason validation, historical reason/decider, and stale GET/late POST tab races now have seven targeted tests. This does not certify runtime denial/resumption or human judgment.

Earlier repository automation attempts used an unavailable automation-sandbox URL constructor or an expired JWT; those failures are retained and excluded from passing proof. The verified roundtrip uses an explicit path and reauthenticated browser.

Console is **not literally empty**: the browser blocks `fetch('data:,')` against `connect-src 'self' ws: wss:`. A browser-only diagnostic fetch wrapper captured the call stack `eval (eval at evaluate ...) → UtilityScript.evaluate → UtilityScript...`, attributing it to an automation evaluation context rather than a dashboard asset; the exact internal tool caller was not identified. Raw messages and diagnostic stacks remain in the smoke log; they were not suppressed or solved by loosening CSP. The empty data probe did not result in an external request. A 401 before reauthentication was an expired local session; no claim is made that restart changed the stable JWT secret.

G117 adds no new dashboard semantics; authority-ledger pagination is now validated server-side. [Evidence](evidence/authority-pagination-validation-g117.md).

G118 adds no new dashboard semantics; swarm message retrieval now rejects malformed pagination server-side. [Evidence](evidence/swarm-message-pagination-validation-g118.md).

G119 adds no new dashboard semantics; vector-memory search now rejects malformed pagination server-side. [Evidence](evidence/apex-memory-pagination-validation-g119.md).

G120 adds no new dashboard semantics; proactive-memory top/search now reject malformed pagination server-side. [Evidence](evidence/proactive-memory-pagination-validation-g120.md).

G121 adds no new dashboard semantics; work-item listing now rejects malformed pagination server-side. [Evidence](evidence/work-item-pagination-validation-g121.md).

G122 adds no new dashboard semantics; swarm-intelligence interaction, learning, capability and handoff endpoints now reject malformed pagination server-side. [Evidence](evidence/swarm-intel-pagination-validation-g122.md).

G123 adds no new dashboard semantics; swarm-governance list endpoints now reject malformed pagination server-side. [Evidence](evidence/swarm-governance-pagination-validation-g123.md).

G124 adds no new dashboard semantics; legacy swarm list endpoints now reject malformed pagination server-side. [Evidence](evidence/swarms-pagination-validation-g124.md).

G125 adds no new dashboard semantics; self-improvement proposal listing now rejects malformed pagination server-side. [Evidence](evidence/self-improvement-pagination-validation-g125.md).

G126 adds no new dashboard semantics; predictive, runtime-governance and meta-tuning list endpoints now reject malformed pagination server-side. [Evidence](evidence/runtime-pagination-validation-g126.md).

G127 adds no new dashboard semantics; compliance and usage list endpoints now reject malformed pagination server-side. [Evidence](evidence/compliance-usage-pagination-validation-g127.md).

G128 adds no new dashboard semantics; knowledge and multi-model list endpoints now reject malformed pagination server-side. [Evidence](evidence/knowledge-multimodel-pagination-validation-g128.md).

G129 adds no new dashboard semantics; council and red-team list endpoints now reject malformed pagination server-side. [Evidence](evidence/council-redteam-pagination-validation-g129.md).

G130 adds no new dashboard semantics; explainer list/search endpoints now reject malformed pagination server-side with structured validation errors. [Evidence](evidence/explainer-pagination-validation-g130.md).

G131 adds no new dashboard semantics; observability time-window query parameters now fail closed server-side. [Evidence](evidence/observability-window-validation-g131.md).

G132 adds no new dashboard semantics; assurance recheck records contract/integration pass and truth/live prerequisites separately. [Evidence](evidence/assurance-recheck-g132.md).

G133 adds no new dashboard semantics; swarm knowledge confidence filters now fail closed server-side. [Evidence](evidence/swarm-confidence-validation-g133.md).

G134 adds no new dashboard semantics; catalog search bounds now fail closed server-side. [Evidence](evidence/catalog-search-validation-g134.md).

G135 confirms only reference-UI availability/title; authenticated production behavior remains unclaimed. [Evidence](evidence/live-reference-ui-recheck-g135.md).

G136 confirms local authenticated deep-health behavior; the UI/runtime dependency status is degraded until the trusted OKF validator is supplied. [Evidence](evidence/live-authenticated-health-g136.md).

G137 adds no UI semantics; mutation testing confirms configured governance/execution invariants remain behaviorally covered. [Evidence](evidence/mutation-recheck-g137.md).

G138 records the upstream public-explore test delta; no UI behavior is declared from commit comparison alone. [Evidence](evidence/upstream-identity-recheck-g138.md).

G139 closes the only dashboard route without execution evidence: proof-run detail loads, rolls back using the returned state, and exposes lookup failures as an alert. [Evidence](evidence/proof-run-detail-ui-g139.md).

G140 confirms **38/38** dashboard routes are now represented with executed evidence; this index closure does not imply production/provider certification. [Evidence](evidence/dashboard-route-evidence-closure-g140.md).

G141 adds no new screen; OIDC authentication now rejects unsigned/tampered ID tokens at the shared identity boundary. [Evidence](evidence/oidc-signature-validation-g141.md).

G142 adds no new screen; the `/goals-loops` capability is backed by a fresh 41-file loop regression, including authenticated `/loops` route proof and lifecycle invariants. [Evidence](evidence/loops-regression-g142.md).

G143 adds no new screen; local live probing confirms public health/version reachability and the protected deep-health boundary returns 401 without credentials. [Evidence](evidence/live-identity-auth-boundary-g143.md).

G144 confirms the production Pipeline Builder Save control is still alert-only; local draft persistence remains corrected but undeployed. [Evidence](evidence/live-differential-recheck-g144.md).

G145 adds no screen; dependency and install hygiene were revalidated without changing UI semantics. [Evidence](evidence/dependency-audit-g145.md).

G146 adds no dashboard screen; the public explore leaderboard route now has the upstream behavioral gate locally. Production enablement was then verified separately in G147. [Evidence](evidence/explore-leaderboard-upstream-parity-g146.md).

G147 verifies the deployed public Explore leaderboard response and redaction contract; no mutation or authenticated dashboard claim is made. [Evidence](evidence/live-explore-leaderboard-g147.md).

G148 verifies the public Explore index responses without inferring repository publication where the sitemap has no entries. [Evidence](evidence/live-explore-public-sweep-g148.md).

G149 confirms the deployed Pipeline Builder Save action is still functionally drifted from the local corrected UI; no production mutation was attempted. [Evidence](evidence/live-pipeline-builder-drift-g149.md).

G154 authenticated Playwright crawl rendered all 36 navigation routes and exercised `/tasks` create/execute through the real local API, ending in `completed` with timeline evidence. [Evidence](evidence/browser-authenticated-crawl-g154.md).

G155 adds no screen; `/goals-loops` remains backed by a fresh 23-file, 291-pass governance regression. [Evidence](evidence/loops-self-check-g155.md).

G156 adds no screen; expert-swarm dispatch now rejects invalid parallelism before any external provider call. [Evidence](evidence/expert-dispatch-parallel-validation-g156.md).

G157 adds no screen; message and audit-log list controls now reject malformed pagination rather than silently changing the requested window. [Evidence](evidence/message-audit-pagination-validation-g157.md).

G162 exercises `/swarm-mission-control` and `/swarm-mission-control/proof-runs/:proofRunId`: Run Proof creates persisted evidence, the detail view renders artifact counts and narrative, Rollback returns `rolled_back`, and a reload shows the intentional cleanup 404. [Evidence](evidence/browser-proof-run-detail-g162.md).

G164 rechecks `/swarm-resources` and `/self-driving` in an authenticated browser after the current build; both render their live metric panels without page errors or failed requests. [Evidence](evidence/browser-crash-recheck-g164.log).

G165 exercises `/swarm-resources` Worker Pool Plan and Scheduler Tick controls; both POSTs return 200 and the UI reflects the empty-plan/zero-work outcome. [Evidence](evidence/browser-swarm-resources-actions-g165.log).

G166 adds backend semantic evidence for the advanced compression, AGI consensus, swarm mission and specialist-panel detail actions: valid empty/absent states now return 200/404 rather than internal errors. [Evidence](evidence/route-read-sweep-g166.md).

G167 covers all registered GET-backed UI/API read paths; 503 authority/degraded states and open SSE streams are retained as explicit non-ordinary boundaries, while missing swarm progress is now a typed 404. [Evidence](evidence/route-read-sweep-g167.md).

G168 validates empty-state error behavior for 20 mutation-backed UI/API actions; cognitive episode, policy and mission forms now expose 400 validation errors instead of internal failures. [Evidence](evidence/mutation-validation-sweep-g168.md).

G169 validates the remaining selected mutation-backed controls (`risk/task`, swarm claims and LLM routing): empty requests expose typed validation errors rather than internal failures, with no 500s in the fresh built-runtime replay. [Evidence](evidence/mutation-validation-sweep-g169.md).

G170 validates advanced governance feedback and AGI consensus resolve controls: empty feedback is a typed 400 and an absent debate is a typed 404, with no internal error response. [Evidence](evidence/mutation-validation-sweep-g170.md).

G172 validates workflow graph controls for missing resources: status, approve, reject and next-node actions expose typed 404 errors rather than claiming success. [Evidence](evidence/mutation-validation-sweep-g172.md).

G182 validates the skills assignment delete control for missing resources: unknown skill or agent now exposes typed 404 rather than a false removal success. [Evidence](evidence/mutation-validation-sweep-g182.md).

G183 rechecks the live UI boundary: the production shell presents the authenticated login screen and protected API-backed controls cannot be exercised without credentials. [Evidence](evidence/live-github-differential-g183.md).

G184 revalidates the UI-backed task/loop execution spine through the authenticated local API and WebSocket fixtures; persisted runtime selection, recovery and loop planning remain covered. [Evidence](evidence/core-spine-recheck-g184.md).

G185 validates the fix-pipeline action boundary: empty or malformed fix requests are rejected, while valid target requests enter the governed loop and expose a human-approval-required result. [Evidence](evidence/fix-pipeline-validation-g185.md)

G186 revalidates the action with invalid runtime rejection and explicit runtime selection. [Evidence](evidence/fix-pipeline-validation-g186.md)

G187 verifies security-targeted fix actions enter the high-risk checker boundary. [Evidence](evidence/fix-pipeline-validation-g187.md)

G189 reruns the complete server-backed UI route contract suite after the fix changes; no persistent route failure remains. [Evidence](evidence/full-server-regression-g189.md)
