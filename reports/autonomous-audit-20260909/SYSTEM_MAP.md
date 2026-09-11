# Actual system map

G393 closes an execution-spine fault at the OpenCode event parser: version-drifted flattened events now produce bounded evidence instead of terminating stream processing. [Evidence](evidence/opencode-event-boundary-g393.md).

G392 confirms the required fleet dependencies are reachable again; deployed production identity remains authenticated-only and OpenMythos certification remains fail-closed. [Evidence](evidence/assurance-recheck-g392.md).

G388 revalidated the complete workspace after the shared auth-session repair; route/API topology remains green. [Evidence](evidence/workspace-regression-g388.log).

G387 confirms the mounted dashboard navigation reaches 32 local routes and their API projections; unavailable authority storage is surfaced explicitly. [Evidence](evidence/browser-local-crawl-g387.md).

G385 confirms the isolated server starts and exposes health/version, while authenticated provenance remains a deliberate boundary. [Evidence](evidence/live-identity-g385.md).

G383 revalidated the governed evolution path after metric repair; architecture evidence remains local and bounded. [Evidence](evidence/loops-self-check-g383.log).

G380 closes a measurement edge in the learning graph: `socialize()` → two messages → one recorded exchange. [Evidence](evidence/evolution-social-count-g380.md).

G379 revalidates the terminal external edges of the graph: local checks pass, but live identity/OpenMythos evidence edges are unavailable, so promotion remains blocked. [Evidence](evidence/assurance-recheck-g379.md).

G378 refreshes the truth-source differential: live production exposes a 200 shell and public version but protects health/OpenAPI/metrics with `AUTH_REQUIRED`; GitHub `main` is three commits ahead of the audit HEAD. [Evidence](evidence/live-github-recheck-g378.md).

G375 verifies that every declared route has a direct bounded test edge in the capability graph; remaining uncertainty is semantic/provider depth, not an unreferenced route declaration. [Evidence](evidence/module-covered-routes-g375.md).

G374 revalidates the local system graph after the Explainer unpublish chain: build → full workspace/server tests → governed loop subset → route/integration/table assurance all pass; external truth/live edges remain fail-closed. [Evidence](evidence/assurance-recheck-g374.md).

G370 verifies the Explainer governance mutation path: authenticated HTTP unpublish request → bundle status update → durable `bundle_unpublish` audit row. [Evidence](evidence/explainer-unpublish-g370.md).

G366 verifies the workstation URL path from authenticated HTTP through bounded native socket inventory to a structured response. [Evidence](evidence/workstation-urls-g366.md).

G359 closes the skill mutation mapping locally: operator requests reach the shared skill router, explicit unavailable activation/reload semantics remain fail-closed, and assignment state persists/removes through SQLite. [Evidence](evidence/skills-canonical-g359.md).

G357 confirms the knowledge-bus transport chain locally: authenticated subscription, connected event, claim stream and cleanup of subscription/keepalive on disconnect. Provider execution and production identity remain outside the verified boundary. [Evidence](evidence/verification-g357.md).

G355 closes the knowledge SSE transport chain locally: authenticated subscription, connected event, and disconnect cleanup execute over a real HTTP server. [Evidence](evidence/knowledge-sse-route-g355.md).

G352 closes the swarm broadcast chain: canonical HTTP broadcast persists structured messages, preserves idempotency, and rejects forged agent identities. [Evidence](evidence/swarm-broadcast-route-g352.md).

G349 closes policy mutation reachability: canonical PATCH and DELETE operations persist, version, audit, and remove policy state over local HTTP/SQLite. [Evidence](evidence/policy-mutation-routes-g349.md).

G335 closes the local knowledge event projection read: a durable `swarm_claims` row is returned through the bounded `/knowledge/events` HTTP path, with invalid limits rejected before query execution. This is local evidence only; production authentication and SSE delivery remain unverified. [Evidence](evidence/knowledge-events-route-g335.md).

G333 refreshes verification against the current checkout after SEGML/Gym/compliance repairs: build, type-check, lint and scoped assurance gates pass; external truth/live gates remain fail-closed. [Evidence](evidence/verification-g333.md).

G304 proves authenticated operator intervention resume and advisory gate-override projections: pause ownership is enforced, resume restores only the operator pause, and override records intent without relabeling failed verification. [Evidence](evidence/intervention-route-g304.md).

G303 proves the citation-research chain: source registration, citation-linked claims, contradiction detection, idempotent repeated detection, report generation and aggregate statistics execute over authenticated local HTTP/SQLite. [Evidence](evidence/research-route-g303.md).

G302 proves the meta-orchestration visibility chain: stats, tuning history, routing optimization and strategy recommendation return bounded local projections through authenticated HTTP. [Evidence](evidence/meta-orchestration-route-g302.md).

G301 proves the red-team assessment chain: all 12 configured attack vectors are evaluated against the governance fixture, the report is persisted, and latest/history projections return the same result over authenticated local HTTP/SQLite. [Evidence](evidence/red-team-route-g301.md).

G300 proves a bounded governance-feedback evolution chain: two correction events become an analyzable repeated pattern, then an explicit apply action marks both durable entries applied through authenticated local HTTP/SQLite. [Evidence](evidence/governance-feedback-route-g300.md).

G299 proves the execution-evidence projection chain: owned-task evidence filtering, durable file-change projection and canonical audit-trail projection all execute over authenticated local HTTP/SQLite, including typed missing-task behavior. [Evidence](evidence/evidence-route-g299.md).

G298 proves the legal RuleOps route chain: PII classification, ECLI subject-area lookup and legal-engine status are executable over authenticated local HTTP, with malformed inputs rejected. [Evidence](evidence/legal-route-g298.md).

G297 proves catalog aggregate projections after durable reopen: imported/evaluated/active/duplicate/rejected counts and evaluation summary agree over the authenticated catalog HTTP boundary. [Evidence](evidence/catalog-route-g297.md).

G296 proves the remaining proactive-memory evolution projections: repeated access promotes an active memory, top-memory retrieval returns it, relation discovery is callable and duplicate consolidation removes the victim durably. [Evidence](evidence/memory-evolution-route-g296.md).

G295 proves authority trace/stats/events, risk command/task classification and the full live-canvas HTTP session stream/completion chain over local SQLite/in-memory session state. [Evidence](evidence/risk-canvas-authority-g295.md).

G294 proves the first real self-hosted improvement chain: Astra maker patch → deterministic checks → separate Astra checker → verification gates, with immutable-file/worktree evidence and a deliberate security-review HOLD. No promotion occurred. [Evidence](evidence/self-hosted-improvement-g294.md).

G293 proves the usage/economy projection chain, governance-feedback no-evaluation path and self-improvement reconciliation reads: authenticated token-usage ingestion is durable and observable through token, cost, quota, available-model and recent-usage reads, while feedback health/propose/run and proposal retrieval/rejection/reconciliation reports close locally. The focused routes, server/workspace regressions and governed `/loops` pass; external provider behavior remains unverified. [Usage](evidence/usage-route-g293.md), [Governance feedback](evidence/governance-feedback-route-g293.md), [Self-improvement](evidence/self-improvement-route-g293.md).

G291 proves memory-evolution governance locally: ingest, evaluation, promotion eligibility and evaluator lease create/list with typed validation. [Evidence](evidence/memory-evolution-route-g291.md).

G281 proves cognitive loop-closure learning: durable episodes become patterns and advisory strategies with measured outcomes. [Evidence](evidence/cognitive-evolution-route-g281.md).

G280 proves Apex inventory/status projections and explicit fail-closed plugin activation over HTTP/SQLite; provider-backed memory/LLM execution remains separate. [Evidence](evidence/apex-inventory-route-g280.md).

G279 proves the discussion governance chain: proposal and vote persistence, consensus closure and timeline projection over HTTP/SQLite. [Evidence](evidence/discussion-governance-route-g279.md).

G278 proves swarm-orchestration session/progress persistence and durable idempotent agent messaging; unavailable runtime execution remains explicitly 503/fail-closed. [Evidence](evidence/swarm-orchestration-route-g278.md).

G277 proves the swarm-intel plan and skill-evolution chain over HTTP/SQLite and repairs execution-plan migration drift (`subtasks_json`/`tasks_json`) at the shared service boundary. [Evidence](evidence/swarm-intel-evolution-route-g277.md).

G276 proves the explainer provider pipeline route on a synthetic local repository: task admission → HTTP run → completed status → persisted bundle listing, with typed invalid/missing-resource responses. External provider quality remains unverified. [Evidence](evidence/explainer-pipeline-route-g276.md).

G275 adds direct explainer task route evidence using the production-equivalent schema: invalid input, create, list, retrieve and missing-resource behavior execute over HTTP/SQLite. Provider pipeline execution and production auth remain separate gates. [Evidence](evidence/explainer-route-validation-g275.md).

G274 closes a workflow-governance false-success: advanced approve/reject routes now require a gate node and return typed 409 for task nodes without mutating state. Full regressions and `/loops` remain green. [Evidence](evidence/advanced-governance-g274.md).

G274 also refreshes the read-only public/GitHub boundary: production root/version are reachable, protected health remains 401, and `origin/main` is `259773b68d1d328195d72f74e176dc2d9924f215`; authenticated semantics remain unverified. [Evidence](evidence/live-github-recheck-g274.md).

G273 closes a direct semantic gap in the advanced HTTP surface: context compression/retrieval/stats and workflow graph progression now execute end-to-end over local HTTP/SQLite. Server/workspace and `/loops` regressions remain green; assurance remains fail-closed on external identity/evidence. [Advanced routes](evidence/advanced-route-validation-g273.md), [Server](evidence/server-regression-g273.md), [Workspace](evidence/workspace-regression-g273.md), [Loops](evidence/loops-self-check-g273.log).

G272 closes direct observability route proof and repairs the isolated fixture schema needed to exercise canonical metrics queries. Metrics, risk trends, policy stats and execution activity now have HTTP/SQLite evidence; full server/workspace and `/loops` regressions remain green. [Observability](evidence/observability-route-validation-g272.md), [Server](evidence/server-regression-g272.md), [Loops](evidence/loops-self-check-g272.log).

G271 closes the direct `/skills` route-proof gap: admitted skill reads, rejected-skill filtering, missing-resource handling, agent projection and anonymous denial now execute over HTTP/SQLite. Direct contract coverage is 363/585; `/loops` remains green. [Skills](evidence/skills-route-validation-g271.md), [Loops](evidence/loops-self-check-g271.log).

G270 rechecks the executable route and evolution boundaries: 619 registered routes, 610 anonymous auth denials, 585 classified source routes, 358 directly exercised, and 56/56 MCP tools classified. The controlled product-evolution fixture reproduces its seeded defect and immutable-boundary checks without starting a provider. [Routes](evidence/route-contract-recheck-g270.md), [Evolution](evidence/evolution-preparation-g270.md), [Loops](evidence/loops-self-check-g270.log).

G266 closes the explicit Astra loop boundary: governed `/continue` and `/retry` choices are validated, persisted on maker leases, and forwarded to durable executor-task metadata. Full workspace/server and `/loops` regressions remain green; route registration was refreshed to the current source fingerprint. [Astra](evidence/astra-loop-forwarding-g266.md), [Regression](evidence/workspace-regression-g266.md), [Routes](evidence/route-registration-g266.md).

G265 integrates the governed social-runtime evolution chain: signed agent heartbeats, scoped social leases, redacted message delivery, idempotent peer responses, candidate-only reflection and bounded learning-loop socialization are executable. [Evidence](evidence/social-runtime-g265.md), [Routes](evidence/route-registration-g265.md), [Loops](evidence/loops-self-check-g265.md).

G264 closes the worker persistence false-green: completed and failed worker results now survive service restart in `worker_results`, and metrics is truthfully a read-only snapshot. [Evidence](evidence/worker-result-persistence-g264.md), [Regression](evidence/server-regression-g264.md), [Workspace](evidence/workspace-regression-g264.md).

G263 corrects the memory worker's semantic contract: expired `vector_memories` are intentionally deleted under explicit TTL policy and reported as deletion, not archival. [Evidence](evidence/memory-ttl-purge-truth-g263.md), [Regression](evidence/server-regression-g263.md), [Loops](evidence/loops-self-check-g263.md).

G262 removes four background-worker false-success paths: unconfigured test-gap, governance-recert, worktree-cleanup and evidence-compaction workers are disabled by default and manual runs return explicit `WORKER_UNAVAILABLE`; health, archival, metrics and lease cleanup remain executable. [Evidence](evidence/background-workers-truth-g262.md), [Regression](evidence/server-regression-g262.md), [Loops](evidence/loops-self-check-g262.md).

Evidence checkout: `/Users/dlandman/djimitflo-audit-20260909`, canonical base `c0c8d72b`. This report distinguishes observed fixture execution from source reachability and live operational proof. Counts are regenerated in [capability-graph.json](capability-graph.json).

Latest checkpoint G259: authenticated swarm mission-control reads and mutations now enforce the shared evidence/swarm-action permission boundary; role-matrix HTTP tests prove denied roles cause no writes. Full server/workspace regressions, `/loops`, contract inventory and route-registration checks pass. The system map still does not claim production authenticated semantics or external-provider certification. [Evidence](evidence/swarm-mission-permissions-g259.md), [Regression](evidence/server-regression-g259.md), [Loops](evidence/loops-self-check-g259.md).

G260 extends the same shared authorization boundary to memory evolution: trace ingestion, evolution scheduling, promotion evaluation and lease creation now require explicit evidence/governance permissions, with authenticated role-matrix proof and no unauthorized persistence. [Evidence](evidence/memory-evolution-permissions-g260.md), [Regression](evidence/server-regression-g260.md), [Loops](evidence/loops-self-check-g260.md).

G261 closes the remaining mount-only authorization gap in meta-orchestration, malformed prediction admission and the empty-history tuning 500: all meta reads and prediction require `read:evidence`, invalid prediction bodies return 400, tuning execution remains `write:governance`, and no cognitive history yields explicit zero work. Focused HTTP proof, full server/workspace regressions and governed loops remain green; production identity and external provider certification are still unclaimed. [Evidence](evidence/meta-route-permissions-g261.md), [Regression](evidence/server-regression-g261.md), [Loops](evidence/loops-self-check-g261.md).

G261's read-only live boundary recheck confirms the public shell and API version are available while `/api/health` and `/api/openapi.json` correctly require authentication. Authenticated production UI and deployed commit identity remain unverified. [Evidence](evidence/live-public-recheck-g261.md).

G243 reconciles persistence scopes: the graph's disposable `.data/audit.sqlite` has 165 tables, while the root `audit:tables` default `.data/djimitflo.sqlite` has 167; `context_cache` and `github_webhook_deliveries` exist only in the runtime-shaped input and are source-reachable, while both scans report the same 11 statically unreachable tables. Both read-only reports are retained in the graph; no production liveness is inferred. [Evidence](evidence/database-scope-reconciliation-g243.md).

## Latest bounded continuation — G72–G108

G160 reran fail-closed assurance with isolated evidence outputs: local dependency, contracts and integrations pass; OpenMythos and live identity remain blocked/failed for documented external reasons. [Evidence](evidence/assurance-truth-g160.md).

G159 repaired task/discussion pagination at the HTTP boundary and revalidated the full server, route inventory and governed loops. [Evidence](evidence/tasks-discussions-pagination-g159.md), [full regression](evidence/full-server-regression-g159.md).

G158 re-ran the governed loop regression after the G156/G157 boundary fixes: 23 files, 291 passed and 1 explicit skip. [Evidence](evidence/loops-self-check-g158.md).

G202 adds the shared repository-root resolver to `GoalBatchService`, closing a server-workspace cwd break in the goal-batch → goals/loops path. The repair is covered by a direct regression plus full server/workspace and `/loops` execution. [Evidence](evidence/full-server-regression-g202.md)

G203 applies the same root-resolution boundary to `OpenCodeHealthService`, so runtime configuration inspection follows the monorepo identity when launched from a workspace package. [Evidence](evidence/full-server-regression-g203.md)

G204 applies the root boundary to the federation inbox → LoopService edge, preserving canonical repository identity for externally offered work. [Evidence](evidence/full-server-regression-g204.md)

G205 refreshes the route graph fingerprint and anonymous-auth sweep after the federation route source change. [Evidence](evidence/route-inventory-recheck-g205.md)

G206 records the current public edge and remote main identity without claiming parity or private behavior. [Evidence](evidence/live-github-sweep-g206.md)

G207 records canonical repository-root resolution for SEGML training artifacts, preserving workspace-package launches without cwd leakage. [Evidence](evidence/full-server-regression-g207.md)

G208 records the latest loop-control and assurance truth recheck; local orchestration remains green, external evidence gates remain fail-closed. [Evidence](evidence/loops-self-check-g208.md), [Evidence](evidence/assurance-truth-g208.md)

G209 records the catalog compiler's six-target artifact boundary: all targets compile deterministic instructions, while only OpenClaw/Codex are activation-capable; integrated regressions pass. [Evidence](evidence/catalog-compilation-g209.md), [Evidence](evidence/workspace-regression-g209.md)

G210 records deterministic OIDC signature regression coverage and retains the unrelated parallel permission anomaly as UNKNOWN. [Evidence](evidence/oidc-tamper-test-g210.md)

G211 records agent-catalog SQLite persistence at the shared monorepo `.data` root, with explicit environment override retained. [Evidence](evidence/catalog-root-resolution-g211.md)

G212 records the current public edge, remote main identity and fail-closed assurance result without claiming production parity. [Evidence](evidence/live-github-sweep-g212.md), [Evidence](evidence/assurance-truth-g212.md)

G99 revalidated the authenticated `/loops` route and the current contract/table reachability inventories. The route chain remains locally executable and evidence-backed; external provider quality, promotion and deployment remain gated. [Evidence](evidence/loops-recheck-g99.md).

G100 repaired SEGML Level 3 scenario-count validation at the HTTP boundary; invalid values now fail closed with structured 400 responses. [Evidence](evidence/segml-l3-route-validation-g100.md).

G101 records a transient full-suite scheduler 401 that passed in isolation and on immediate rerun; the failure remains UNKNOWN. [Evidence](evidence/workspace-recheck-g101.md).

G102 reran the complete workspace suite after the SEGML route repair: 2719 tests passed and 20 skipped; external assurance remains fail-closed. [Evidence](evidence/workspace-recheck-g102.md).

G103 adds bounded integer validation to OpenMythos list/trend routes, preventing malformed query limits from reaching SQLite. [Evidence](evidence/openmythos-limit-validation-g103.md).

G104 reran the complete server regression after the OpenMythos repair: 2432 passed and 20 skipped. [Evidence](evidence/server-recheck-g104.md).

G105 repaired research threshold validation; G106 reran the complete server regression with 2433 passed and 20 skipped. [G105](evidence/research-limit-validation-g105.md), [G106](evidence/server-recheck-g106.md).

G107 repaired advanced governance-feedback limit validation; malformed values now fail closed before SQLite. [Evidence](evidence/advanced-limit-validation-g107.md).

G108 recorded one transient route-permissions failure during a full server run; the focused test passed 5/5 and the immediate full rerun passed 2434/20 skipped. [Evidence](evidence/server-recheck-g108.md).

G109 reran the complete root workspace command: 2721 tests passed and 20 skipped; root type-check and lint also passed. [Evidence](evidence/workspace-recheck-g109.md).

G110 reran `assurance:truth`; local gates pass, while OpenMythos remains BLOCKED and live deployment identity FAILS, preserving fail-closed assurance. [Evidence](evidence/assurance-recheck-g110.md).

G111 repaired audit pagination validation and re-ran server, workspace and `/loops` checks: 2435/20, 2722/20 and 12/12 respectively. [Evidence](evidence/audit-pagination-validation-g111.md).

G112 repaired governance-feedback history pagination and revalidated server/workspace suites at 2436/20 and 2723/20; a transient swarm-intelligence 401/400 mismatch remains retained as UNKNOWN. [Evidence](evidence/governance-feedback-pagination-g112.md).

G113 rechecked assurance truth after the route repair; local gates pass, while OpenMythos remains BLOCKED and live deployment identity FAILS. [Evidence](evidence/assurance-recheck-g113.md).

G114 repaired SEGML history pagination and revalidated server/workspace, `/loops` and route-inventory evidence. [Evidence](evidence/segml-history-validation-g114.md).

G115 repaired memory-evolution retrieval pagination; server remains 2438/20 and the complete workspace rerun passes 2724/20 after one retained route-inventory intermittency. [Evidence](evidence/memory-evolution-validation-g115.md).

G116 repaired gym governance-history pagination; server 2439/20, workspace 2726/20, `/loops` 12/12 and route inventory 581/261 are green. [Evidence](evidence/gym-history-validation-g116.md).

G95 adds a successful full build and a fresh fail-closed assurance recheck; G94 adds a full workspace exit-0 recheck. [G95 evidence](evidence/build-assurance-recheck-g95.md), [G94 evidence](evidence/workspace-recheck-g94.md).

G96 separately rechecked the external OpenMythos and live-identity prerequisites; both remain blocked. [G96 evidence](evidence/external-prerequisite-recheck-g96.md).

G97 rechecked the public production bundle and confirms Pipeline Builder Save remains alert-only. [G97 evidence](evidence/live-differential-recheck-g97.md).

G93 adds a real supervised Codex maker/checker/security-checker proposal on a disposable product-source fixture; it remains review-required and unpromoted. [Evidence](evidence/controlled-product-improvement-g93.md).

Existing polling now closes durable outcomes→assessment→advisory work item transactionally. Cognitive projections refresh distinct durable outcomes on new episodes/startup; confidence-gated meta tuning now applies durable loop parameters, while strategy actions remain advisory. Valid learning closure shares checker/risk enforcement and binds completed improvement evidence to evaluating only. Task and loop workers now receive one hashed advisory experience snapshot; GitHub intake remains work-item-only. ToolBroker token validation now requires the presenting principal and rejects bearer-style omission. G78 adds authenticated OpenMythos attestation import and promotion-safe WorldLab retest/evidence-graph intake. G79 makes persisted Codex/Astra runtime selection authoritative for execute calls without an override. G82 proves production/local Pipeline Builder drift: deployed Save is an alert-only stub while local Save persists validated drafts. G84 removes process-wide cwd mutation from proof-run repository identity. 614 actual API registrations and608 anonymous denials are mapped. Six goals and an actual failed-loop control are stored. [G84 isolation evidence](evidence/proof-run-cwd-isolation-g84.md), [G83 broker evidence](evidence/tool-broker-principal-required-g83.md), [G82 differential evidence](evidence/live-local-differential-g82.md), [G80 evolution evidence](evidence/meta-tuning-chain-g80.md), [G79 dispatch evidence](evidence/astra-runtime-dispatch-continuation.md), [G78 intake evidence](evidence/openmythos-worldlab-attestation-continuation.md), [context/governance evidence](evidence/context-governance-continuation.md), [G77 broker evidence](evidence/tool-broker-principal-boundary.md).

G85 re-ran the governed loop/evidence path: 47 assertions passed and one controlled-provider case was intentionally skipped. This confirms repeatable evolution guards, not improved unseen-task outcomes or autonomous promotion. [Evidence](evidence/evolution-loop-recheck-g85.md).

G86 removes the SEGML Level 5 simulated-metric proof path; no applied evolution is reported without an executable artifact and independent checker. [Evidence](evidence/segml-level5-no-false-proof-g86.md).

G89 confirms the same non-false-proof boundary at the authenticated HTTP route and durable SQLite state. [Evidence](evidence/segml-level5-http-g89.md).

G91 confirms the `/loops` route-to-state-to-review-bundle chain over authenticated HTTP. [Evidence](evidence/loops-http-proof-g91.md).

G92 confirms the controlled maker/checker route chain and approval boundary using a disposable fake Codex runtime. [Evidence](evidence/loops-maker-checker-route-g92.md).

## Historical bounded continuation — G68–G71

The existing approval ledger now commits transitions with canonical audit; post-commit notification failure does not undo the durable outcome. Execution approval is bound to current inputs and expiry; capacity-wait admission rechecks current policy. The local mock fixture changed input, required a new decision, rejected the same checker, completed after a distinct fixture approver, and retained its state across restart. [Atomicity](evidence/approval-atomicity.md), [HTTP/SQLite restart](evidence/lifecycle-http-after-restart.json).

Core `agents` registration updates identity in place; heartbeat records observations without activating inactive agents. Retirement retains an audited archive and uses the existing `offline` plus `retired_at` representation, refusing non-quiescent work. It does not replace the separate lifecycle subsystem or implement process draining. [Lifecycle proof](evidence/agent-lifecycle-continuation.md).

Review/export now derive current summaries from canonical task/event/evidence/approval/file rows inside one transaction, retaining the existing materialization identity. Unknown policy/start data and configured-versus-observed executor attribution remain explicit. [Summary proof](evidence/evidence-summary-continuation.md). OpenMythos publishes only fully validated caches and binds provenance to the exact cached bytes; no corpus or certification authority changed. [Cache proof](evidence/openmythos-cache-integrity.md).

G68–G71 full suite: **2,656 passed / 20 skipped**; build/type/lint pass; scoped mutation **71/71 killed**. HTTP/SQLite restart passes; [joined browser evidence](evidence/lifecycle-closure.md) passes. [Checks](VERIFICATION_REPORT.md). Assurance remains BLOCKED by actual external-evaluation/identity prerequisites. The 2,572-test result below is historical. No new native provider or deployment execution is claimed.

## Historical bounded continuation — G66–G67

The existing AuthService/refresh_tokens ledger now closes browser login, HttpOnly-cookie rotation, shared request recovery and logout. Session-bound JWTs preserve organization context, survive local server restart and are revoked across HTTP and protected WebSocket delivery; live MCP validates its existing canonical database. Actual concurrent Chromium tabs caused exactly one rotation. [Joined source-to-execution evidence](evidence/g66-session-closure.md). Full regression2572passed/20skipped. This is session lifecycle, not universal tenant-row isolation or autonomous provider continuation. G67 fixes full source-state hashing above1MiB; no new dependency/control plane was added.

## Historical bounded continuation — G62–G65

[Final integrated regression](evidence/session-conversion-tests-integrated.log): **2,510 passed, 20 skipped**, including 2,267 server and 115 dashboard tests; build/type-check/lint passed. The [new scoped mutation rerun](evidence/session-conversion-mutation.log) detected **73/73**, with zero survivors, uncovered cases or errors, limited to its same three configured regions. Earlier counts below remain historical. No provider ran in this tranche.

HTTP authentication now binds current account authority and validates selected organization membership; existing WebSocket deliveries recheck account status/role/email. [Principal/login evidence](evidence/auth-principal-continuation.md). Organization switching adopts the replacement token through the existing store and requests reload; server listing permits switch-back and audit preserves the actual source context. [Organization workflow evidence](evidence/organization-selector-continuation.md). This is token-context behavior, **not certified tenant-row or multi-tenant WebSocket isolation**.

The actual browser completed assigned organization → default → server restart/reload → assigned organization, with matching replacement-token scopes and two correct canonical audit rows. [Browser/database evidence](evidence/organization-browser-db.json). [Aggregate assurance](evidence/assurance-session-conversion.json) remains BLOCKED by OpenMythos maturity and live identity; the other checks pass.

Work-item conversion now atomically creates/links one goal and returns the same identity on retries. Actual browser conversion, duplicate request and reload matched [file-backed SQLite](evidence/work-item-browser-db.json), including [after server restart](evidence/work-item-browser-after-restart.json): one planned item, one created goal, no loop runs or provider execution. [Correction and regression scope](evidence/work-item-conversion-continuation.md). The repaired [refresh-token service](evidence/refresh-token-continuation.md) remains disconnected from API/frontend; automatic session refresh and current access-JWT logout revocation are not implemented.

## Historical bounded continuation — G56–G61

Integrated verification: **2,447 tests passed, 20 skipped**, build/type-check/lint passed, and **73/73 scoped mutation cases detected**. Logs: `evidence/continuation-tests-final.log`, `continuation-{build,typecheck,lint}-final.log`, `continuation-mutation.log`. These results do not establish every source route or production channel as operational.

Operator intervention now follows UI → authenticated REST → existing intervention/claim/audit services → SQLite. Pause is quiescent admission control: prepared/running leases or nonterminal tasks return409, not a fabricated process checkpoint. Proposed knowledge returns a real stored claim ID; operator gate advice is audited separately and does not replace measured gates. Actual browser pause/inject/advice → server restart → Resume/reload retained ownership, original gates and proposed claim, with **zero tasks/leases and requeued0**. Shared loop, nested-spawn and execution-engine admission honor the pause, including semaphore/fallback and canonical historical worker bindings. [Execution boundaries and browser evidence](evidence/intervention-continuation.md).

Continue now calls the existing planner and persists per-finding advice in lease/event metadata. Eligibility uses matching, admitted capabilities and runtime-attributed history; dispatch still uses an explicit runtime or `manual`. Advice is not recorded as actual capability use and does not auto-select Astra or any paid provider. [Routing evidence](evidence/routing-continuation.md).

Knowledge tooling can be independently configured through the trusted absolute `OKF_VALIDATOR_PATH`; the actual data bundle is unchanged. The running audit server uses the existing canonical validator and reports `knowledgeRuntime:ok`. Its174-file structural acceptance excludes172 non-OKB types from typed checks and does not certify capabilities. Deep health remains503 solely for intentionally loopback-refused Ollama/Qdrant; dirty intended revision independently blocks live-identity certification. OpenMythos structural checks pass; exact-model R28 repeatability now passes while R29 held-out discrimination is executed and fails on paired regressions, so certification remains BLOCKED. The repaired report predicate cannot promote labels or an empty corpus into certification. [Prerequisites and correction](evidence/assurance-prerequisites-continuation.md), [actual identity checks](evidence/identity-continuation.json), [executed evaluation](evidence/openmythos-executed-evaluation-g150.md).

No new provider ran in G56–G61. The earlier real three-worker Astra product repair remains historical evidence, not a rerun. Production browser discovery remains empty; authenticated production differential and live Telegram delivery are still unavailable.

Latest contract inventory:571source routes,189test-source matches,56MCPtools/28matches (`evidence/contracts-session-conversion.json`). Earlier figures below are historical checkpoints. These matches are source heuristics, not executed endpoint counts. G43–G50 add operational catalog and browser-to-real-Astra task proof, shared terminal audit transactions and canonical execution-event WebSocket timestamps; see VERIFICATION_REPORT.md and BROWSER_TASK_EXECUTION.md. Agent admission now rejects unavailable/quarantined assigned agents before each new start, but agent capability metadata still does not select the engine executor.

## Execution and state ownership

The existing repo-maintenance loop now has actual supervised product-source execution evidence: operator-supplied finding→isolated maker→deterministic checks→separate checker→security HOLD→separate security checker→review-required patch. G51's exact patch was applied locally after independent review. G52/G53 complete existing review/retry/verifier seams; no new scheduler or authority was added. The loop remains distinct from universal ToolBroker mediation, human integration approval and unattended self-discovery. See AUTONOMY_REPORT.md and `evidence/controlled-product-improvement-v2.json`.

Catalog is a separate five-table SQLite store (`profiles`, `evaluations`, `activations`, `audit_ledger`, `overlaps`), in addition to165 core tables. Its registry prepares compiled artifacts; it does not register core agents, deploy files, or dispatch work. Profile changes and failed reevaluations now invalidate prepared artifacts atomically with their audit. Exact manual scores persist; static-only passes have no invented numeric score. Batch evaluation is atomic. The graph records this additional database explicitly instead of inferring core-agent reachability from the word activation.

React dashboard (`packages/dashboard/src/App.tsx`) routes authenticated pages through `ProtectedRoute`, `WebSocketProvider`, initial task/agent loading, Zustand stores and `lib/api.ts`. Page imports include additional control components: a page-only scan misses approval buttons, compliance actions and catalog controls. The reconstruction script follows local component imports and generic `api.request` calls.

Express (`packages/server/src/routes/index.ts`) mounts domain routers behind JWT authentication and route-level permission guards. Its declarative mounts feed `/api/openapi.json`. That output contains methods, paths and authentication metadata; it does not define request/response schemas. Additional top-level routes such as version and workstation URLs are outside that mount inventory.

`ExecutionEngine` owns task dispatch, approval pauses and resumptions, executor selection, events and execution evidence. SQLite tasks/approvals/audit tables preserve state; `ApprovalService` records decisions and emits task-scoped WebSocket events. Existing executors, loops, work-items and fleet workers are distinct execution paths and must be proven separately. A runtime constructor or task row does not establish dispatch.

`AuditService` delegates to `ComplianceAuditService` for canonical append-only/hash-chain records. HTTP export streams stored audit events as NDJSON. The new HTTP assertion compares every exported ID with the ordered database IDs; it proves export semantics in a disposable fixture.

`ToolBroker` is instantiated by `ExecutionEngine` and exposes policy evaluation/capability tokens. At the audited base, tracked production code contains no call of `evaluateToolCall`, `validateCapabilityToken`, or `getToolBroker` outside their defining classes. Deep Agent issuer/executor use a distinct signed no-tool canary contract, not this broker. Therefore universal runtime ToolBroker mediation is **DISCONNECTED**, even where broker unit invariants pass. Parent integration work must explicitly update this observation if it changes the call graph.

## Capability/channel differences

| Capability | Browser/REST | WebSocket | MCP | Telegram |
|---|---|---|---|---|
| Approval review | Shared ApprovalService via ExecutionEngine; real HTTP role+state fixture proved | Service emits task-scoped decision events; fixture uses recorder/no-op transport | `approve_action` now forwards real task-bound requests via the authenticated REST service; manual review cannot dispatch execution | Webhook mapped identity → canonical approval REST → engine continuation/denial; local mock execution/audit proven. Polling approval commands and live delivery are not proven |
| Task execution | Task route -> ExecutionEngine -> executor | Engine event stream -> task subscriptions | Tools differ: creating metadata is not dispatch | Polling/webhook use mapped current accounts and shared task REST for pending creation/status/cancel; direct task SQL removed. Local transport proven; creation is not dispatch |
| Agent registration / spawn | Nested-spawn route/service has scoped token paths | Depends on spawn service/runtime path | Repaired `spawn_agent` explicitly reports registration only; idle agent insertion is not task dispatch or execution | No equivalent proven |
| Handoff | Fleet/nested runtime services | No cross-channel parity proof | Inserts pending `fleet_handoffs`; consumer execution must be demonstrated | No equivalent proven |
| Evidence/audit | Domain reads, append service, export | Event notification does not prove durable audit | Direct DB read tools report DB provenance | Status replies do not certify runtime output |

Telegram proof uses actual grammY updates, assembled Express routing, local authenticated HTTP, SQLite/audit and MockExecutor; provider replies/polling are intercepted. Unknown/unlinked/disabled callers, changed roles and explicit delivery failures are tested. No live Telegram delivery, exactly-once update replay or simultaneous polling/webhook operation is claimed. [Detailed transport scope](evidence/telegram-continuation.md).

## Approval defects repaired in this tranche

All non-admin approval queues were broken: platform-admin/auditor/approver visibility is intentionally unrestricted (`null`) but the route dereferenced `.clause`; owner-filtered roles used `tasks.*` while the query renamed the table `t`. List and detail now share the established approval-visibility policy. An independent approver can read and decide another maker's pending request, while read-only roles cannot mutate it.

PATCH previously coerced arbitrary JSON with `Boolean(approved)`: the string `"false"` approved an action. Shared `ApprovalService` now accepts booleans only, and REST preserves the original value for validation. Invalid expiry timestamps now expire instead of passing the NaN comparison. Cancellation only updates pending rows, preserving terminal decisions.

Proof: `approvals-http.test.ts` uses real JWT middleware, all seven roles, actual HTTP and SQLite state/audit assertions. `critical-http-contracts.test.ts` supplies malformed decisions and invalid expiry plus terminal cancellation. The original malformed decision returned HTTP 200; the original role queue returned HTTP 500. Focused rerun passed 32 tests across these two files and execution-engine tests. This proves those local contracts, not browser-to-real-agent completion.

## Database reachability

The local disposable schema exposes 165 tables. `audit:tables` is read-only but includes test/schema references and uses regex SQL matching. The scan now excludes DELETE FROM targets while preserving subquery reads (`node scripts/table-reachability.test.mjs`). Independent graph classification removes tests, schema and migrations: after persistence repairs, 140 have source readers and writers, 4 are read-only, 9 write-only and 12 without either. `code_chunks` was falsely ACTIVE because deletion counted as a read; the corrected scan exposed real loss of indexed content, which is now repaired with durable search and atomic snapshot storage. Swarm sessions and audit anchors also have repaired durable readers. Dynamic SQL, comments, aliases and unusual quoting still require manual tracing. These source categories are not production activity claims; semantic dispositions are in TABLE_REACHABILITY_REVIEW.md.

Targeted semantic review is in [TABLE_REACHABILITY_REVIEW.md](TABLE_REACHABILITY_REVIEW.md). `swarm_sessions`, `code_chunks` and `audit_anchors` lost durable reachability and were repaired with fixture/reopen tests. `model_execution_outcomes` feeds a separate durable routing projection, and `self_model_snapshots` retains recomputable calibration; these are not equivalent to a broken operational chain. Fleet assignment/sync records still lack downstream execution/promotion consumers. No production rows were deleted by the audit.

The graph marks dynamic query/import limitations explicitly. `UNREACHABLE` means no detected production SQL reader/writer, not permission to remove a table. Legacy/experimental/orphan classifications need design/history evidence beyond absence of matches.

## Assurance scope and evidence isolation

`assurance:truth` runs dependency audit, contract inventory, OpenMythos corpus validation, integration probes, live identity and diff checks. Without `--full`, it does not run build, lint, type-check or tests. `assurance:route-contracts` currently passes a flag that the inventory script does not inspect; it is the same route-and-MCP source matcher.

Contract baseline: 570 source routes, 167 test-source matches, one critical unmatched audit-stream route; 56 MCP tools, 28 handler-source matches. Adding the actual audit stream HTTP test produced 168 route matches and zero critical unmatched routes. This count is not a count of successfully executed endpoints.

After the task-bound manual approval route and protected health/authority tests, final inventory is 571 source routes with 172 matched test references and zero critical unmatched routes. MCP remains 56 tools / 28 matched references / zero critical unmatched tools. Both contract commands exit zero. The final focused approval/health/authority/export/manual-review HTTP run passed 10 tests, the MCP authority run passed 3, and identity assertions passed. During a local server restart, the aggregate truth run correctly retained unavailable liveness as fail/blocked; consult parent final verification for the stable runtime rerun.

Three assurance scripts previously overwrote tracked OpenSpec evidence. They now accept `INTEGRATION_REPORT_PATH`, `LIVE_IDENTITY_REPORT_PATH` and `OPENMYTHOS_REPORT_PATH`; existing `ASSURANCE_REPORT_PATH` and `CONTRACT_INVENTORY_PATH` already worked. All current outputs are isolated under `evidence/` here.

Initial default integration probes passed their health/JSON contracts and binary version checks. These are live infrastructure observations only, not publication or task execution. OpenMythos structural validation passed but certification remains blocked: 351 cases, only 7 validated, 318 reviewed and 26 draft; exact-model repeatability passes, while the executed held-out policy pair rejects on three regressions. Default local identity failed because port 3001 was absent. Retargeting the isolated local server at port 3187 returned BLOCKED: unauthenticated runtime readiness and dirty source cannot establish deployment identity.

The live identity script originally treated HTTP success as provenance. It now requires matching full source revisions in health and authenticated deep-health provenance, matching local/observed database instance IDs, live mode, local database integrity and a clean checkout. A runnable Node assertion rejects missing bodies, wrong revisions, wrong databases, snapshots, dirty patches and HTTP-only false positives. `DJIMITFLO_LIVE_AUTH_TOKEN` supplies optional read credentials without storing them in the report. The current uncommitted audit cannot certify itself as the deployed baseline revision.

## Explicit authority and health boundaries

Authority REST routes requested `read:capability`, which no defined role possesses. They now use the existing `read:audit` permission. The next executed failure showed that fresh server migrations do not create `authority_events`, despite comments claiming they do. Creating an independently writable authority ledger would change control ownership, so this audit does not provision it. All three authority reads now return HTTP 503 `AUTHORITY_LEDGER_UNAVAILABLE` when it is absent; authorized upstream provisioning is the activation dependency. A separately provisioned disposable fixture proves successful reads and invalid-filter handling.

MCP `authority_emit` previously accepted caller-supplied principal and ALLOW decisions. It now requires live database identity and authenticated `write:evidence`, derives the actor and source from MCP identity, supports observational HOLD/DENY records, and rejects ALLOW for every caller. Actionable decisions remain the external producer's authority. The adversarial test proves anonymous/viewer/snapshot calls and forged ALLOW cannot insert rows.

Protected health/metrics handlers were mounted under public `/health` but checked permissions before parsing the bearer token. They now explicitly authenticate each protected route; public liveness remains public. Actual HTTP tests prove valid tokens reach metrics and deep-health database checks, while missing/invalid tokens are rejected.

## Real MCP transport closure

A stock SDK `SSEClientTransport` failed during initialization: server advertised `/mcp?sessionId=...` but POST handled only an unrelated `mcp-session-id` header. The server now accepts its advertised session query parameter and still binds the session to the authenticated subject and role. A per-connection MCP server factory supports concurrent clients; the SDK forbids attaching multiple transports to one protocol instance. Authority and platform tool groups were present in source inventories but missing from startup registration; they are now included.

Executed local proof in `evidence/mcp-live-smoke.json`: SDK initialize -> list 56 actual registered tools -> `djimitflo_approve_action` -> original user's bearer forwarded to REST -> pending approval persisted against a real local task -> approval fetched over authenticated REST -> matching actor, expiry, manual-action metadata and audit record checked -> task remains pending without executor dispatch. The auxiliary MCP listener was bound to loopback and closed after the test. The task and approval remain in the disposable audit database as evidence. No token is printed or persisted.

The MCP suite passed 26 tests including simultaneous Alice/Bob SDK sessions and cross-principal session-reuse rejection. This is live local operational proof of the manual approval request chain, not external production deployment, an approval decision, or autonomous task execution.

The newly registered authority reads enforce the same `read:audit` permission as REST. Missing canonical ledger state is an explicit MCP error, and maker/viewer reads are rejected; registration does not broaden ledger visibility.

The stable aggregate run (`evidence/assurance-stable.json`) is BLOCKED with Node/dependency/contracts/integrations/diff passing. OpenMythos certification maturity and deployment identity remain blocked. The audited patch is uncommitted and must not be reported as the deployed canonical SHA.

G117 hardens authority-ledger pagination at the HTTP boundary; malformed limits now fail closed through the shared error handler. [Evidence](evidence/authority-pagination-validation-g117.md).

G118 hardens multi-agent message retrieval pagination before durable message claiming. [Evidence](evidence/swarm-message-pagination-validation-g118.md).

G119 hardens Apex vector-memory search pagination before provider invocation. [Evidence](evidence/apex-memory-pagination-validation-g119.md).

G120 hardens proactive-memory top/search pagination before durable reads or embedding. [Evidence](evidence/proactive-memory-pagination-validation-g120.md).

G121 hardens work-item list pagination before durable work-item reads. [Evidence](evidence/work-item-pagination-validation-g121.md).

G122 hardens swarm-intelligence interaction, learning, capability and handoff pagination before durable reads or reconciliation. [Evidence](evidence/swarm-intel-pagination-validation-g122.md).

G123 hardens swarm-governance capability-token, reflection and memory-candidate pagination before governance or memory reads. [Evidence](evidence/swarm-governance-pagination-validation-g123.md).

G124 hardens legacy swarm specialist-panel, hypothesis and mission pagination before domain reads. [Evidence](evidence/swarms-pagination-validation-g124.md).

G125 hardens self-improvement proposal pagination before proposal reads. [Evidence](evidence/self-improvement-pagination-validation-g125.md).

G126 hardens predictive, runtime-governance and meta-tuning pagination before service reads. [Evidence](evidence/runtime-pagination-validation-g126.md).

G127 hardens compliance audit-log and usage recent-log pagination before audit or usage reads. [Evidence](evidence/compliance-usage-pagination-validation-g127.md).

G128 hardens knowledge-events and multi-model best-model pagination before claim or model reads. [Evidence](evidence/knowledge-multimodel-pagination-validation-g128.md).

G129 hardens council-session and red-team history pagination before session or history reads. [Evidence](evidence/council-redteam-pagination-validation-g129.md).

G130 hardens explainer task, fleet, knowledge-search, audit and calibration-sample pagination before service/database reads; async knowledge-search validation errors retain structured 400 semantics. [Evidence](evidence/explainer-pagination-validation-g130.md).

G131 hardens observability risk-trends and execution-activity time-window validation before database reads. [Evidence](evidence/observability-window-validation-g131.md).

G132 rechecks repository assurance: contracts, integrations and dependency CI pass; truth remains blocked by OpenMythos evidence and live identity. [Evidence](evidence/assurance-recheck-g132.md).

G133 hardens swarm-intelligence knowledge confidence validation before claim reads. [Evidence](evidence/swarm-confidence-validation-g133.md).

G134 hardens catalog search `topK` validation before catalog reads. [Evidence](evidence/catalog-search-validation-g134.md).

G135 rechecks read-only reachability of the reference UI; HTTP 200 and title are recorded without treating availability as functional proof. [Evidence](evidence/live-reference-ui-recheck-g135.md).

G136 proves the local authenticated deep-health path and retains its fail-closed OKF validator prerequisite. [Evidence](evidence/live-authenticated-health-g136.md).

G137 rechecks configured mutation surfaces: 71/71 mutants killed with no survivors, uncovered mutants or errors. [Evidence](evidence/mutation-recheck-g137.md).

G138 confirms the audit base is one commit behind fetched `origin/main`; the upstream delta is the already-present local public-explore test file, while the audit worktree remains intentionally dirty. [Evidence](evidence/upstream-identity-recheck-g138.md).

G139 verifies the proof-run detail dashboard route end-to-end at component/API boundary, including rollback refresh and accessible error state. [Evidence](evidence/proof-run-detail-ui-g139.md).

G140 closes the dashboard evidence index: all 38 routes now have at least one executed evidence record in the capability graph. [Evidence](evidence/dashboard-route-evidence-closure-g140.md).

G141 closes the OIDC ID-token signature placeholder with JWKS-backed verification and fail-closed claim enforcement. [Evidence](evidence/oidc-signature-validation-g141.md).

G142 re-runs the governed loop surface: 41 loop test files, 534 passed and 2 explicit skips, including authenticated `/loops` HTTP, recovery, security-checker and completion invariants. [Evidence](evidence/loops-regression-g142.md).

G143 rechecks the live local boundary: health/version are reachable, while unauthenticated deep provenance is denied with 401 and the temporary server is stopped afterward. [Evidence](evidence/live-identity-auth-boundary-g143.md).

G144 rechecks production/local drift: the deployed Pipeline Builder Save control remains alert-only, while the local implementation persists drafts; upstream main remains one test-only commit ahead. [Evidence](evidence/live-differential-recheck-g144.md).

G145 re-audits the package graph: Hono is locked at 4.13.7, root Vitest is dev-only, production audit is clean, and install/build/type/lint/full-workspace regression checks pass. [Evidence](evidence/dependency-audit-g145.md).

G146 brings the canonical `origin/main` public governance leaderboard tests into parity; local route proof covers gating, ranking, redaction, malformed metadata, corpus pinning and subset exclusion. [Evidence](evidence/explore-leaderboard-upstream-parity-g146.md).

G147 executes the deployed Explore leaderboard read-only: production returns HTTP 200 JSON with seven redacted rows and the expected public schema. [Evidence](evidence/live-explore-leaderboard-g147.md).

G148 probes the remaining public Explore index routes (`robots.txt`, `sitemap.xml`, leaderboard); all return 200 with the expected type/structure, while the sitemap currently has no repository URLs. [Evidence](evidence/live-explore-public-sweep-g148.md).

G149 rechecks the production/local Pipeline Builder asset chain: the deployed chunk remains alert-only while the local built chunk persists validated drafts. [Evidence](evidence/live-pipeline-builder-drift-g149.md).

G150 executes the exact OpenMythos model gates through the existing benchmark: R28 repeatability passes; R29 full is complete but rejected for three paired regressions. The truth adapter now imports these reports, replacing `not_run` with measured `pass`/`fail` while keeping certification fail-closed. [Evidence](evidence/openmythos-executed-evaluation-g150.md).

G162 closes the authenticated browser chain for Mission Control proof runs: UI creation, persisted artifact detail, governed rollback, and the documented post-rollback 404 cleanup state. [Evidence](evidence/browser-proof-run-detail-g162.md).

G163 rechecks the public production edge: dashboard/API version and public Explore endpoints respond, while protected health returns `AUTH_REQUIRED`; private deployment identity remains unproven. [Evidence](evidence/live-public-sweep-g163.md).

G164 rechecks the two historical local browser crashes: current `/swarm-resources` and `/self-driving` render successfully with no failed requests or page errors. [Evidence](evidence/browser-crash-recheck-g164.log).

G165 closes two `/swarm-resources` action edges: authenticated Worker Pool Plan and Scheduler Tick requests execute against the real local API and return reflected zero-work results. [Evidence](evidence/browser-swarm-resources-actions-g165.log).

G166 closes four authenticated read-route runtime defects: migrations now create/upgrade `context_cache` and consensus columns, compression originals persist across service restart, and missing mission/panel details return 404 instead of 500. [Evidence](evidence/route-read-sweep-g166.md).

G167 exercises all 308 registered GET routes against a fresh local build. It finds no new ordinary 5xx beyond the two swarm-session not-found cases repaired to 404; authority/degraded 503s and SSE timeouts remain explicit boundaries. [Evidence](evidence/route-read-sweep-g167.md).

G168 validates 20 selected local CRUD mutation boundaries with empty payloads and repairs three input paths that leaked SQLite/domain errors as 500 (`cognitive/episodes`, `policies`, swarm missions). [Evidence](evidence/mutation-validation-sweep-g168.md).

G169 repairs the remaining selected mutation leaks (`risk/task`, swarm claims and Apex LLM routing): malformed requests now fail with typed 400 responses before classifier, persistence or provider I/O. A fresh built-runtime replay covers all 20 selected paths with no 500s. The mandatory `/loops` self-check remains green at 23 files / 291 passed / 1 skipped. [Evidence](evidence/mutation-validation-sweep-g169.md), [Evidence](evidence/loops-self-check-g169.md).

G170 broadens safe mutation coverage to 13 local CRUD/consensus routes. Advanced governance feedback now validates before SQLite and absent consensus debates return 404 instead of a false 200. The fresh built-runtime replay has no 500s. [Evidence](evidence/mutation-validation-sweep-g170.md).

G171 sweeps 32 further safe mutating call attempts and finds one silent workflow-node update on a missing resource. G172 closes it with service and route existence guards; status, approve, reject and next now return typed 404s in a fresh build. [Evidence](evidence/mutation-validation-sweep-g171.md), [Evidence](evidence/mutation-validation-sweep-g172.md).

G173 regenerated the static and instantiated route inventories after those source changes; the route-source fingerprint matches, with 581 routes and 279 contract-tested routes. [Evidence](evidence/route-inventory-recheck-g173.md).

G174 replays all 285 mounted mutating routes with empty input against a migrated disposable database. Shared domain-error mapping and route validation reduce the corrected run to zero HTTP 500 responses; intentional 503 integration boundaries remain explicit. [Evidence](evidence/mutation-validation-sweep-g174.md).

G175 refreshes route-registration evidence after the G174 source changes; the current fingerprint matches with 581 routes and 280 contract-tested routes. [Evidence](evidence/route-inventory-recheck-g175.md).

G176 refreshes route-registration evidence after canvas stream validation; the current fingerprint matches with 581 routes and 284 contract-tested routes. [Evidence](evidence/route-inventory-recheck-g176.md).

G177–G182 extend the executable map through the current route source: registration/auth evidence remains 581 source routes, 614 runtime registrations, 608 anonymous auth denials and 285 contract-tested routes; broad malformed-input replay now covers all 285 mutating registrations with zero 500 responses, including typed unknown-resource boundaries for workers, canvas, repositories, runtime governance and skills. [Evidence](evidence/route-inventory-recheck-g182.md), [Evidence](evidence/mutation-validation-sweep-g182.md).

G183 adds the current external boundary: production is reachable at the login shell with public version/robots/sitemap responses, but protected behavior and deployed revision identity remain unavailable. [Evidence](evidence/live-github-differential-g183.md).

G184 rechecks the central domain path from task creation through runtime selection, execution events, restart recovery, loop planning and agent retirement using disposable fixtures. [Evidence](evidence/core-spine-recheck-g184.md).

G185 closes the `/swarms/fix` false-success chain: bounded target findings, path containment, maker/checker preparation, deterministic checks and explicit human-merge state are now wired through the existing loop services. [Evidence](evidence/fix-pipeline-validation-g185.md).

G186 revalidates the same chain after adding explicit runtime selection; the default remains mock proof execution and real adapters remain governed by runtime availability. [Evidence](evidence/fix-pipeline-validation-g186.md).

G187 adds shared high-risk classification for security-targeted fixes, forcing the existing independent security-checker lease path. [Evidence](evidence/fix-pipeline-validation-g187.md).

G189 closes the final regression pass: the full server suite passes 2481 tests, with route/auth inventory rechecked and the one transient probe retained as UNKNOWN. [Evidence](evidence/full-server-regression-g189.md).
