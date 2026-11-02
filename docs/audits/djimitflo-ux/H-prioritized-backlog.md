# H. Prioritized implementation backlog

No application fixes were implemented. P0 means material operational-decision/data-integrity failure; P1 major workflow/observability; P2 efficiency; P3 low impact. Complexity S≈one component/service and fixtures, M≈several existing boundaries, L≈lifecycle migration/instrumentation; these are relative estimates, not delivery commitments. Expected benefits are acceptance hypotheses unless an exact corrected count is stated.

Source shorthand: **S**=`packages/server/src/services/`; **D**=`packages/dashboard/src/`; **T**=`packages/server/src/__tests__/`. All references are deployed `be0b3ab`. Existing test names below were source-inspected, not run; add cases to the nearest existing suite, not parallel infrastructure. Evidence IDs/screenshots are indexed in [evidence-index.md](evidence-index.md).

## DF-01 — P0: compare only compatible governance evaluations

- **Finding/evidence/root cause:** confirmed 0–100 critic 93 rendered/ranked with 0–5 scores (06, governance_scales); raw cross-cohort query and frontend threshold.
- **Change/files:** S/openmythos-eval-service.ts getLeaderboard/getAgentScore, explainer-generation-service.ts writer metadata, D/pages/GovernanceScorecardPage.tsx. Expose benchmark/corpus/rubric/scale/version/time and choose comparable cohorts; reuse getModelOnlyLeaderboard filtering principles.
- **Alternative:** separate critic score panel immediately; do not numerically normalize different tasks into a single rank. **Complexity/dependencies:** M, metadata availability/backfill compatibility. **Regression risk:** existing API consumers and legitimate historical runs disappearing; retain access via explicit history/cohort selector.
- **Acceptance/tests:** T/openmythos-eval-service.test.ts plus UI fixture with 93 critic and 4.2 model; incompatible rows never share ranking/trend, out-of-range value cannot appear as valid 0–5. **Expected impact:** removes observed false comparison; compare reviewer selection error rate before/after. **Confidence:** high.

## DF-02 — P0: normalize health time comparisons

- **Finding/evidence/root cause:** confirmed mixed ISO/SQLite text ordering; 0 stale vs 11 normalized, 135 runs in the source 24-hour window vs 73 normalized (12, db-evidence). Same stale predicate also appears in healing cancellation path.
- **Change/files:** S/self-healing-service.ts read and repair predicates/callers; use one UTC comparison convention, validate legacy formats. Preserve read-only scan/worktree dryRun behavior; do not invoke healing as part of fix validation.
- **Alternative:** normalize stored timestamps via migration, higher risk; consistent julianday or normalized ISO parameters is smaller initially. **Complexity/dependencies:** S–M, data format/index/query-plan check. **Regression risk:** newly detected prepared leases could be canceled by existing repair logic; review stale policy before enabling repair, preserve separate explicit action.
- **Acceptance/tests:** isolated SQLite fixtures same-day/previous-day/UTC offsets/exact 1 h and 24 h bounds/NULL-invalid; scan matches normalized reference, errors/invalid data are UNKNOWN, no writes. **Expected impact:** restores 11 hidden predicate matches in retained snapshot, eliminates known window overcount. **Confidence:** high.

## DF-03 — P1: distinguish step progress from terminal task failure

- **Finding/evidence/root cause:** confirmed tool-calls step_finish→TASK_FAILED/ERROR; 6,722 events; sampled 20 errors (04).
- **Change/files:** `packages/server/src/execution/executors/opencode-executor.ts`, consuming review/error/Interaction projections; emit nonterminal progress for tool handoff and actual terminal result once. Inspect all event consumers before changing taxonomy.
- **Alternative:** filter false-error count only in UI as temporary mitigation, leaves polluted event consumers. **Complexity/dependencies:** M, executor result contract. **Regression risk:** hiding real failure or double completion; preserve unknown terminal reasons as diagnostic, not success.
- **Acceptance/tests:** T/opencode-executor.test.ts stream fixture tool-call→tool-result→stop and real failed exit; exactly one terminal event, correct review error count; immutable raw history retained/annotated. **Expected impact:** removes proven noise class, measure diagnostic precision and false alerts. **Confidence:** high.

## DF-04 — P1: repair audit filtering, pagination and export scope

- **Finding/evidence/root cause:** Loop UI value loop vs stored loop_run; empty Next enabled; export ignores filters (07).
- **Change/files:** D/pages/AuditLogViewer.tsx and existing audit-logs route/service: canonical resource types, offset reset, bounded hasMore/total, explicit empty/error, shared list/export scope.
- **Alternative:** map legacy loop alias server-side while migrating UI; needed only for compatibility. **Complexity/dependencies:** S–M, API filter contract. **Regression risk:** export narrowing surprises users relying on full export; label filtered/full explicitly without extra dialog.
- **Acceptance/tests:** populated loop_run/task fixture, multi-page filter change resets offset, empty Next disabled, filtered export matches selected scope, authorization unchanged. **Expected impact:** restore access to 1,082 recorded loop events in snapshot; no false empty investigation. **Confidence:** high.

## DF-05 — P1: publish lane-aware funnel contracts

- **Finding/evidence/root cause:**195 unreviewed default consensus rows counted as decisions; 192 oracle-authorized panels omitted from 55 goal consensus count; historical refinement 18/307 vs current 0/307; panels-created labeled reviews (D, panel-review/lane evidence).
- **Change/files:** S/improvement-funnel-service.ts, specialist-panel-service.ts, self-improvement-service.ts contract only where needed; D/pages/ImprovementFunnelPage.tsx. Show review/quorum decisions, oracle authorization, actual goal creation, historical conversion/current outcomes separately. Use existing joins/evidence, no policy change.
- **Alternative:** relabel current metrics immediately and add historical stage tooltip; cheaper but still limited diagnosis. **Complexity/dependencies:** M, agreed lane/cohort eligibility. **Regression risk:** historical reports/API consumers; version fields/labels, preserve raw counts and uncertainty.
- **Acceptance/tests:** T/improvement-funnel.test.ts fixture defaults/repeated/shared panels/cancelled history/oracle skip/archived refined child with goal; 0 specialist reviews stays 0, no default counted as completed decision, conversion denominator explicit. **Expected impact:** operators can locate actual bottleneck; 18/307 ever-goal does not imply 18 verified gains. **Confidence:** high.

## DF-06 — P1: make outcome cohorts reproducible

- **Finding/evidence/root cause:** current status+updated_at used as verification cohort; regressed can mean first failed gate. Confirmed source semantics, not evidence every historical timestamp wrong.
- **Change/files:** S/self-improvement-service.ts, existing event/lifecycle readers and lineage; schema migration only if immutable transition evidence unavailable. Distinguish first verification, later metadata update, gate failure, loss of previously verified benefit, infra/no-change.
- **Alternative:** truthful current-status labels now, postponing historical cohort reconstruction; safe immediate mitigation. **Complexity/dependencies:** M–L, evidence/backfill quality. **Regression risk:** irreversible invented history; mark unknown when transitions cannot be reconstructed.
- **Acceptance/tests:** metadata-only update cannot enter verification cohort; initial gate failure not “regression after success”; regressed→verified race retains both transitions. **Expected impact:** stable 30 d/7 d metrics and credible survival analysis; historical causal benefit remains uncertain. **Confidence:** high on defect boundary, medium on recoverable history.

## DF-07 — P1: expose complete effective configuration in existing catalog

- **Finding/evidence/root cause:** process.env catalog omits defaults/DB active tuning/per-run overrides; filter and restart guidance already work (03, E).
- **Change/files:** S/runtime-config-view.ts, relevant LoopService resolution points, health/config route, D/pages/ConfigurationPage.tsx. Add intent/source/override/activation metadata with masks and effective run context.
- **Alternative:** source-linked read-only explanation per setting first; lower coverage, low migration risk. **Complexity/dependencies:** M, resolver owners/metadata. **Regression risk:** secret exposure or claiming stale/env value effective; return redacted structured metadata, never raw merged env.
- **Acceptance/tests:** T/runtime-config-view.test.ts + meta-tuning-chain/loop fixtures: env vs default vs DB override consistent with actual consumer, startup/next-run timing stated, credentials masked, existing filter retained. **Expected impact:** effective-runtime/budget question answerable from UI without source lookup. **Confidence:** high.

## DF-08 — P1: connect existing diagnostic evidence

- **Finding/evidence/root cause:** review bundles/DAG/Interaction Board exist, but proposal/panel/lease/task/proof IDs remain disconnected; View Artifact has no handler (02/04/10, F).
- **Change/files:** S/provenance-dag.ts and review-bundle composition only for missing explicit edges; D/pages/GoalsLoopsPage.tsx, ReviewPage.tsx, ProofRunDetailPage.tsx, ImprovementFunnelPage.tsx, components/ExecutionTimeline.tsx. Add linkable selected run and entity links; retain cap/error/UNKNOWN semantics.
- **Alternative:** a few direct links first, then reusable rendering after repeated shapes emerge. **Complexity/dependencies:** M, existing typed identifiers/routes; do not build another resolver. **Regression risk:** incorrect/unauthorized cross-entity disclosure, broken saved links; enforce existing tenant/permission scope.
- **Acceptance/tests:** T/provenance-dag.test.ts + existing GoalsLoopsPage/TaskRuntimeContract fixtures: failed goal reaches recorded cause/evidence in≤2 transitions; valid artifact link works; missing edge explicit, no title/time joins. **Expected impact:** fewer context switches; baseline F is partial and human time savings must be measured. **Confidence:** high gap, medium benefit size.

## DF-09 — P1: make integration states capability-specific

- **Finding/evidence/root cause:** service-map maps 429 and other non 404/non 5 xx to up; no auth sent; root 404 coexists with successful JEV calls (E).
- **Change/files:** S/service-map.ts, existing usage/runtime health aggregation, Cockpit/Fleet/Usage contextual rendering. Preserve transport result and add separately bounded recent business success/failure, n/window/time, policy disabled and unknown auth.
- **Alternative:** relabel up→responded and link Usage immediately; no new active probe required. **Complexity/dependencies:** M, consumer-to-dependency mapping. **Regression risk:** extra provider traffic/quota or misleading roll-up; prefer existing telemetry/cache and bounded safe probes only.
- **Acceptance/tests:** T/service-map.test.ts 429/401/403/404/5xx/timeout/policy isolation; no status alone proves semantic healthy; old timeout cannot override newer success without explicit policy. **Expected impact:** reduce false outage/false healthy conclusions and cross-page diagnosis. **Confidence:** high.

## DF-10 — P1: restore passive inspection boundary for MCP

- **Finding/evidence/root cause:** mount GETrefresh=true persists probe state/can sync missing catalogs (V21, E).
- **Change/files:** D/lib/api.ts getMCPServers, MCPPermissionsPage.tsx, `packages/server/src/routes/mcp.ts`; passive inventory GET, explicitly named probe/sync effect using current permissions.
- **Alternative:** keep combined refresh action but make mount passive; smallest complete first step. **Complexity/dependencies:** S–M, catalog bootstrap expectations. **Regression risk:** stale probes until refreshed; show age and one low-friction action, no new approval chain.
- **Acceptance/tests:** repeated read-only page load causes no catalog/probe DB writes; deliberate refresh reports changed metadata/scope; outbound-deny and unenforced-catalog disclosure retained. **Expected impact:** trustworthy read-only audit/investigation, reduced hidden refresh traffic. **Confidence:** high.

## DF-11 — P1: preserve loading/error/refresh truth

- **Finding/evidence/root cause:** Tasks bootstrap Promise.all couples agent failure; Swarm initial zeros/false empties; cockpit refresh mixes freshness; outer Suspense hides shell (A/B).
- **Change/files:** D/App.tsx DataLoader/Suspense placement, existing useResource/LoadErrorNotice callers, OperatorCockpitPage.tsx, SwarmResourcesPage.tsx. Independent resource state and per-section timestamps; retain last good values with stale/error indication.
- **Alternative:** page-specific fixes first; shared hook only where already applicable. **Complexity/dependencies:** M, WS/REST state reconciliation. **Regression risk:** race/duplicate requests or overwriting newer WS data; preserve existing sequence guards.
- **Acceptance/tests:** agent API fails while Tasks succeeds→Tasks visible; pending data unknown not 0; one section fails without blank shell; header refresh scope explicit. Existing GlobalErrorBoundary/chunk-reload tests extended for recovered-stale-chunk case, not assumed absent. **Expected impact:** fewer false-empty/healthy diagnoses. **Confidence:** high source/live boundary, failure path not injected in audit.

## DF-12 — P1: use event time for elapsed stall

- **Finding/evidence/root cause:** experiment target reached before futurestop_by; since uses deadline, relative formatter renders<1 h (D).
- **Change/files:** S/stall-watch.ts/experiment-registry.ts contract and D/lib/format.ts callers. Preserve legitimate target-reached verdict alert; record target/detected time separately from deadline.
- **Alternative:** render no elapsed age until trustworthy origin exists, with explicit reason. **Complexity/dependencies:** S, available transition time. **Regression risk:** suppressing valid alerts or inventing historical onset; UNKNOWN age safer than guessed date.
- **Acceptance/tests:** T/stall-watch.test.ts target reached before deadline still alerts, future deadline never displays elapsed since; invalid timestamps explicit. **Expected impact:** trustworthy urgency/alert age; no claim it removes real experimental backlog. **Confidence:** high.

## DF-13 — P2: improve task density and readable identifiers

- **Finding/evidence/root cause:** long Decisions queues; card overflow and Review summary collision; 0/0 success as 0%, hash-only repository names (04/05, B).
- **Change/files:** DecisionsInboxPage.tsx section counts/paging; AgentsPage.tsx, ReviewPage.tsx, RepositoriesPage.tsx shrink/wrap/labels. Reuse current lists/components; no new design system.
- **Alternative:** anchor navigation and wrapping before virtualization. **Complexity/dependencies:** M, pagination API only if client bound inadequate. **Regression risk:** hidden queue items, keyboard focus loss or confusing count changes.
- **Acceptance/tests:** narrow desktop and 200% zoom long-ID fixture readable; zero sample shown—/n 0; all queues reachable; selected count/window clear; compare representative queue task steps before/after. **Expected impact:** fewer scan/focus errors, savings measured after implementation. **Confidence:** high defects, medium benefit size.

## DF-14 — P2: price/attribute resources before claiming efficiency or learning gain

- **Finding/evidence/root cause:**2,406/2,592 knowledge runs unattributed; unpriced calls and unused assets; 90% meta confidence is heuristic; process counters reset; durable gain unmeasured (D).
- **Change/files:** existing efficiency/usage/knowledge-fitness/evolution evidence services and consumers; S/meta-orchestration-service.ts labels/contract, persisted tuning/run identity where missing. Link top consumers to runs, n, priced coverage and independent outcomes.
- **Alternative:** expose missingness/heuristic/reset scope immediately, defer new instrumentation until attribution gap understood. **Complexity/dependencies:** M–L, provenance/telemetry quality. **Regression risk:** false causal attribution, token/cost estimates represented as truth, added logging cost.
- **Acceptance/tests:** missing prices neverfree, transportok neververifiedgain, heuristic confidence named, cohort/attribution denominators visible; target increase qualifying attributed-run coverage from~4.2% maker baseline while preserving independent validation. **Expected impact:** identify waste/value with auditable uncertainty, not guaranteed savings. **Confidence:** high gaps, medium instrumentation feasibility.

## DF-15 — P2: render published explainers faithfully and safely

- **Finding/evidence/root cause:** malformed badges and raw Mermaid fences in public prose (11); minimal regex Markdown renderer lacks structured image/fence handling.
- **Change/files:** S/explore-public-page-service.ts, existing safe rendering path if suitable, tests for published bundles. Preserve escaping/safe URL handling; show code fallback and accessible diagram text.
- **Alternative:** safely preformat unsupported syntax instead of adding a parser/dependency. **Complexity/dependencies:** S–M, compatibility with generated sections. **Regression risk:** XSS/link injection or changed historical rendering.
- **Acceptance/tests:** nested badge/image/fenced-code fixture readable; unsafe URLs/HTML remain inert; commit/provenance text remains. **Expected impact:** architecture/evidence comprehensible without copying raw Markdown. **Confidence:** high.

## DF-16 — P2: consolidate only after preserving unique capabilities

- **Finding/evidence/root cause:** Activity/Cockpit overlap; agent/social/catalog/runtime concepts split; useful distinct contracts also exist (A/G).
- **Change/files:** D/components/Layout.tsx, App.tsx, DashboardPage/spec consumers and contextual capability views after usage inventory. Keep redirects and distinct evidence types.
- **Alternative:** retain routes with cross-links, measure actual use first. **Complexity/dependencies:** M, DF-08 and usage/user validation. **Regression risk:** lost bookmarked workflow or misleading merged identities.
- **Acceptance/tests:** every preexisting task retains reachable capability; no dead links; navigation task success improves in measured operator scenarios. **Expected impact:** reduced recall/navigation burden, no assumed page deletion savings. **Confidence:** medium.

## DF-17 — P3: unify wording without changing contracts

- **Finding/evidence/root cause:** All statuss; mixed Dutch/English Authority/Board copy (B).
- **Change/files:** InteractionBoardPage.tsx, AuthorityTracePage.tsx and affected labels/accessibility names.
- **Alternative:** keep local-language descriptions if intentional, fix grammar and state units first. **Complexity/dependencies:** S, agreed product language. **Regression risk:** tests relying on labels; update accessible selectors alongside copy.
- **Acceptance/tests:** label snapshots/a 11 y role names consistent, no change to decisions or permissions. **Expected impact:** modest recognition improvement. **Confidence:** high, low impact.

## Sequence

1. DF-01/02: incorrect operational comparisons and monitoring blind spot.
2. DF-03/04/05/10: event/decision truth, usable audit evidence, passive read boundary.
3. DF-07/08/09/11/12: effective state, connected diagnosis and trustworthy freshness/time.
4. DF-06/14: immutable outcomes, attribution and independent gains; truthful labels can ship earlier.
5. DF-13/15, then conditional DF-16/17: task efficiency, public comprehension and subtraction.

Run isolated regression fixtures and targeted UI journeys before any production adoption. Approval/deploy/rollback remain separate authorized work; this backlog is reviewable implementation guidance, not deployment authorization.
