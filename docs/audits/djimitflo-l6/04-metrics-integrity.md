# Data and metric integrity

Evidence: [runtime snapshot](runtime-db-evidence.json), [existing built reports](built-reports.json), [experiment diagnostics](experiment-diagnostics.json), [offline recomputation](offline-analysis.json). Each has its own capture time; transactions are consistent within a file, not across hosts/files. Current source `f957b55`; all windows below are UTC. Live polling is a read schedule, not proof upstream values refreshed.

## Core semantic contracts

| Metric / current retained value | Population, calculation, provenance, refresh and exclusions | Interpretation / correction |
|---|---|---|
| Proposals1424 | self_improvements rows, all current statuses/lifetime; COUNT, no decision denominator; API recomputes on fetch | Inventory/throughput, not gains |
| Panels1587 | specialist_panels rows, multiple intake lanes and event multiplicity; not one row/proposal | Greater than proposals is legitimate; no one-to-one invariant |
| Panel goal rate4% |48 goal-consensus panels /1079 distinct proposal-linked panels, rounded; total1587 disclosed in new UI | Improved cohort label; denominator still includes195 default consensus unreviewed, hence not completed-decision conversion |
| Historical refinements6% |18 distinct refined proposal children with goals /307 refined children;14 completed/4 failed goals | New release fixed status-only 0%; goal reach ≠ verified/sustained benefit. Lifecycle status totals may change |
| Episodes285 / strategies2 | cognitive event/strategy records, separate population from proposals | Persistence and heuristic pattern count, not evidence strategy caused improvement |
| Verified29 / regressed16 /36%7d | current self_improvements statuses filtered by updated_at;16/(29+16), rounded | Current-status recently-updated cohort, not first-verification transitions or post-success regression. Metadata updates may move cohort; initial gate failure may be called regressed |
| Panels created9/24h,77/7d | created_at panel rows | New truthful label; low count is not scheduler failure without due/eligible/attempt logs |
| Specialist reviews6/24h,58/7d | specialist_reviews created_at rows; distinct panels separately queried | Reviews differ from panel creation and authorizations; prior “2 reviews” cannot establish outage |
| Median verification .4h | existing funnel elapsed creation→verification/status evidence over its eligible cohort | Conditional on observed completions; excludes censored pending work, not end-to-end throughput SLA. Transition evidence limitations retained from baseline D |
| Open work160 | work_items statuses candidate/triaged/planned/leased/blocked | Queue inventory; distinct from goals/approvals/PRs, not expected equality |
| Zombie0 / stale0 funnel | funnel-specific persisted status/age predicates | Only proves no matches to that contract; does not validate separate Health scan. Zero must show monitor/window/freshness |
| Health stale0 vs11 | scan compares ISO text to SQLite datetime string; julianday normalized reference yields11 running/prepared >1h | Confirmed P0 blind spot; qualify prepared/blocked readiness before cancellation. No healing invoked |
| Health24h162 vs78 | same text-order problem in loop_runs created_at; source7blocked155 completed vs normalized3blocked75 completed | Incorrect population even if numerator failure0 remains0; preserve blocked ≠ terminal failed distinction |
| Governance93 /4.20 | raw completed eval overall_score from incompatible critic/model cases/scales | Do not normalize blindly. Separate corpus/rubric/scale/evaluator/task cohorts before ranking/trend |
| Skill successes139/139 fleet | signed agent outcome events become skill_outcomes; no hash/version/model/evidence/tokens in this cohort | Authenticated authorship and reported result, not independent execution quality |
| Knowledge “no value”3 rules | ≥5 attributable uses and observed verification below pooled baseline, Wilson intervals displayed;90d2619runs112 maker-attributable,77otherfailures2430unattributed | Association only; label “below observed baseline” with uncertainty. Not causal pruning basis |
| Merge survival22/22 | existing settlement after14d;22re-executed PASS,0recordedregression;56pending,38activeopen | Conditional historical survival under implemented checks, not30d/causal gain. Lifetime22 vs60d19 legitimate scope difference |
| Learning loops0/11 | eleven named mechanisms; closed=ADOPTED and CI excludes0;8running3notmeasured | Contract is stricter than “adaptation happened”; several effect/verdict callbacks missing and genomes hardcode closedfalse. Do not call global learning rate0% |
| Model Usable100% | llm_model_calls.ok/transport/parser acceptance, not independent task success; gymClaude10/Codex5 transportok but task0 | Rename/define transport usability and show task outcome separately |
| North star verified/Mtok | recorded qualifying verified count / recorded cloud token millions; consumer-level rates have their own eligible attempts | Resource estimates/cohorts differ. Never divide all29 by only local energy for10eligible verified makers and call local efficiency |

## Experimental contracts

Memory holdout has104 settled qualifying runs/104 distinct goals, no observed crossover, one lane. Rules55/73 vs holdout28/31, difference−14.98pp, Fisher two-sided p=.1102. Assigned population138 includes infrastructure, non-maker failures, fallback and no-change exclusions; diagnostic SQL retains these categories. These exclusions define a per-protocol/settled estimand, not intention-to-treat across all assigned work. No current retry-duplication was found. Registered protocol includes attribution/stratification and harm/stopping rules; do not retrofit a favorable test after seeing the interim data.

ACE103 analyzed outcomes across four cells, target50/cell; retrieval factor−.168, examples−.033, descriptive. Assignment delivery111 records is a different population;100% reported delivery is not retrieval relevance. STE50/49 vs target100/arm: .68 vs .612, token means323525 vs461458, descriptive. MAKER-DEPS33/39 vs141, CI[−.179,.268]. X1 registry43/55 vs94 differs from the30d51/76 report; p1 vs .8298 is not automatically a discrepancy. F2 has inadequate independent labels and actual crossovers; κnull is correct for no class variance.

TG-001 r2:20 task definitions/four arms/80 rows, scored19/20/20/18 after infrastructure censoring. Primary A−B19 pairs:9bothpass,5Aonly,2Bonly,3bothfail;Δ.158,95%CI[−.128,.422],McNemar p=.453125.19/20 tasks had prior A exposure. It is inconclusive on that task suite, not held-out generalization or swarm benefit. Forecasts based on accrual must account for frozen task capacity and censoring before projecting target completion.

## Required durable contract

Every displayed metric needs owner/version, entity/unit, explicit numerator/denominator, eligibility/exclusions, event-time/window/refresh timestamp, aggregation and rounding, uncertainty/missingness, evidence link and allowed decision. Reuse existing report types and SQL readers. Freeze registered analysis cohorts/outcomes at decision time; retain mutable operational status separately. Do not invent historical transition timestamps when evidence is absent. For all other baseline surfaces, [D](../djimitflo-ux/D-data-metrics-audit.md) records source definitions and limitations; they are not retrospectively re-certified by this extension.
