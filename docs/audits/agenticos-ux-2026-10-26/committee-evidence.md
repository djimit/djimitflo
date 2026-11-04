# Committee review: evidence, learning and operational value

Date: 2026-10-26. Source pinned to `38be63d520bb5fef89be99458cf3b562098224c3`.
Method: independent source inspection only. No production/browser/API observations; no tests executed by this reviewer. Implementation presence is VERIFIED in source; operational availability, current data and causal benefits remain UNVERIFIED.

## Decision

Build the AgenticOS experience around the **existing mission detail** and explicit evidence relationships. The missing value is continuity between records, not another registry, graph service, learning daemon or approval system. A graph edge must identify its relationship and evidence. The human should receive unresolved exceptions with evidence and an actionable next step; routine bounded agent dialogue should continue under existing policy.

The repository already implements more than a historical audit might suggest:

- `packages/dashboard/src/pages/MissionDetailPage.tsx:62` assembles mission objective, blocker, next action, token coverage, runs, closure, attribution, relationships, provenance and decisions. `SwarmMissionControlPage.tsx:1274` links to it. Reuse rather than duplicate.
- `MissionDetailPage.tsx:18` explicitly lists time to verified outcome, human interruptions, escaped defects and energy per mission as unknown. These cannot honestly become AgenticOS scorecards without new provenance.
- `MissionDetailPage.tsx:32` types recorded participation, verification, delegation and quorum agreement separately. Reuse is intentionally not inferred. Reviewer verdicts are evidence of a recorded review, not independently proven task correctness.
- `swarm-learning-curve.ts:9` already replaced first/last-run pseudo-rates with same-loop cohorts over consecutive equal windows, denominator, Wilson interval and minimum 10 terminal runs per window. Its definition at line126 explicitly distinguishes completion from verified success. Do not file this as a present defect.
- `AgentCommonsPage.tsx:582` already states constellation lines mean co-participation, not communication or learning. The existing disclosure is correct; retain it in any redesign.

## Existing read contracts for a contextual inspector

All paths below are relative to the normal `/api` prefix. Preserve existing authorization; aggregate only what the signed-in caller may read.

| Context | Existing read source | Reusable identifiers and semantic boundary |
|---|---|---|
| Mission | `GET /swarms/intelligence/missions/:id/execution` (`routes/swarms.ts:224`) | `mission.id`, linked goal, run IDs, lease IDs, task assignments, decisions, attribution, tokens and provenance. Planning status is advisory; do not imply execution from it. |
| Mission list | `GET /swarms/intelligence/missions/execution` (`routes/swarms.ts:219`) | Existing mission list join distinguishes absent goal/goal missing/linked. |
| Run trace | `GET /swarms/assurance/traces/:traceId` (`routes/swarm-governance.ts:155`) | `TraceSpanRecord` has `id`, `trace_id`, `parent_span_id`, `loop_run_id`, `work_item_id`, `span_type`, status, times, `evidence_ref`, metadata (`agent-assurance-service.ts:12`). Only explicit parent edges are returned. Coverage across every tool/model path is unproven. |
| Commons discussion | `GET /swarm-v2/social/commons?kind=discussion&limit=50&offset=…` (`routes/swarm-orchestration.ts:196`) | Threads have participants and topic refs; messages expose runtime run ID, evidence refs and reflection ID/status (`AgentCommonsPage.tsx:703`). `kind=record` is an evidence room without scheduled runtime inbox replies, not a conversation waiting to execute. |
| Skill evidence | `GET /health/skills` (`routes/health.ts:190`) | `skill_cards.run_id`, content hash, provenance proposal/run/lease/PR/attribution; candidate/survived/regressed. **Record only**, not executable skill deployment. |
| Knowledge overview and fitness | `GET /health/knowledge` (`routes/health.ts:148`) | Explicit usage → run edges from proposal refs, panel retrieval judgments, memory reads, genome knowledge refs and outcome credits. `knowledge-fitness.ts:15` excludes environment/reviewer failures from maker value. |
| Memory | `GET /memory/stats`, `/memory/top`, `/memory/search`, `/memory/:id`, `/memory/:id/related` (`routes/memory.ts:26–79`); `GET /swarms/memory/candidates` (`swarm-governance.ts:188`) | Distinguish stored, retrieved, reviewed/promoted and causally useful. Search/retrieval is not effectiveness evidence. Candidate promotion has existing review/human rules; do not remove them via UX shortcut. |
| Knowledge runtime | `GET /swarms/knowledge/runtime` (`swarm-knowledge.ts:58`) | Existing status/configuration/inventory readout. Files existing or adapter configured does not prove retrieval helped a task. |
| Provenance | `GET /health/provenance-dag?days=…` (`routes/health.ts:217`) | Each edge has type, endpoints, row/field `evidence_ref`, `origin` and timestamp (`provenance-dag.ts:18`). No inferred links from title similarity or temporal proximity. Capability effect explicitly not measured. |
| Usage and energy | `GET /swarms/usage-window`, `/swarms/learning-curve`; `GET /health/efficiency` (`routes/health.ts:169`) | Recorded token event ownership and missing coverage; GPU package energy only where sampled. Preserve separate units and time/cohort population. |
| Allocation recommendation | `GET /health/value-allocation` (`routes/health.ts:211`) | Requires manage:config and enabled shadow mode; 404 disabled is not integration failure. Proposed allocation is never automatically applied by this endpoint. |

Existing frontend API functions in `lib/api.ts`: `getKnowledgeOverview:2019`, `getSkillCards:2024`, `getEfficiency:2029`, `getKnowledgeRuntime:2365`, `getMemoryCandidates:2427`, `getSocialCommons:2510`, `getSwarmCapabilities:2607`. Use `api.request` and `useResource`, not a second request client.

## Semantic contracts that the UI must keep visible

**Capability:** REGISTERED means a declaration exists. AVAILABLE requires current runtime admission/dependency evidence. OPERATIONAL needs a recent real execution of the operation. VERIFIED requires a relevant independent check tied to the exact version and conditions. UNUSED requires a defined observation window and known invocation coverage. Any missing step remains UNKNOWN; no single green badge collapses these concepts.

**Skill:** `skill-distillation.ts:9–20` is explicitly record-only. Candidate cards are read by `/health/skills` and Knowledge; they never enter maker/checker/panel contexts. The similarly named `LOOP_SKILL_CARDS_ENABLED` in `assignment-context.ts:11` selects accepted test examples; it does not activate the skill_cards table. These must be separate labels in the inspector. `KnowledgePage.tsx:107` currently shows latest cards without linking their run/attribution/PR, although the source card includes these IDs. This is a concrete contextual-navigation opportunity.

**Memory:** `assignment-context.ts:28` implements an optional goal-stable deterministic holdout, default rate 0. The code can support a comparison, but current assignment, sample adequacy, trial readout and benefit remain unverified here. `knowledge-fitness.ts:60` labels above-baseline observed outcome association as `used_with_value`; that is not a randomized treatment effect. Render “used in runs with attributed outcomes” plus n/interval/baseline and an observational-evidence label. Do not claim memory made those runs succeed.

**Learning:** reflections, shared messages and proposed improvements are candidate evidence. `CommonsPage` already correctly says not promoted without review. `commons-proposal-review-service.ts:129` asks agents for a falsifiable next step, creative alternative and stop condition; goal outcomes become gated memory candidates at lines107–115. Extend visibility into this existing path instead of adding an extra ritual after every message.

**Durability:** `provenance-dag.ts:7` follows source → proposal → run → PR → 14-day merge-survival settlement. Retained code over 14 days is code survival; independently measured behavior improvement and transfer remain separate, currently unproven capabilities.

**Token and energy economics:** `swarm-learning-curve.ts:37–52` reports token coverage with null for unknown and dollar value only with dated prices. `resource-ledger.ts:43` integrates GPU package watt samples into Wh, excludes long gaps, and line78 splits concurrent job windows equally; this is an attribution estimate, not per-process metering or whole-machine wall energy. Consumer per-kWh scoring requires ≥90% measured job coverage (lines230–240); weekly north-star has a different ≥80% metered-host window condition. Preserve these different denominators. The resource-ledger comment at line14/returned note line283 calling hosts[].gpu_kwh a wall-meter figure conflicts with returned note line282 explicitly saying GPU package power; label it GPU package energy and correct that documentation in a separate tiny patch. Cloud energy and mission energy remain unknown, not zero.

## Three implementation-ready specifications

### E1 — Context continuity in the existing mission/knowledge views (P1)

Problem: `KnowledgePage.tsx:107–115` exposes evidence card summaries without navigation to the run, attribution and PR named by the card; mission relationships and provenance display many raw IDs as plain text. Operators must recall IDs and switch contexts manually.

Intervention: add contextual links for IDs already resolved by existing data and routes, and retain selected mission/run/evidence context in URL parameters. In MissionDetail reuse the current `runLink` rather than build another entity framework. Show unavailable entity destination as plain text with “no detail view” instead of a dead hyperlink. A future inspector can reuse this view once repeated context patterns justify extraction.

Affected files: `KnowledgePage.tsx`, `MissionDetailPage.tsx`, their existing tests; `lib/api.ts` only if an actually missing read contract is required. No new DB/schema/service.

Acceptance: a card with a recorded run reaches `/goals-loops?run=<encodedID>` in one action; absent run/PR cannot fabricate navigation; maker/checker/parent links retain correct relationship type; keyboard activation and browser Back preserve relevant context; external PR links use known trusted destination validation. Read actions produce no writes. Regression tests cover missing IDs, special-character IDs, record-only cards, partial loading/failure and unauthorized evidence.

Alternative: leave all IDs copyable as the smallest interim improvement, but it does not remove cross-page lookup friction. Effort S–M; risk low, except accidental ID confusion and link permissions. Expected benefit: reduce diagnostic cross-page searches; measure current vs changed median steps/time on the same seeded three-record task, do not invent a percentage gain.

### E2 — Evidence ladder and next discriminator for Commons learning (P1)

Problem: conversations, reflections, proposals and sustained improvement belong to different cohorts/stages. Current correct disclosures can be lost when replacing the UI with an attractive unified graph.

Intervention: in the existing thread detail show an evidence ladder: discussion → reflection candidate → proposal disposition → goal/run → independent verification → behavioral recheck → transfer comparison. Only materialize stages linked by explicit existing IDs. Missing edge reads “not linked/not recorded”; do not generate synthetic progress percentages. Show next discriminating question/test/stop condition from existing review output. Existing flags and authority govern any execution; ordinary dialogue adds no human confirmation. Existing memory-promotion/review gates remain intact.

Affected files: `AgentCommonsPage.tsx`, existing social commons response/types in `lib/api.ts` and orchestration/read-model service only where explicit lineage is currently unavailable. Reuse `commons-proposal-review-service.ts` source_ref and metadata instead of a new learning lifecycle table. Tests extend `AgentCommonsPage.test.ts` plus existing Commons service tests.

Acceptance: co-participation cannot render delegation, reuse or learning; record rooms show no scheduled reply; reflected candidate cannot render promoted; pending/timeout/opposed/technical-failure reviews remain distinct; no execution button for readonly access. A displayed next action includes owner, evidence and stopping condition where recorded, otherwise unknown. Effort M; dependency explicit proposal/reflection/goal lineage readout; risk false causality if joins are guessed. Value measurement: grounded proposals and independently verified held-out reuse per comparable thread cohort, plus interruption count and dialogue token spend.

### E3 — Cohort-aware swarm value comparison (P1/P2)

Problem: operators need to decide whether extra agents improve outcomes enough to justify coordination, tokens and energy. Existing completion/usage views cannot prove this comparison.

Intervention: add a compact “Evidence for swarm value” section to current Mission Control/EvidenceStrip, linking the already registered experiment/readout and relevant Usage coverage. Display solo vs bounded swarm only when comparable task/model/policy/version/verification conditions and assignment are recorded. Present paired task outcome, time to independently verified outcome, observed token usage coverage, and GPU Wh coverage separately. Candidate promotion remains existing route; no automatic optimizer is introduced.

Affected files: `SwarmMissionControlPage.tsx`, `EvolutionExperiments.tsx`/existing experiment views, `UsagePage.tsx` as needed; `swarm-learning-curve.ts` only for explicit additional read contracts, not to reintroduce mixed-population success. Existing `swarm-learning-curve.test.ts`, `resource-ledger.test.ts` and panel tests cover semantics.

Acceptance: absence of a registered comparison displays “no causal comparison”; mixed gym/maintenance/production cohorts cannot be pooled; missing tokens or power cannot improve efficiency score; sample gaps remain visible; code retention does not satisfy behavioral survival; exact versions and confidence/uncertainty are shown. Minimal experiment: paired stable held-out task set, solo baseline vs smallest bounded swarm, randomized order, independent evaluator, predefined noninferiority correctness margin and minimum latency/token benefit, sequential stopping protocol registered before observation, regression followup after promotion. Effort M UI, experiment cost separate and authorized; principal risk selection bias and evaluator leakage. Expected value unproven until this test.

## Residual uncertainty

No proof of live browser state, current flags, production records, runtime invocation success, complete trace coverage, model costs, cross-store receipts, memory benefit or swarm advantage was obtained in this source-only review. No existing execution/promotion/auth gate was edited. These are evidence gaps, not asserted failures.
