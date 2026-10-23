# H. Prioritized implementation backlog

Each item is independently deliverable. Root cause is marked confirmed or hypothesis.

| ID | Priority | Finding / root cause | Recommended change | Files / dependencies | Complexity | Acceptance / measurable impact | Confidence |
|---|---|---|---|---|---|---|---|
| DF-01 | P0 | Refinement conversion is false-zero; confirmed status-vs-goal join defect | Calculate reached-goal from `goals.improvement_id`; split goal creation, completion and verification | `improvement-funnel-service.ts`, page, funnel tests | S | Fixture with 18 linked children reports 18/307 reached goal and 14/18 completed | High |
| DF-02 | P0 | Panel goal rate uses all panels, including 505 unlinked; confirmed denominator defect | Restrict to unique proposal-linked panels or relabel metric; publish cohort metadata | same service/page/tests | M | SQL and UI agree on unit, denominator and multiplicity; unrelated panels do not change rate | High |
| DF-03 | P0 | “Panel reviews” counts panels created; confirmed label/query mismatch | Rename or query `specialist_reviews`; include 24h/7d timestamps | same | S | Label matches source table and test fixture | High |
| DF-04 | P1 | Verified/regressed use mutable status/update time | Add immutable state-transition timestamps/events; base window metrics on transitions | self-improvement lifecycle/schema/migrations/tests | M | Updating metadata cannot move a verification into a new cohort | High |
| DF-05 | P1 | Future-dated stall renders “since <1h” and repeatedly alerts | Treat future `since` as scheduled/invalid; validate stall timestamps | stall service, cockpit relative-time helper/tests | S | Future timestamp never appears elapsed or breached | High |
| DF-06 | P1 | Lazy module import remains broken after Retry | Make retry cache-bust/reload index, verify immutable asset deployment and retain shell on chunk error | `GlobalErrorBoundary`, Vite/deploy asset handling, E2E | M | Federation loads after deploy; simulated stale chunk recovers in one action | High |
| DF-07 | P1 | Integration HTTP reachability shown as health | Implement common state ladder with last business success/failure and capability probe | cockpit/integration health API/components | M | 404 can never be `HEALTHY`; each state shows evidence time | High |
| DF-08 | P1 | Configuration lacks provenance/effect semantics and runtime file contains stale duplicates | Return effective value metadata and running artifact identity; flag overrides/duplicates | Configuration page/API, bootstrap config resolution/tests | M | Every key shows source and activation mode; commit matches container/deploy ledger | High |
| DF-09 | P1 | Entity investigation requires 3+ context switches | Add resolver and reusable ContextTrail using existing IDs | task/run/goal/proposal/panel APIs and pages | L | Failed-goal journey reaches cause/evidence in ≤2 page transitions | Medium-high |
| DF-10 | P1 | Decisions mixes daily decisions and manage-config administration | Tabs/anchors with counts; move Telegram allowlist to Configuration while retaining deep link | Decisions, Configuration, route tests | M | Daily decision first meaningful action above fold; keyboard path reduced ≥50% | High |
| DF-11 | P2 | Large queues/tables lack consistent search/pagination | Reuse one QueueView pattern; server pagination where needed | Decisions/MCP/Audit/list APIs | M | First render bounded; filters share URL; 95th percentile scan task faster | Medium-high |
| DF-12 | P2 | Activity Overview duplicates Cockpit | Move unique spec/activity widgets to contextual locations, then remove Lab route | Dashboard/Cockpit/Layout/App route tests | M | No capability loss; one overview destination | Medium |
| DF-13 | P2 | Capability gain and reproduction unmeasured | Add preregistered capability metric and reproduction linkage to existing experiment/outcome records | evolution services/schema/page/tests | L | No “gain” without baseline, deployed artifact, survival and reproduction evidence | High |
| DF-14 | P2 | Resource totals do not link to contributing executions | Add drill-down from consumer/week to run IDs and attribution coverage | cockpit/economy/usage APIs | M | Spike journey identifies top runs in ≤2 clicks | Medium-high |
| DF-15 | P3 | Mixed locale and minor labels (`All statuss`) | Normalize copy and add string regression checks | Authority/Interaction Board copy tests | S | No mixed-locale/filter grammar defects in primary UI | High |

## Recommended sequence

1. DF-01–03: stop misleading operator decisions.
2. DF-05–08: restore trustworthy status, time and configuration evidence.
3. DF-09–11: reduce diagnostic friction without adding new subsystems.
4. DF-04, DF-13–14: strengthen outcome causality and efficiency attribution.
5. DF-12 and DF-15: subtract redundancy and polish.

Alternative to DF-09 is adding more page-specific links. It is cheaper initially but repeats logic and yields inconsistent entity coverage. Alternative to DF-08 is editing the runtime file in the UI; reject that until provenance, validation and restart semantics are correct.
