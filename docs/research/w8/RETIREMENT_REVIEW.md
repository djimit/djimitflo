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
| Catalog page + `/api/catalog` + `packages/agent-catalog` | 44 (`/catalog/agents` 22, `/catalog/counts` 22) + page `/catalog` 22 views on 9 days | catalog tables (agent-catalog package) | `routes/catalog.ts` → `agent-catalog-service`; dashboard Catalog page + nav | UNKNOWN (hits > 0) | **Kept.** The views come in the same sessions as `/agi-reasoning` and `/consensus-debates`, which looks like page sweeps more than daily use, but the rule requires 0 hits. **Operator 14-10: KEEP.** See "Catalog: attribution-aware telemetry" below |
| `skill_genomes` / `SkillEvolutionEngine` | via `/api/swarms` | `skill_genomes` 0, `skill_outcomes` 1056 (last 2026-10-14) | `remote-gym-service.ts:8,129`, `loop-daemon`, `evolve-selection`, `merge-survival`, `execution-engine` | Live (outcomes), genomes NEVER_ACTIVATED | Kept (also listed as do-not-touch) |
| Tool broker | n/a (in-process) | `tool_broker_decisions` 0, `tool_broker_capability_tokens` 0 | `execution-engine.ts:43,109`; Stryker mutate target `tool-broker.ts:243-269` | DORMANT_BY_POLICY | Kept |
| `swarm_capabilities` | many (`/swarms/intelligence/capabilities` 26) | 498 | 17 readers | Live | Kept |
| `/api/platform` (cognitive-platform orchestrator) | 0 | — | Not on the candidate list; it holds the fleet-mesh, retirement, red-team and SEGL bridges | UNKNOWN (out of scope) | Kept. Candidate for the next tranche, together with the services it alone holds |

Other mounts that also had 0 hits but were not candidates and were left alone: `/risk`, `/evidence`,
`/intervention`, `/backups`, `/exports`, `/skills`, `/gym`, `/research`, `/traceability`, `/sbom`, `/swarm`
(alias of `/swarm-v2`).

## What was removed

Commits on `chore/w8-retirement`, one per group: SEGML routes + 6 route-only bridges, advanced +
WorkflowGraphService, canvas + LiveCanvasService, console + governance-feedback (+ loop service), legal +
legal-ruleops, memory-evolution, repo-index, fleet mesh route, legacy messages route, self-modification
route, `/swarm-intel` alias mount, then the regenerated contract inventory and this review.

Tests that covered only the removed code were deleted. Mixed tests had only the removed assertions taken
out: `module-covered-routes`, `mutation-validation`, `risk-authority-chain` (was `risk-canvas-authority-chain`),
`live-canvas` (telegram part kept, still in the Stryker suite), `route-permissions-http`,
`critical-http-contracts` (Stryker suite), `critical-routes` (factory count 21 → 20) and `source-learning`.
`route-inventory.test.ts` derives its expectations from source and runtime, so it did not need an edit, and
it stays green. `contract-inventory.json` was regenerated. The committed file was stale (589 routes, last
regenerated 2026-09-14). The same script gives 661 source routes on clean `origin/main` and 553 on this branch.

No dashboard page, nav entry or `api.ts` client called any removed group, so the dashboard has no changes.

## Tables (operator 14-10: KEEP)

No table is dropped. The full per-table assessment is in [`DB_RETIREMENT_ASSESSMENT.md`](DB_RETIREMENT_ASSESSMENT.md):
identity, schema, owner, rows and history, static and dynamic references, FKs, jobs, retention, backup and
rollback.

**Correction to the first version of this file.** `messages` is not a drop candidate. It has three live
`hasTable('messages')`-guarded readers: `board-protocol.ts:55`, `agent-communication-service.ts:1146` and
`board-handoff-service.ts:73`. A future drop decision would cover only the 8 service-owned tables:
`workflows`, `workflow_nodes`, `workflow_edges`, `governance_feedback_loops`, `governance_improvement_proposals`,
`memory_evolution_leases`, `repository_indexes` and `code_chunks`. All 8 have 0 rows now and in every snapshot.

Tables that still have a kept writer or reader: `fleet_*` (FleetMeshService through the platform
orchestrator), `self_modification_*` (boot pipeline), `audit_anchors` (AuditAnchoringService), the `segml_*`
tables that exist (SEGL core, flag-gated), `plugins` (apex) and `messages`. The bridge tables (`segml_l3_*`,
`segml_l4_*`, `segml_l5_*`, `segml_prod_*`, `segml_literature_*`, `segml_training_*`, `segml_ab_test_results`,
`segml_finetuning_jobs`) were never created in production.

## Catalog: attribution-aware telemetry (operator 14-10: KEEP)

Catalog stays. S4 counts hits per route pattern but does not record **who** made them, so it cannot settle a
retirement decision for a surface that is used, even a little. Before Catalog (or any other surface with hits
> 0) can be retired, the telemetry has to separate these sources:

1. **Human use**: interactive dashboard sessions by an operator.
2. **Automated page sweeps**: audit, crawl or smoke runs that visit every page. The `/catalog` views
   co-occur with `/agi-reasoning` and `/consensus-debates` in the same sessions, which looks like this kind.
3. **Internal API consumers**: dashboard components or server code calling `/api/catalog/*` on their own,
   with no page view.
4. **Background dependencies**: schedulers or workers that read the catalog tables in process. These never
   show up in HTTP counts.
5. **External consumers**: the MCP server, scripts, other hosts and agents.

Per the operator, no new service is built for this here. The requirement is recorded so the next retirement
review can use it. One possible way to get there is an attribution dimension on the existing `usage_counts`
rows, such as caller class from the auth principal or user agent. That is not in scope for W8.

## Capability preservation matrix

Removing a route is not the same as removing a capability. For each capability: the old implementation that
W8 touched, the path that carries it now, that path's status, and the behavioural tests that ran on this branch.
Every test set was run with `npx vitest run <files>` in `packages/server` on `chore/w8-retirement`.

| Capability | OLD IMPL (touched by W8) | NEW IMPL (carries it now) | DEPENDENCY STATUS | BEHAVIORAL TEST | RESULT | EVIDENCE REF |
|---|---|---|---|---|---|---|
| SEGL learning + evaluation | `/api/segml` (run/history/status) and the never-activated L3/L4/L5/literature/finetuning/production bridges | SEGL core `self-evolving-governance-loop` via `continuous-learning-loop.ts:67-72`; OpenMythos eval + nightly + leaderboard (`/api/openmythos/*`, 36 hits) | Core kept, gated by `SEGML_ENABLED` (off since plan E12, a policy that predates W8). OpenMythos live. The L3-L5 bridge tables never existed, so nothing ran there | self-evolving-governance-loop, continuous-learning-loop, segml-judge-updater, -curriculum-adapter, -case-generator, -compliance/-memory/-predictive/-fleet-memory/-cpo bridges, openmythos-eval-service, -nightly, -scorecard | 13 files / 103 tests pass | §Classification rows 1-3. Only the HTTP trigger for a manual cycle is gone, and it had 0 hits |
| Memory evolution | `/api/memory-evolution` + MemoryEvolutionService (ingest / evolve / promote / leases) | `MemoryCandidateReviewScheduler` (specialist-panel review), `/api/swarms/memory/candidates` promote/reject (109/4 hits), `memory-candidate-service`, `assignment-context` (memory_access_log, 661 rows) | Live. The scheduler header (`memory-candidate-review-scheduler.ts:1-20`) documents that it replaces MemoryEvolutionService's auto-promotion gate, which could never be satisfied | memory-candidate-review-scheduler, memory-candidate-pending-promotion, memory-review-and-gate, memory-routes, memory-routes-chain, memory-flywheel-i12, assignment-context, memory-curator | 8 / 32 pass | §Classification row memory-evolution |
| Agent discovery + federation | `/api/fleet` mesh (nodes, registry, handoffs) | `AgentRegistrySyncService` → `registry_agents`, read by `/api/agents` (`routes/agents.ts:29`) and scorecards; `/api/federation/peers` + `/capabilities` (10 hits each); `/api/fleet-hosts` + `/api/host-agent` | Live. FleetMeshService kept for the platform orchestrator | agent-registry-sync, federation-routes, federation-capacity, segml-federated-governance-bridge, agent-connection-state | 5 / 20 pass | §Classification row fleet |
| Capability exchange | `/api/swarm-intel` alias mount | Same router under `/api/swarms` (`routes/swarms.ts:139`): `/swarms/intelligence/capabilities` (26 hits), knowledge subscribe, evolution register/outcome; `swarm_capabilities` 498 rows | Live. Same code, one mount fewer | swarm-intel-routes, swarm-intel-evolution-routes, swarm-intel-pagination, swarm-intelligence-service, g14-swarm-intelligence, route-permissions-http, module-covered-routes | 7 / 44 pass | §Classification row swarm-intel |
| Controlled self-modification | `/api/self-modification` status/analyze/plan (execute was already 451) | `SelfModificationPipeline` at autonomous boot (`src/index.ts:262-264`, 70 opportunities); governed change path = self-improvement proposals → loop maker/checker → draft PRs (`/api/self-improve/*`, `/api/loops/draft-prs`) | Live. The pipeline is unchanged; only its read-only HTTP view is gone | self-modification, adaptive-self-modification, critical-http-contracts | 3 / 25 pass | §Classification row self-modification |
| Proposal generation | GovernanceFeedbackLoopService (eval failures → approval-gated proposals; 0 rows ever) | Self-improvement proposals (`/api/self-improve/decisions` 898 hits, `scheduled_proposal_goals` scheduler armed at boot) | Live. One sub-mapping, "OpenMythos case failure → policy_update proposal", has no 1:1 replacement. It never ran (0 rows in all snapshots), and SEGL core still reads `openmythos_case_results` (flag-gated) | self-improvement-service, -routes, -refinement-service, -prescreen-enforce, self-improvements-fingerprint-unique | 5 / 55 pass | DB_RETIREMENT_ASSESSMENT.md (`governance_*` history) |
| Verification + promotion | memory-evolution promote, governance-feedback authorize | Approvals (`/api/approvals` 6.9k hits), loop verify, specialist auto-review, expert transitions, memory candidate promote | Live | approvals-http, manual-approvals, approval-atomicity, self-improvement-agent-review-service, -auto-review-scheduler, expert-routes, reviewer-inherits-run-approval | 7 / 56 pass | — |
| Experiment provenance | none (W8 removed no provenance producer) | provenance-dag, judgment provenance, holdout manifest builder/freeze/exclusion | Live. Holdout-pinned files (segml-federated bridge, swarm-task-decomposer) untouched | provenance-dag, judgment-provenance, database-provenance, holdout-manifest-builder, -freeze, holdout-claim-exclusion, holdout-reuse-block | 7 / 48 pass | `docs/holdout/epoch1-manifest-20261014.json` |
| Rollback / recovery | none | Loop recovery at boot, task recovery, backup/restore, agent retirement (kept); git revert per W8 commit | Live | loop-recovery, loop-recovery-service, loop-recovery-awaiting-approval, g10-crash-recovery, task-recovery, backup, agent-lifecycle-boundary | 7 / 82 pass | §Rollback |

**Verdict: no HOLD.** Every required capability has a live or policy-gated path, and that path's behavioural
tests pass on this branch. The two things that are really gone are (a) the manual HTTP trigger for a SEGL cycle
and (b) the never-used eval-failure → policy-proposal mapping. Neither had a caller or a row.

## Local failures: root causes

Three tests failed in the first full local server run. There were 3, not 4: `loops-http-proof` and
`route-permissions-http` later failed once each, for the same reason as the second item below.

1. **`shipped-code-scan` › `typescript-parser` alias.** The cause is the environment, not W8.
   `packages/server/package.json:34` declares `"typescript-parser": "npm:typescript@6.0.3"`, and
   `package-lock.json:12225` has it. The shared local install `/Users/dlandman/djimitflo/node_modules` predates
   it, and the package is absent (`ls node_modules/typescript-parser` → no such file). On a **clean `origin/main`
   44dd558f** export (`git archive`, same node_modules) the test fails the same way:
   `AssertionError: expected null not to be null` at `shipped-code-scan.test.ts:29:20`, 1 failed / 15 passed.
   CI runs `npm ci` and has the alias.
2. **`route-inventory`, `explore-public`, `loops-http-proof`, `route-permissions-http` (intermittent).** The cause
   is cross-process loopback port misrouting on macOS. It is a test-isolation bug, and it is now fixed.
   - **Mechanism.** supertest calls `app.listen(0)`, which binds the wildcard `::`, and then dials `127.0.0.1:<port>`.
     On Darwin, a wildcard bind succeeds even when another process already listens on `127.0.0.1:<same port>`,
     and loopback IPv4 connections are delivered to the more specific listener. A deterministic repro
     (`portrepro2.mjs`, kept in the session scratchpad) shows it:
     `B holds 127.0.0.1:54612; A wildcard bind of 54612: ok; GET 127.0.0.1:54612 -> 200 B(127.0.0.1)`.
     On Linux (6.8, in a `--network none` container) the same bind fails with `EADDRINUSE`, so CI cannot hit it.
   - **Caught in the act.** A diagnostic preload (`NODE_OPTIONS=--import`) tagged every response with the serving
     pid and ran `lsof` whenever a test client got a response from another process. Over two tagged full runs
     it caught 3 such responses:
     - route-inventory → `POST /api/swarms/decompose` was answered by a server outside the test run, with
       `node 46929 TCP *:59822` as the test's own listener.
     - route-permissions-http → `POST /skills/fixture-skill/enable` was answered by `IPNExtens 46429 TCP 127.0.0.1:62294 (LISTEN)`
       (Tailscale) while the test listened on `node 41747 TCP *:62294`. That run also failed `route-permissions-http`.
     - route-inventory → `POST /api/backups/…/restore` was answered by `codex 38139 TCP 127.0.0.1:62612 (LISTEN)`
       while the test listened on `node 52328 TCP *:62612`.
     Each earlier failure shape matches a foreign responder: a 200 for an anonymous admin route, a 404 or 401 with
     `error_code: null`, and a 200 whose body has no `runs` field.
   - **Fix** (commit cd2f9525 + 7953cb6e): `src/__tests__/helpers/loopback-listen.ts`, wired as a vitest
     `setupFiles` entry. It is darwin-only. supertest now dials `[::1]`, which the dual-stack wildcard socket
     accepts and IPv4-only foreign listeners never see. Hand-rolled `listen(0, cb)` now binds `127.0.0.1`.
   - **After the fix**: 3 tagged full runs gave **0** cross-process responses, against 1 and 2 per run before,
     and only `shipped-code-scan` (cause 1) failed. A probe test confirmed that supertest's remote address is
     `::1`.

## Contract inventory: violations

- Running `node scripts/contract-inventory.mjs` on clean `origin/main` 44dd558f and on this branch gives:
  - **main**: 661 routes, 634 source_referenced, 27 module_covered, 2 critical_unclassified, MCP 60/60.
  - **branch**: 553 routes, 527 source_referenced, 26 module_covered, 2 critical_unclassified, MCP 60/60.
- The 2 critical-unclassified routes are **identical on both**: `swarms:POST:/expert/experts/:id/capabilities/:capability/review`
  and `swarms:POST:/expert/experts/:id/deprecate`.
  - Root cause: commit 4226519f (2026-09-14, "feat(experts): governed capability deltas (§54) and typed
    deprecation (§55)") added these two HTTP routes in `routes/swarms.ts:279,285`. `swarms` is a critical
    module, and no test sends a matching POST to them. `expert-evolution.test.ts` covers the service methods,
    not the HTTP paths.
  - They existed before W8 and are not touched by it. The fix is a route test in a separate change.
- **W8 adds 0 new violations.** The 108 routes that are gone are exactly the removed modules: advanced 14,
  canvas 9, console 7, fleet 10, governance-feedback 7, legal 5, memory-evolution 7, messages 5,
  repository-index 6, segml 7, segml-finetuning 4, segml-l3 6, segml-l4 5, segml-l5 3, segml-literature 4,
  segml-production 5, self-modification 4. No route was added. All 553 surviving routes keep their status
  (527 source_referenced → source_referenced, 26 module_covered → module_covered), and none lost all of its
  evidence files.

## Runtime startup check

The server was built from this branch with `tsc -p packages/server`, together with worktree builds of `shared`
and `agent-catalog`. It was then booted as a throwaway local process:
- clean `env -i` and `NODE_ENV=production`;
- `DJIMITFLO_RUNTIME_PROFILE=autonomous`;
- an **empty** SQLite in the scratchpad and a scratch `HOME` / `LOOP_WORKTREE_ROOT`;
- ephemeral bootstrap admin, `HOST=127.0.0.1`;
- `sandbox-exec` with `(deny network-outbound)` except loopback.

It never touched production.

- **Boot 1** (default flags): `✅ Djimitflo Server running on http://127.0.0.1:39471`. The autonomous services
  started: scheduler watchdog, negotiation coordinator, capability acquisition, meta-evolution, RSI engine,
  expert swarm orchestrator, loop daemon, explainer fleet worker, heartbeat window. `/api/health/schedulers` →
  19 schedulers registered; with default env, `scheduled_proposal_goals` is armed and the rest are off by flag,
  as designed.
  - **BackgroundWorkerService started.** `/api/apex/workers/status` lists the 4 enabled workers. After 60 s,
    `health-check` has `lastRun 2026-10-14T18:19:13Z`, `lastStatus: completed`, with output `Health: 0 running, 0
    blocked, 0 failed makers, 0 active agents` in `recentResults`.
- **Boot 2** (every scheduler flag on, plus `SEGML_ENABLED=true`): 16 of 19 schedulers armed. 7 were already
  `executing` at the first probe. The 3 that stayed off have environment reasons:
  - `dependency_lane`: `GITHUB_REPOSITORY/GITHUB_TOKEN missing — not arming`.
  - `frontier_experts`: also needs the `frontierExpertsEnabled` feature flag.
  - `loop_auto_merge`: test-only flag.
- **Route inventory = regenerated contract inventory.** `/api/openapi.json` (the runtime router) has **563**
  method+path operations. The `mounted_paths` in the committed `contract-inventory.json` have **563**. Both
  differences are empty: runtime not in inventory = [], inventory not in runtime = []. The 553 declarations
  give 563 mounted operations because some routers are mounted twice, for example `/swarm` and `/swarm-v2`.
- **Removed surface is gone, kept surface answers.** These return 404: `/segml/status`, `/advanced/feedback/stats`,
  `/canvas/sessions`, `/console/overview`, `/legal/rules`, `/memory-evolution/leases`, `/repo-index/repositories`,
  `/fleet/status`, `/messages/x`, `/self-modification/status` and `/swarm-intel/plans`. These return 200:
  `/swarms/intelligence/capabilities`, `/catalog/counts` and `/segml/federation/summary`.

## Rollback

`git revert` of the merge commit, or of any single group commit. The tables were not touched, so a revert
brings the routes back with no data step.
