# Logs, traces and diagnostic journeys

DjimitFlo already has execution events, review bundles, audit/authority ledgers, loop events, runtime contracts, provenance DAG/evidence edges, Interaction Board, outbox and signed external ingestion. The problem is inconsistent semantics and incomplete links, not absence of another logging dashboard. [Runtime snapshot](runtime-db-evidence.json), [baseline journeys](../djimitflo-ux/F-observability-diagnostic-journeys.md), current screenshots02–05 and [route wiring](route-api-inventory.json) support the following.

## Correlation and evidence boundaries

Existing IDs include goal, proposal/improvement, panel/review, loop_run, task, lease/parent_lease, agent, capability, experiment/arm, model, skill_content_hash, genome, PR/head SHA and evidence refs. Keep them typed. task.failed during an OpenCode tool handoff is not terminal task failure:6,766 such retained events pollute diagnosis. Preserve raw events, correct the projection and terminal taxonomy. An authenticated fleet event proves reporting identity, not independent truth of its reported success.

There are2,716 published SQLite outbox records (max2 attempts) and12,550 external events, supporting real ingestion. This does not prove each consumer used them. The PostgreSQL central-memory outbox's694 pending June records belong to another pipeline; distinguish it from the current bus. Recent leases have no capability_id, and skill outcomes have no version. A generic global trace_id is not the first fix: preserve the existing explicit links at execution and adapter boundaries, add a correlation identifier only when an actual request cannot be joined by existing IDs.

## Measured operator journeys

Counts are lower bounds on navigation/actions from observed surfaces. Time-to-diagnosis was not clocked under controlled operator conditions; do not invent seconds or usability-study results. Baseline has detailed route/action observations; current extensions recheck the specific dead ends.

| Journey / observed minimum | Result, switches and missing context | Target acceptance |
|---|---|---|
| Failed goal: Goals→select run→review bundle→Task/Review (≥3 transitions) | Useful checker/gate evidence exists; fragmented IDs, no durable selected-run deep link, artifact button baseline dead end; tool handoffs inflate errors. More than one operational view | Recorded cause/evidence reachable≤2 transitions, typed deep link preserved after reload; raw/event/terminal status distinct |
| Degraded integration: Cockpit→Fleet→Usage (≥2 switches) | New service-map business-state helps; heartbeat, endpoint response and task success still separate. Version/auth/last error not consistently in one context | Capability-specific status with last success/failure,n/window,time, config and existing diagnostics linked |
| Rejected proposal: Funnel→Decisions→panel/evidence (≥2 switches) | Lane/consensus/defaults and actual specialist disagreement require separate records; batch counts aren't provenance | Proposal detail links origin, panel/reviews, eligibility, evidence, rejection and next safe action without copying IDs |
| Durable improvement: Evolution→PR settlement→external source/evidence (≥2 switches) |14d settlement exists, but effect/experiment/transfer context missing. Current page hides experiment registry and ledger entirely | Existing Evolution reveals protocol/arms/cohort/CI/decision and exact settled outcome links; UNKNOWN when absent |
| Effective workflow config: Configuration→Self-Driving/Audit→source/runtime (≥2 switches, source lookup dead end) | Env/default view works; current DB tuning and next assignment precedence require undocumented knowledge | Selected run shows resolved config source/revision/activation timing and links catalog subset |
| Resource spike: Usage→consumer→run/lease attribution | Consumer totals available; many model calls/leases lack complete identity, prices or outcome link. No reproducible end-to-end spike case selected | Top consumer rows drill to bounded constituent runs, measured/unmeasured cost coverage and independent outcomes |
| Loop audit: Audit→Log viewer→Loop (2actions after navigation) | Fresh current UI becomes empty despite existing loop_run entries; Next remains enabled | Canonical type filter restores records; count/empty/error/paging/export share scope |

## Feedback and accessibility

Knowledge table screenshot05 shows crowded headings/overflow at the actual desktop window. Fix wrapping, minimum widths and accessible scrolling before adding visualization. Preserve native labels, skip link, keyboard focus and readable identifiers. Baseline Agents/Review overflow persists in unchanged source but was not freshly screenshot-tested after this release. Initial Loading and stale-zero states must not be interpreted as settled health; outer Suspense can remove navigation. Retain shell, per-resource pending/error/stale timestamps and last-good data using existing components.

Recommendation: contextual evidence sections on existing entity pages, with copyable IDs, scope/window, result authority and previous/next events. Use existing review-bundle and provenance services. Do not expose arbitrary log files, credentials, prompts or cross-tenant evidence. Recovery actions retain existing permissions and destructive confirmation boundaries. No error injection, secret inspection, live stream reconnect test or production replay was performed.
