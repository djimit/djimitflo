# W8 retirement review — dormant back-end groups and Catalog

Operator decision 30-09 ("retire dormant back-end groups + Catalog after 2 weeks of usage
telemetry, review 14-10"), re-approved 14-10. This file is the evidence for branch
`chore/w8-retirement`.

## Evidence base

- **Usage telemetry (S4).** `usage_counts` in the production DB (`djimitflo-live`, `/data/djimitflo.sqlite`),
  read on 2026-10-14 with a self-written read-only better-sqlite3 script (`{ readonly: true }`, no app imports,
  removed from the container afterwards). Coverage: 2026-09-28 to 2026-10-14, 17 distinct days, so the 14-day
  window is fully covered. API counts use the matched Express pattern (`/api/<mount><route>`), page counts
  come from `POST /api/telemetry/pageview`. The middleware counts **every** HTTP caller (dashboard, MCP
  server, scripts, host agents, gym workers), so 0 hits means that no client of any kind called the group over HTTP.
  In-process callers do not show up in it, which is why the readers and writers below were checked one by one.
- **Row counts.** `SELECT COUNT(*)` over all 249 tables in the same read-only pass, plus `MAX(created_at)`
  for the tables that decide a verdict.
- **Static checks per group.** Importers of the route factory and of every service it constructs (outside
  tests), timers and `start()` calls in constructors, bootstrap and scheduler wiring, env flags, dashboard
  `api.ts` clients, MCP server, `scripts/`, the holdout manifest and the Stryker/vitest mutation config.

## Verdict vocabulary

| Verdict | Meaning used here |
|---|---|
| DEAD | 0 HTTP hits in 14 d, no in-process reader or writer, no flag or scheduler that would switch it on, no client |
| SUPERSEDED | 0 hits, and another live path does the same job (named in the table) |
| NEVER_ACTIVATED | Activation path exists (flag, on-demand operator action) but never ran; kept |
| DORMANT_BY_POLICY | Deliberately off or rarely used by design (safety control, flag-gated); kept |
| BROKEN_PRODUCER / BROKEN_CONSUMER | One side of the data flow is missing; kept for a fix decision |
| UNKNOWN | Evidence does not settle it (hits > 0, a hidden producer, or an experiment pins it); kept |

Only DEAD and SUPERSEDED groups with 0 hits and no live reader were removed. Zero rows alone was never
taken as proof that a group is dead.

## Classification

Hits are total API calls (all methods, all sub-routes) in the 14-day window. Line references are to
`origin/main` 44dd558f unless the file still exists.

| Group | Hits 14 d | Rows (prod) | Readers / writers (file:line) | Verdict | Action |
|---|---|---|---|---|---|
| `/api/segml` + `/segml/{l3,l4,l5,literature,finetuning,production}` routes, and their route-only bridges | 0 | `segml_l3_*`, `segml_l4_*`, `segml_l5_*`, `segml_prod_*`, `segml_literature_*`, `segml_training_*`: **tables never created**; `segml_cycles` 408 (last 2026-09-23) | Each bridge imported only by its own route; no scheduler or client. `segml_cycles` is written by the SEGL core via `continuous-learning-loop.ts:67-72`, which is behind `SEGML_ENABLED` (off since plan E12) | DEAD (routes + route-only bridges) | **Removed** |
| SEGL core (`self-evolving-governance-loop`, judge updater, curriculum adapter, case/compliance/memory/predictive/fleet-memory bridges) | n/a (in-process) | `segml_cycles` 408 | `continuous-learning-loop.ts:7,40`; `segml-cpo-bridge` ← `cognitive-platform-orchestrator.ts` | DORMANT_BY_POLICY (`SEGML_ENABLED`) | Kept |
| `/api/segml/federation` + `segml-federated-governance-bridge` | 0 | `segml_fleet_memory` 0 | `docs/holdout/epoch1-manifest-20261014.json` lists `services/segml-federated-governance-bridge.ts` as a holdout task source | UNKNOWN (holdout experiment input) | Kept, untouched |
| `/api/advanced` + `WorkflowGraphService` | 0 | `workflows` / `workflow_nodes` / `workflow_edges` 0 | `WorkflowGraphService` only in `routes/advanced.ts`; `ContextCompressionService` also in `loop-event-service.ts:50`; `GovernanceFeedbackService` also in `runtime-governance-service` | DEAD | **Removed** (route + WorkflowGraphService); compression and feedback services kept |
| `/api/canvas` + `LiveCanvasService` | 0 | no table (in-memory) | Only `routes/canvas.ts`; no dashboard client | DEAD | **Removed** |
| `/api/console` | 0 | `audit_anchors` 0 | Read-only projection; superseded by `/api/health/cockpit` (519) and `/api/health/services` (518) | SUPERSEDED | **Removed** (route only; `AuditAnchoringService` kept, it is an integrity primitive with its own persistence tests) |
| `/api/governance-feedback` + `GovernanceFeedbackLoopService` | 0 | `governance_feedback_loops` 0, `governance_improvement_proposals` 0 | Service only in this route and `routes/console.ts`; no scheduler | DEAD | **Removed** |
| `/api/legal` + `services/legal-ruleops/*` | 0 | no table | `rule-service` only in `routes/legal.ts`; the PII, anonymisation and rechtsgebied modules only used by `rule-service` | DEAD | **Removed** |
| `/api/memory-evolution` + `MemoryEvolutionService` | 0 | `memory_evolution_leases` 0 | Only the route. Superseded by `/api/swarms/memory/candidates` (26 reads, 109 promotes, 4 rejects) | SUPERSEDED | **Removed** |
| `/api/repo-index` + `RepositoryIndexService` | 0 | `repository_indexes` 0, `code_chunks` 0 | Only the route; repository UI uses `/api/repositories` (52) | DEAD | **Removed** |
| `/api/fleet` (mesh) | 0 | `fleet_nodes`, `fleet_handoffs`, `fleet_work_distribution`, `fleet_capability_sync` 0 | Superseded by `/api/fleet-hosts` (54) + `/api/host-agent` (264k), `fleet_hosts` 7 rows; the registry mirror is read by `routes/agents.ts:29` and `services/scorecards.ts:95` | SUPERSEDED | **Removed** (route only; `FleetMeshService` ← `cognitive-platform-orchestrator.ts:34`, `AgentRegistrySyncService` ← `bootstrap/autonomous-services.ts:107` kept) |
| `/api/messages` (legacy) | 0 | `messages` 0 | Superseded by `/api/swarm-v2/social-runtime/:agentId/messages` (7.6k), `agent_messages` 6651 rows (last 2026-10-14) | SUPERSEDED | **Removed** (route only; `message_bus` ← `swarm-status-service.ts:9`, `board-protocol` kept) |
| `/api/self-modification` | 0 | `self_modification_opportunities` 70, `self_modification_plans` 0 | Writer = autonomous boot `src/index.ts:262-264` (`analyze()` + `autoPlan()`); the route was the only reader and `execute` was already 451 | DEAD (HTTP reader) | **Removed** (route only; pipeline kept) |
| `/api/swarm-intel` (alias) | 0 | n/a | Same router is mounted under `/api/swarms` (`routes/swarms.ts:139`), which carries the traffic (`/api/swarms/intelligence/*` 12-29 hits each) | SUPERSEDED (duplicate mount) | **Mount removed**; router file kept |
| `/api/apex` (plugins, vector memory, workers, LLM router) | 0 | `worker_results` 59 052 (last 2026-10-14), `worker_leases` 3216, `plugins` 0, `llm_provider_metrics` 0 | `routes/apex.ts:30,37` starts `BackgroundWorkerService` when `operatorRuntime` is on, so the route factory is a **live in-process producer** | UNKNOWN (hidden live producer) | Kept. Follow-up: move `workers.startAll()` into bootstrap, then retire the HTTP surface |
| `plugins` / `PluginRegistryService` | 0 | `plugins` 0 | Only `routes/apex.ts:8`; enable/disable already 503 | NEVER_ACTIVATED | Kept (lives inside apex, see above) |
| `/api/runtime-governance` | 0 | `runtime_governance_agents` 0, `runtime_governance_alerts` 0 | Dashboard `AgentsPage.tsx:253` (status + quarantine release); `RuntimeGovernanceService` in `index.ts`, `execution-engine`, social autopilot; Stryker mutate target | DORMANT_BY_POLICY (safety control) | Kept |
| `/api/retirement` | 0 | `agent_archives` 0 | Operator lifecycle action; `AgentRetirementService` ← `cognitive-platform-orchestrator.ts:36`; atomic lease/archive tests in `agent-lifecycle-boundary.test.ts` | DORMANT_BY_POLICY (operator lifecycle control) | Kept |
| `/api/red-team` | 0 | `red_team_reports` 0 | On-demand assessment; `AdversarialRedTeamService` ← `cognitive-platform-orchestrator.ts:37` | NEVER_ACTIVATED (on-demand security tool) | Kept |
| `/api/agi` (+ consensus) | 2 (`POST /agi/reason`) + page `/agi-reasoning` 11 | `consensus_*` 0 | `routes/agi.ts:9` → `MultiAgentConsensusService`; page `/consensus-debates` 9 views | UNKNOWN (hits > 0) | Kept |
| Council mode / sessions | 9 (`GET /council/sessions`) | `council_sessions` 17 (last 2026-09-21), `council_outputs` 26 | `routes/council.ts`; MCP `djimitflo_council_ask` | UNKNOWN (hits > 0) | Kept |
| Catalog page + `/api/catalog` + `packages/agent-catalog` | 44 (`/catalog/agents` 22, `/catalog/counts` 22) + page `/catalog` 22 views on 9 days | catalog tables (agent-catalog package) | `routes/catalog.ts` → `agent-catalog-service`; dashboard Catalog page + nav | UNKNOWN (hits > 0) | **Kept.** The views come in the same sessions as `/agi-reasoning` and `/consensus-debates`, which looks like page sweeps more than daily use, but the rule requires 0 hits. Operator decision |
| `skill_genomes` / `SkillEvolutionEngine` | via `/api/swarms` | `skill_genomes` 0, `skill_outcomes` 1056 (last 2026-10-14) | `remote-gym-service.ts:8,129`, `loop-daemon`, `evolve-selection`, `merge-survival`, `execution-engine` | Live (outcomes), genomes NEVER_ACTIVATED | Kept (also listed as do-not-touch) |
| Tool broker | n/a (in-process) | `tool_broker_decisions` 0, `tool_broker_capability_tokens` 0 | `execution-engine.ts:43,109`; Stryker mutate target `tool-broker.ts:243-269` | DORMANT_BY_POLICY | Kept |
| `swarm_capabilities` | many (`/swarms/intelligence/capabilities` 26) | 498 | 17 readers | Live | Kept |
| `/api/platform` (cognitive-platform orchestrator) | 0 | — | Not on the candidate list; it holds the fleet-mesh, retirement, red-team and SEGL bridges | UNKNOWN (out of scope) | Kept. Candidate for the next tranche, together with the services it alone holds |

Other mounts that also had 0 hits but were not candidates and were left alone: `/risk`, `/evidence`,
`/intervention`, `/backups`, `/exports`, `/skills`, `/gym`, `/research`, `/traceability`, `/sbom`, `/swarm`
(alias of `/swarm-v2`).

## What was removed

Thirteen commits on `chore/w8-retirement`, one per group: SEGML routes + 6 route-only bridges, advanced +
WorkflowGraphService, canvas + LiveCanvasService, console + governance-feedback (+ loop service), legal +
legal-ruleops, memory-evolution, repo-index, fleet mesh route, legacy messages route, self-modification
route, `/swarm-intel` alias mount, then the regenerated contract inventory and this review.

Tests that covered only the removed code were deleted. Mixed tests had only the removed assertions taken
out: `module-covered-routes`, `mutation-validation`, `risk-authority-chain` (was `risk-canvas-authority-chain`),
`live-canvas` (telegram part kept, still in the Stryker suite), `route-permissions-http`,
`critical-http-contracts` (Stryker suite), `critical-routes` (factory count 21 → 20) and `source-learning`.
`route-inventory.test.ts` derives its expectations from source and runtime, so it did not need an edit, and
it stays green. `contract-inventory.json` was regenerated (589 → 553 routes).

No dashboard page, nav entry or `api.ts` client called any removed group, so the dashboard has no changes.

## Drop candidates (operator decision — not dropped)

Tables are left as they are. Dropping them is a destructive data change. Every table below has 0 rows in
production and no remaining reader or writer in the code after this branch:

- `workflows`, `workflow_nodes`, `workflow_edges`
- `governance_feedback_loops`, `governance_improvement_proposals`
- `memory_evolution_leases`
- `repository_indexes`, `code_chunks`
- `messages` (legacy)

Tables that still have a kept writer or reader, so they are **not** drop candidates yet: `fleet_*` (FleetMeshService
through the platform orchestrator), `self_modification_*` (boot pipeline), `audit_anchors` (AuditAnchoringService),
`segml_*` that exist (SEGL core, flag-gated), `plugins` (apex).

The bridge tables (`segml_l3_*`, `segml_l4_*`, `segml_l5_*`, `segml_prod_*`, `segml_literature_*`,
`segml_training_*`, `segml_ab_test_results`, `segml_finetuning_jobs`) were never created in production.
Nothing needs to be dropped there.

## Rollback

`git revert` of the merge commit, or of any single group commit. The tables were not touched, so a revert
brings the routes back with no data step.
