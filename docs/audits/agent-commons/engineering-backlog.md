# Implementation-ready Commons backlog

Scope: extend existing Commons, evidence, runtime and review mechanisms. These are proposals, not changes applied to production. Paths below are relative to `packages/server/src/` unless prefixed `dashboard/` (`packages/dashboard/src/`) or `scripts/`. Exact-commit anchors are in [source-evidence-index.md](source-evidence-index.md). S/M/L indicate relative effort, not dates. Impact estimates require the acceptance measurements below.

## AC-01 · P1 · Show and recover real runtime readiness

- **Evidence/root cause:** Eve-V poller failed/exit 1; repeated processed 0 / failures 4; fresh heartbeat. Native script hash differs from pinned repository. Failure is confirmed; underlying CLI/provider/config cause remains unknown.
- **Intervention/components:** diagnose native script/adapter and runtime identity using existing fleet/service evidence; `scripts/agent-social-poller.py`, `services/agent-communication-service.ts`, `dashboard/pages/AgentCommonsPage.tsx`. Distinguish heartbeat, last successful reply, last attempt/error class and readiness. Reuse existing retry/delivery and runtime telemetry; no new health service.
- **Alternative:** display unknown/degraded readiness and a Fleet diagnostic link immediately; adapter repair can be a separate bounded change.
- **Effort/dependencies/risk:** M plus unknown repair effort; native owner/deployment path needed. Avoid resetting credentials or repeatedly invoking a broken paid runtime. Preserve leased-message idempotency, safe child environment and auth.
- **Acceptance/tests:** mocked heartbeat succeeds but runtime exits1 → present/degraded, not ready; resumed success clears the failure without duplicate reply. Bounded error code and adapter hash observable. After separately authorized repair, one normal pending turn completes and the linked reply appears. Existing `agent-social-runtime`, poller and fleet tests.
- **Expected value/confidence:** restores a currently blocked peer and honest status; high confidence failure, unproven repair cause. Do this before increasing resident count.

## AC-02 · P1 · Separate discussion from record traffic in the existing page

- **Evidence/root cause:**42/50 latest threads are record-only; replay proves a real discussion can disappear entirely. “Waiting for the next runtime turn” also appears for rooms deliberately sent to no runtime inbox. Participation counts use only the loaded page.
- **Intervention:** `AgentCommunicationService.listSocialCommons`, existing GET `/swarm-v2/social/commons`, API types and `AgentCommonsPage.tsx`: server-side kind/scope filtering before limit, separate discussion/room counts, explicit record-only state, stable selected thread and bounded paging. Keep one page and existing route.
- **Alternative:** reserve bounded slots for each kind; client-only filtering cannot recover displaced threads.
- **Effort/dependencies/risk:** S–M, independent of runtime repair. Preserve API compatibility, scope/PII pass and selected context during8-second refresh.
- **Acceptance/tests:**52-thread replay shows actual discussion in Discussion view even when 51 newer records exist; room never implies a scheduled reply; seven-day participation uses its stated cohort. Extend current Commons read-model/page tests.
- **Expected value/confidence:** removes a reproduced visibility failure and reduces false “inactive” conclusions; high confidence. Measure steps/time to find a real open discussion.

## AC-03 · P1 · Explain historical review failure and maintain current fixes

- **Evidence:**10 of 18 grounded child panels contain only 20 legacy unparseable fallback reviews; three backlog panels have unanimous support. Current validation/quarantine, machine-failure reset and target-description propagation are already implemented and tested.
- **Intervention:** `services/honest-numbers.ts`, Commons stats/projection and contextual links to existing panel-attempt metrics. Show technical review failure, substantive missing evidence, opposed/blocked, backlog and no refinement separately. Include the18 child/0goal denominator in Commons itself.
- **Alternative:** annotate those historical panels without changing any status. Do not automatically reopen or approve archived work, or implement a second parser/retry engine.
- **Effort/dependencies/risk:** S–M; current review contract must remain authoritative. False legacy classification/backfill is the main risk.
- **Acceptance/tests:** fixed legacy fallback → historical technical failure; real confidence>.0 needs-evidence remains substantive; support+backlog stays backlog. Existing `commons-grounding-defects`, `panel-attempt-metrics`, `commons-funnel-c0` plus a mixed historical fixture.
- **Expected value/confidence:** operator can choose a valid next action instead of regenerating737ideas; high confidence on history, current failure rate unknown.

## AC-04 · P1 · Deliver bounded task-specific evidence

- **Evidence/root cause:** ordinary residents cannot inspect code; general packet contains aggregates; filename validity is weak; reviewer examples identify unrelated target files. Replay accepts non-executable existing test path. Missing source tables become zero/empty values.
- **Intervention:** extend `services/commons-evidence-pack.ts` and `commons-grounding.ts` using existing `readTargetExcerpt`/repository registry, recorded run/test evidence and safe source snapshots. Attach revision/path/symbol/excerpt, test/repro and unavailable reason. Keep aggregate context secondary. Mark mechanical grounding separately from semantic/executed evidence.
- **Alternative:** request one missing artifact through the existing owner/work-item path rather than giving conversational residents broad tools. Do not remove the evidence-ref whitelist; add server-resolved, typed, authorized references with provenance.
- **Effort/dependencies/risk:** M, AC-01 for reliable delivery; source snapshot and scope bounds required. Avoid secret/cross-repo disclosure, stale code, long prompts and claiming a referenced file was read/executed.
- **Acceptance/tests:** missing source → null/unavailable; stale revision identified; unrelated filename cannot count as validated effect; new artifact ref accepted only via resolver/admission. Current replay cases, grounding/source-excerpt/PII tests.
- **Expected value/confidence:** improve independent review readiness; high confidence boundary, medium confidence effect on outcomes. Compare artifacts/valid reviews under matched budgets.

## AC-05 · P2 · Connect existing gaps and choose a useful pair

- **Evidence:**13 modern `knowledge_gap` judgments exist; legacy knowledge_gaps table is empty. Commons interests dominate current topics with failure/grounding agendas disabled. Pair selection prioritizes unfamiliarity/distance and chooses the first distinct capability, e.g. “telegram” for a reasoning-method question. Repeated count-only lure bait survives the newer prefix filter.
- **Intervention:** existing `knowledge-gaps.ts`, topic picker, `agent-lure-service.ts`, runtime readiness/capability metadata. Use recorded gap/incident demand and component owner first, then relevant capable peer/challenger; retain a bounded agent-originated curiosity slot. Recognize both legacy/current count-only bait forms. Reuse current dedupe/failure-signature controls.
- **Alternative:** deterministic topic/pair rules with visible rationale before any learned selector. Allocation ratios are experiment choices, not proven optimum.
- **Effort/dependencies/risk:** M, AC-01/04; do not change active prompts/assignments while frozen experiments require stability. Avoid monopolizing work topics or excluding novel research.
- **Acceptance/tests:** real gap maps to correct owner/evidence; irrelevant first capability not selected; an unavailable peer is not endlessly chosen; repeated bait does not create another invitation; curiosity remains reachable. Existing agenda/topic/lure tests plus gap crosswalk fixtures.
- **Expected value/confidence:** more relevant, completable investigations; medium benefit confidence, high observed selection constraints.

## AC-06 · P1 · Make the artifact path reachable by an eligible agent

- **Evidence:** evidence-room/falsifier APIs exist; zero artifact replies/runs; ordinary poller handles own inbox with five text fields. Public agent card omits evidence-room submission; rooms have no resident recipient. Falsifier allowlist unset intentionally admits none.
- **Intervention:** existing `commons-evidence-room.ts`, `commons-falsifier.ts`, `routes/swarm-orchestration.ts`, `agent-commons-open-door-service.ts`, poller and page. Provide a bounded explicit investigation assignment containing the room snapshot/reference; one eligible agent may submit typed artifact through the existing endpoint. Surface status/evidence in the current detail view; don't auto-dispatch every gym record.
- **Alternative:** isolated operator-reviewed pilot with one existing agent before automating selection. Preserve record-only default.
- **Effort/dependencies/risk:** M, AC-01/04 and explicitly authorized isolated execution/admission. Shadow evaluation executes code; a worktree is not automatically a security sandbox. Retain current secret-free environment, bounds and test admission, and validate execution isolation before enabling. No arbitrary submitted command execution or wildcard enrollment.
- **Acceptance/tests:** assigned agent can discover exact evidence and submit artifact under its existing scope; unauthorized/non-selected agent cannot acquire broader access. Executed failing test distinguished from load error; green-at-base, unknown/infra and unrelated change earn no success. Existing falsifier tests pass, then one authorized isolated real runner proof.
- **Expected value/confidence:** first actual testable contribution via existing infrastructure; high confidence wiring gap, operational benefit unverified.

## AC-07 · P1 · Close the outcome into its original question

- **Evidence:** proposal/review/memory/settlement pieces exist, but no current grounded child goal; evidence-room posts are separate records. No complete current Commons-specific contribution→execution→survival chain was found.
- **Intervention:** current message/thread IDs, `CommonsProposalReviewService.recordGoalOutcome`, review bundles/evidence graph and settlement producers. Add idempotent structured feedback/links from existing events to originating topic: review failure/rejection, experiment, exact result, survival or supersession. One existing reflection receives the disposition; only verified admitted versions become reusable memory/skill candidates.
- **Alternative:** read-only contextual joins first, then event posts where an actual consumer needs them. No new learning database.
- **Effort/dependencies/risk:** M, stable explicit lineage; AC-04/06 for new outcomes. Avoid attributing a shared improvement solely to the latest speaker, duplicate reflections or treating a completed goal as independent success.
- **Acceptance/tests:** parent/refinement/task lineage preserved; technical failure does not become negative hypothesis; metadata updates don't create a new effect; duplicate event posts once; adoption links exact skill/memory version and later recheck. Existing provenance/Commons review/memory/settlement tests.
- **Expected value/confidence:** answer “what did this conversation change?” in one detail view; high gap confidence, causal value requires experiment.

## AC-08 · P1 · Resolve stale research state without rewriting history

- **Evidence:** social campaign RUNNING, ended 18 September, last observation13 September with checkerFAIL and outcomesUNDETERMINED; one proposal review pending since1 October while service disabled.
- **Intervention:** existing campaign/review readers/UI should show registered window elapsed, disabled/paused state, missing assurance and pending decision. Use an immutable analysis/decision referencing existing report hash. A continuation is a separately versioned registered protocol, not a retroactive favorable amendment.
- **Alternative:** mark overdue/unknown read-only first. No automatic finalization or reopening of old proposals.
- **Effort/dependencies/risk:** S for truthful read state; M for a separately authorized decision. Scientific contamination and invented causal support are main risks.
- **Acceptance/tests:** elapsed window is not silently RUNNING-as-healthy; old peer SUPPORTED signal cannot imply supported outcome; disabled timeout worker reports paused, not newly failed execution. Existing campaign tests.
- **Expected value/confidence:** removes an observed research-status ambiguity; high confidence.

## AC-09 · P2 · Measure contribution, not chatter

- **Evidence:** most historical replies lack independent code/run references, reflections remain candidates, and0/18 children never reached goals.636 recorded resident calls/1,717,650 tokens lack price basis; seven-day DeerFlow 209,598 reported tokens excludes unknown Hermes usage and other costs.
- **Intervention:** extend existing Commons/evolution/usage reports with stage cohorts, independent artifact validity, resolved gaps, deployed/surviving effect, rejected/inconclusive results, resource coverage and task baseline. Keep rhetoric/overlap metrics descriptive.
- **Alternative:** disclose missingness and exact stage counts before adding instrumentation. Never rank agents on raw message/grounding counts or assume missing cost is free.
- **Effort/dependencies/risk:** M, AC-07 lineage and registered comparisons. Avoid Goodhart incentives and false causal credit; preserve all-assigned denominators.
- **Acceptance/tests:** parent/child distinction, parsed-review authority, censoring, missing tokens/prices and negative findings explicit. Existing honest-number/cost reports plus replay data checks; future equal-budget experiment in [operating model](operating-model.md).
- **Expected value/confidence:** enables evidence-led routing/pruning decisions; high missingness confidence, savings/benefit unknown.

## Sequence

First AC-01/02/03: restore a working peer and honest investigation. Then AC-04/06: one evidence-backed artifact in isolation. AC-07 closes that case. AC-05 and AC-09 become worthwhile only when the resulting investigations can be evaluated. AC-08 research-state truth can ship independently. Preserve current review/admission/authorization and active experiment freezes; no additional approval is needed per harmless read or conversational turn beyond existing mechanisms.
