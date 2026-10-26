# A. Full platform inventory

All URLs below use `https://djimitflo.agentical.nl`. API paths are relative to the production client base `/api` (for example `/health/config` means `/api/health/config`); see [machine inventory](route-api-inventory.json) for call sites, request arguments and deployed-SHA file/line anchors. API wiring is SOURCE evidence, not observed network capture. Shared bootstrap loads `/tasks` and `/agents`; WebSocket state supplements these pages.

## Primary navigation: 20 destinations

| Group / route | Purpose, visible components and operator tasks | Relevant read APIs / sources | Observed coverage and limitations |
|---|---|---|---|
| Operate `/` | Health/guardrails, attention, stalls, outcome lineage, workers/species, services, resource efficiency; Refresh | `/health/cockpit`, `/health/digest`, `/health/efficiency`, `/health/services` | LIVE, Refresh exercised; independent freshness domains, see B/D |
| `/decisions` | Approval filters, PR settlement, dependency lane, requeues/reasons, pre-screen, attribution/retrieval labels, memory decisions, Telegram allowlist | `/approvals`, `/loops/draft-prs`, `/loops/dependency-lane`, `/self-improve/decisions`, label queues | LIVE populated; writes not exercised; long multi-queue page |
| `/goals-loops` | Create goal/start loop forms, catalog, goals/runs, selected review bundle, worker/checker interventions | `/goals`, `/loops/runs`, `/loops/catalog`, `/loops/runs/:id/review-bundle` | LIVE selected failed loop evidence; execution/override/stop not tested |
| `/tasks` | Task creation, runtime/repository discovery, task search and status cards | Bootstrap tasks/agents; `/repositories`, `/loops/runtime-contracts` | LIVE search `knowledge-gaps` narrowed to two failures; opened one |
| `/repositories` | Inventory, scan/rescan, repository detail | `/repositories` | LIVE list and selected detail; scans not invoked |
| Improve `/improvement-funnel` | Proposal/status funnel, panel/refinement/cognitive counts, yield, hygiene and calibration | `/self-improve/funnel`, `/self-improve/calibration` | LIVE + DB/SOURCE; definitions in D |
| `/evolution` | Realm gates, trials, gym/model/checker evidence, forecasters, Commons yield, PR settlement, experiment evidence | `/health/evolution-evidence?days=…` | LIVE; A unknown/B–D red, not decision-grade; [screenshot](08-evolution-gates.png) |
| `/observability` | Risk/policy summaries, errors and live event feed | `/observability/metrics`, authenticated stream | LIVE sections; SSE continuity/reconnect not instrumented |
| `/usage` | Provider/account/consumer usage, token mapping and errors | `/usage/accounts`, `/usage/tokens` | LIVE; business success differs from transport success |
| Knowledge `/knowledge` | Sources, relevance, retrieval/fitness, knowledge assets and skills | `/health/knowledge`, `/health/skills` | LIVE; large unused/unattributed population, see D |
| `/frontier-experts` | Expert identity/claim/evidence registry, lifecycle filters, dedupe audit and capability review | `/swarms/expert/experts`, `/swarms/expert/history`, `/health/expert-dedupe` | LIVE Checked filter and one detail; lifecycle/review/council writes not invoked |
| `/agent-commons` | Social/review evidence, reputation, invites and joining | `/swarm-v2/social/commons`, `/lures`, `/join-requests` | LIVE read surface; review automation flag disabled in inspected configuration, not whole service disabled |
| Fleet `/fleet` | Hosts, runtime health, diagnostics and bounded commands | `/fleet-hosts`, `/health/runtimes` | LIVE host/component views; remote commands not executed |
| `/agents` | Agent cards, liveness/connection, task counters, runtime/fleet scorecards | `/agents`, `/health/scorecards` | LIVE cards; social connection and execution health require clearer scope |
| Govern `/policies` | Four policy rules and enablement controls | `/policies` | LIVE enabled rules; enforcement chain untested; no defect inferred from presence of a toggle |
| `/governance` | OpenMythos scorecard/run history; Assurance tab with spec L1–L7 evidence and improvement inbox | `/openmythos/leaderboard`, `/openmythos/runs`, `/compliance/specs`, proposal/panel APIs | LIVE tabs/evidence expansion; incompatible 93 vs 0–5 score confirmed |
| `/mcp-permissions` | Ten servers, 148 tool classifications, search and server/decision/risk filters | `/mcp/servers?refresh=true`, `/mcp/permissions` | LIVE search 148→57; explicitly catalog-only, NOT an enforced permission gate; GET side effect in E |
| `/audit` | Canonical Trail and Log viewer tabs, filters, JSON/CSV export, paging | `/audit?limit=50`, `/audit-logs`, `/audit-logs/export` | LIVE tabs and Loop filter; filter mismatch confirmed; download not executed |
| `/authority` | Append-only decision ledger, actor/source, ALLOW/DENY/HOLD filter | `/authority/stats`, `/authority/events` | LIVE DENY filter returned eight expiry records; scope/history labels need precision |
| `/configuration` | Read-only environment catalog, prefix groups, filter, masked secrets, runtime.env/restart guidance | `/health/config` | LIVE 268 settings/20 masked; positive and no-match filters tested |

## Lab navigation: 17 destinations

| Route | Purpose / visible actions | API/data dependency | Observed coverage and boundary |
|---|---|---|---|
| `/dashboard` | Activity/spec overview and task/agent summaries | tasks/agents, `/compliance/specs` | LIVE; overlaps Cockpit, retain unique spec links before consolidation |
| `/swarm-resources` | Mutation gate, assurance, workers, work/memory queues, specialist panels; tick/eval/project/promote | `/swarms/status`, `/rsi/safety`, `/assurance/summary`, `/work-items`, `/memory/candidates`, specialists/panels | LIVE settled screenshot:32 registry,2 live,11 leases,0 active; loading had temporary false-empty counters; writes excluded |
| `/swarm` | Agent/resource overview, capabilities, recent discussion/learning | `/swarms/status`, `/swarms/intelligence/capabilities`, agents/tasks/discussions/learning | LIVE 32-agent view; “No model” is absent metadata, not proof of failed runtime |
| `/fleet-cockpit` | Runtime contracts, pools/concurrency, planning and dispatch | `/swarms/status`, `/loops/runtime-contracts` | LIVE settled:codex/opencode/claude pools available; gemini/editor unavailable; mock distinct; dispatch writes excluded |
| `/swarm-mission-control` | Registry vs live execution, proof narrative, OKF runtime, drift, integration/capacity/claims | `/swarms/intelligence/mission-control`, capabilities/claims, `/swarms/knowledge/runtime`, knowledge events | LIVE proof list and detail; completed record explicitly incomplete certification, not E2E proof |
| `/explainers` | 30 repositories, jobs/budgets, drift, one-rating calibration; Sync/Run/Pause/Ask/Explore | Generic get/post calls in component; explainer routes/services | LIVE 29 stale,1 running,0 completed/failed today; public Explore destination inspected; writes excluded |
| `/pipeline-builder` | Goal/Loop/Worker/Checker/Learning canvas; Clear, Export, Save local | Browser state/localStorage only; no execution API | LIVE Add Goal rendered a node; execution explicitly unsupported; draft persistence/export not verified or saved |
| `/catalog` | Imported/evaluated/prepared/rejected agents; search/division/target selection | `/catalog/counts`, `/catalog/agents`, `/catalog/search` | LIVE explicit empty inventory; preparation clearly distinguished from runtime activation; writes excluded |
| `/interaction-board` | Loaded evidence, correlation threads, actor/source/scope/status filters, Chat/Relations, Refresh/live 10 s | `/swarms/intelligence/interactions`, mission control | LIVE 500 loaded/276 threads/79 relations/410 production; no-match search/reset and Relations tested |
| `/self-driving` | Cognitive/memory/meta/compliance summary and tuning history; bounded tuning | `/cognitive/stats`, `/memory/stats`, `/meta/stats`, `/compliance/status`, `/meta/tuning-history` | LIVE 282 episodes/41%,20 displayed 90% applied tuning rows; confidence is heuristic, not causal evidence |
| `/cognitive` | Episodes, patterns, strategies, best goal type and advice disclaimer | `/cognitive/stats`, `/cognitive/meta-learning`, `/cognitive/strategy/:goalType` | LIVE 282/3/2/41%; explicitly advisory, not automatically strategy-applied |
| `/consensus-debates` | Debate inputs and history/results | Generic get/post via api; component endpoint expressions in JSON | LIVE completed/failed history; running debate excluded |
| `/agi-reasoning` | Goal reasoning input/output | `/agi/reason` POST | LIVE form; reasoning persists hypotheses/proposals, so not invoked |
| `/predictive-analytics` | Prediction input/result | `/intelligence/predict` POST with general/mock/closed parameters | LIVE; openly mock-limited Lab surface; not tested as production prediction |
| `/self-healing` | Read-only scan of failure rate/stale leases/disk worktrees/DB size/heap | `/intelligence/health` GET→`checkHealth`; worktree dryRun | LIVE clicked scan; false-zero stale leases confirmed; heal not invoked |
| `/economy` | Capability competence/cost, recent-run efficiency and budget recommendation | `/swarms/economy`, `/swarms/economy/allocate?budget=` GET | LIVE 34 caps/3 artifacts/$0.9349; zero-budget preview returned Funded 0/Deferred 0; no funds dispatched |
| `/federation` | Known peers, local capabilities, Register Peer | `/federation/peers`, `/federation/capabilities` | LIVE recovered:0 peers/34 candidate capabilities; peer registration/network federation untested |

## Contextual, legacy and public routes

| Pattern | Coverage / relationship |
|---|---|
| `/tasks/:taskId` | LIVE selected `loop-worker-9adc00ca-872e-4ce4-87a3-315dffe8bdfc-33107fd4`; task→Review works |
| `/tasks/:taskId/review` | LIVE 80 events/20 errors/26 tools/5 evidence/8 audit; event error semantics defective |
| `/repositories/:id` | LIVE `314e23d9-68b0-4a4b-9315-e9758712ca68`; scan health 100 and AGENTS.md validation issues coexist |
| `/agents/:agentId` | SOURCE: filters same agent cards and adds runtime governance view; not exercised with a valid ID |
| `/frontier-experts/:expertId` | LIVE `area:coding_agents`; checked identity alongside inferred capability and tentative/not recommended warning |
| `/swarm-mission-control/proof-runs/:proofRunId` | LIVE `proof-1789943717354-916bc3ea`; minimum deficits and artifact IDs, rollback not clicked |
| `/approvals`, `/compliance`, `/audit/logs`, `/cockpit` | SOURCE redirects respectively to Decisions#approvals, Governance?tab=assurance, Audit?tab=logs and `/`; redirect behavior not individually re-tested |
| `/login`, `*` | SOURCE protected-session/login and not-found routes; sign-out/auth failure not exercised |
| `/explore/:owner/:repo` | LIVE public published explainer `/explore/djimit/djimitflo`; generated bundle content, citations and provenance; outside SPA shell |
| `/explore/:owner/:repo/llms.txt`, `/explore/:owner/:repo/opengraph.svg`, `/explore/:owner/:repo/badge.svg` | SOURCE public text/share assets; not independently downloaded/rendered |
| `/explore/sitemap.xml`, `/explore/robots.txt`, `/explore/leaderboard` | SOURCE public discovery; leaderboard flag-gated and model-cohort filtered, unlike authenticated scorecard |

## Data/capability topology

Snapshot DB:32 agents,5 registry-agent rows,104 skill cards,0 agent_skills rows,52 sub-agent spawn records,0 workflow/0 workflow-node rows,7 fleet hosts,10 MCP servers/148 tools,0 federation peers,12,550 external events,2,691 outbox rows,19 runtime-contract probes. These are **different registries and populations**, not contradictory counts or proof every capability is operational. Knowledge uses several stores:5 `knowledge_claims` and 0 `vector_memories` do not negate the thousands of expert claims/units shown by Knowledge; table names are not interchangeable.

Execution/orchestration is primarily goals/loops/leases/tasks, with maker/checker/security and specialist review roles. Catalog imports, social agents, agent records, runtime pools, federation capabilities and skill cards overlap conceptually but have distinct activation contracts. The UI is often explicit about this (Catalog, Mission Control); preserve that honesty and cross-link identities. No evidence supports creating a second workflow engine merely because workflow tables are empty.

## Loading, empty/error and coverage contract

Lazy routes use the outer Suspense `Loading…`, temporarily replacing the shell. Native Safari AX sometimes omits settled DOM or reports an earlier render; screenshots and fresh settled reads resolved critical cases. Do not treat initial zero counters as settled empty states. Catalog/Federation/Interaction filter have confirmed empty messages. Configuration has confirmed no-match feedback. Global chunk errors were observed earlier, recovered on fresh Federation navigation; no causal bundle/deploy attribution established. Error-injection states, every filter/sort/page/export and every entity instance remain untested; C records tested actions separately from source wiring.
