# F. Observability and diagnostic journeys

## Existing evidence already available

Cockpit supplies detector health/stalls/guardrails, runtime availability and efficiency. Goals & Loops provides a substantial review bundle; Task Review provides events/tools/approval/evidence/audit/diff/snapshots. Mission Control proof details compare persisted artifacts with minimums. Interaction Board correlates 500 loaded evidence records into threads/relations and marks production vs isolation. Observability provides metrics/errors and an authenticated stream; Audit and Authority preserve different event domains. Usage records consumer/provider/model activity. These are real capabilities, not just buttons.

Backend `provenance-dag.ts` already derives explicit source→proposal/refinement/requeue→loop→maker lease→PR→14 d settlement edges. Every edge names evidence_ref/origin; missing linkage becomes UNKNOWN, never inferred by temporal proximity. `/health/provenance-dag` is existing read-only wiring. It does not yet provide a complete panel/task/model/config timeline, and main UI discovery/drill-down is incomplete. **Extend this and the review bundle; do not build a second resolver, event store or log dashboard.**

## Exercised journeys and limits

Step = deliberate user-level navigation/select/query/scroll action; context switch = change to another page/domain view. Search text entry counted as one action. Times were not stopwatch-measured; tool/network/AX latency is not human time to diagnosis. Do not use estimated 4–6 step journeys as measured evidence.

| Journey | Actual path and actions | Steps / context changes | Diagnostic result / dead end |
|---|---|---|---|
| Find a failed task cause | Tasks→enter knowledge-gaps→select failed task→Review |4 actions/2 page transitions after list entry |80 events 20 errors 26 tools, approval Granted,5 evidence 8 audit; useful local context. Tool-calls false failures contaminate error count.80 events is not proof complete logs |
| Inspect failed loop | Goals & Loops→select loop170a58…→scroll review evidence |3 actions/0 page transitions after page entry |evolve_no_winner/checker_dispatch_skipped/maker_failed narrative found. Selected row below large history; no URL selection. Proposal/panel/model evidence not one connected click path |
| Identify degraded provider/runtime | Cockpit service rows→Usage; then Configuration filter for effective checker |3 destinations/2 context switches; filter tested separately |Transport 404 and recent successful JEV requests coexist legitimately. Missing joined business-health/history prevents one-view diagnosis; no reproducible outage timing measured |
| Investigate rejected proposal / specialist disagreement | Funnel summary→look for candidate-specific evidence/drill-down; source/API panel and Decisions queue correlation |PARTIAL; no successful complete browser path, no reliable step/time total |Aggregate rejection/calibration not a candidate list. Existing panels/reviews retain dissent, but operator must know IDs/page ownership. No claim that evidence does not exist |
| Determine durable experiment benefit | Cockpit lineage→Evolution gate evidence |2 destinations/1 switch |Current 14 d settlement/readiness visible; capability gain/reproduction explicitly unmeasured. Proof detail checked separately: completed yet 5 minimum categories short. Cannot conclude causal improvement |
| Locate effective workflow configuration | Configuration→filter LOOP_CHECKER_RUNTIME |2 actions/0 switch after page entry |Finds hermes. Cannot resolve DB tuning/default/fallback for a particular run from this catalog alone. Runtime identity is current; not a stale-config proof |
| Explain resource spike | Cockpit efficiency→Usage consumer/provider view |2 destinations/1 switch, investigation incomplete |Provider/call metrics exist; contributing run/cost coverage not directly joined in tested path. No real spike was selected, so cause/time-to-diagnosis remains NOT_TESTABLE |
| Find loop audit evidence | Audit→Log viewer→Loop filter |3 actions/1 tab switch |Dead end: empty due loop vs loop_run; 1,082 events actually stored. Confirmed workflow failure |
| Investigate cross-agent evidence | Interaction Board→no-match query→Clear→Relations |4 actions/1 tab switch |Filters/reset and observed edges work.500-record cap and unattributed no-target events bound completeness; source says relation order is not causality |
| Inspect proof minimums | Mission Control→existing proof link |2 actions/1 page transition |Artifact counts, missing categories and runtime codex clearly shown; plain artifact IDs prevent further direct drill-down |

Acceptance targets in H are prospective and must be measured with comparable fixtures/operators; this audit does not claim observed productivity savings from an unimplemented design.

## Correlation coverage

| Identifier/domain | Existing evidence | Gap / smallest useful extension |
|---|---|---|
| task_id |Task detail/review, execution_events, approvals/audit; Interaction Board task threads |Carry task link into lease/loop/proposal views; artifact navigation handler missing |
| run_id / loop_run_id |Goals loops, review bundle, cognitive dedup, maker leases, provenance DAG |Avoid conflating proof IDs, benchmark run IDs and loop IDs; typed labels/links |
| agent_id |Agents, task attribution, runtime governance, social actor IDs |Crosswalk registered agent, execution role, provider/runtime and social identity; show absent mapping |
| goal_id / proposal_id |goals.improvement_id, loop_runs.goal_id, refinement/requeue links |Expose origin/child links and immutable transitions; never join by title/time alone |
| panel_id / review identity |specialist_panels, specialist_reviews, proposal panel reference, review actors |Current panel reference is not full review history. Show reviewer evidence/disagreement and decision time separately |
| trace_id / spans |Assurance traces, worker traces, Interaction Board source refs |Link known trace/lease/task; show coverage/truncation, not assume universal trace propagation |
| candidate_id / experiment_id |Capability/trial/gym/expert/memory candidates and experiment registry |Different candidate domains need typed refs. Link actual treatment/outcome/protocol rather than one ambiguous candidate label |
| decision_id / authority seq |Audit and Authority event/resource IDs and per-entity seq, decision actors |Expose resource/entity link and explicit terminal expiry vs rejection; do not create a redundant global ID when existing key suffices |
| policy_version |Approval policy refs and runtime-governance evidence exist |Policy label alone not a versioned execution snapshot. Uniform per-run version binding not proven |
| model_version |llm_model_calls stores provider/model; runtime artifacts/build commit known |Model alias is not immutable provider revision. Record available revision/hash where real source exposes it; UNKNOWN otherwise |
| config/build/protocol |Health exact SHA, experiment protocol/source, persisted tuning history |Attach effective selected config/tuning version to existing execution evidence. No new credentials/services required |

## Log quality and reproducibility

What happened is often answerable; why and what next are weaker at domain boundaries. OpenCode step-finish taxonomy creates 6,722 false terminal events, spreading into error counts/interaction actions. Audit filter hides real rows; frontend export discards filters; events can be stream-truncated and review rendering is bounded. Preserve raw evidence and annotate transformations. Do not count event errors as independent failed executions.

Reproduction needs existing run/task/lease, source/artifact SHA, protocol/input/evidence references, resolved runtime/model/config, tool invocation/outcome and independent checker result. These are partially present. End-to-end model/prompt-version/input replay and log completeness were not proven. Safe inspection should link available records and mark missing data; it should not automatically rerun tasks or mutate policy.

Runtime health/image proof is retained in runtime-evidence.json. Earlier logs showed stalls/public SPA-fallback probes/request-aborted errors, but no verified causal chain links any particular asset 404 to the recovered Federation chunk error. Scanner-looking paths receiving the SPA shell are not compromise evidence; distinguish fallback HTTP 200 from a real resource response in diagnostics. External log retention, centralized search and provider-side trace history remain unverified.
