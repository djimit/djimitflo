# Architectural gap register

Architecture: React19/Vite8/TypeScript/Zustand dashboard, Express API, SQLite runtime records, native/Docker services, PostgreSQL central-memory/runtime schemas, Qdrant and Redis bus. Current source inventory is exact f957; local authoring checkout is older/dirty. Recommendations must be reconciled against current main before implementation. No rewrite/new database/service is justified by this audit.

| Gap / priority | Evidence and causal chain | Confidence / smallest existing extension |
|---|---|---|
| G01 incompatible measurement authority P0 | Raw evaluation rank combines93critic with0–5benchmark; operator may select wrong subject | High confirmed; cohort-aware OpenMythos reader/UI |
| G02 monitoring predicates P0 | ISO-vs-SQLite text time→0instead11stale/162instead78window | High confirmed; normalize shared read/repair semantics, review cancellation policy before applying |
| G03 event/filter contracts P1 | Tool handoff→task.failed and Loop→loop_run mismatch→noise/false empty | High confirmed; executor projection and canonical audit type/export contract |
| G04 effective-config context P1 | Env/default now works; DBtuning/per-run resolution hidden→source lookup needed | High source/current UI; annotate actual resolver and selected run |
| G05 identity-to-execution P1 | Capability/skill rows rarely version-linked to real leases; native package installs disconnected | High gap, medium adoption design; extend existing assignment/ingress/evidence graph |
| G06 decision closure P1 | Existing experiment report/ledger omitted from UI; null effects/verdicts leave some mechanisms perpetually running | High source, medium terminal policy; expose read-only report first, registered decision resolver separately |
| G07 immutable outcome/cohort P1 | Current status+updated_at can change historical verification population | High semantics; preserve immutable transitions/decision cohorts where existing evidence permits, unknown backfills |
| G08 independent labels P1 | Oracle agreement partly with checker-dependent outcome;22survived0 negative settled | High limitation; independent task/production labels, retain red/unknown gates |
| G09 projection ownership P1 investigate |694oldPGpending vs populatedQdrant; owner unknown | Medium operational impact, high count; identify current owner/retirement, reconciliation dry-run only, no blind replay |
| G10 economic attribution P2 | Missing model/skill versions/prices/tokens, many unattributed outcomes | High missingness; extend existing cost-ledger/skill-outcomes at producer boundary |
| G11 unsupported benefit claims P1 | “no value”,100%Usable,0/11closure can be overread | High semantics; authority/definition/cohort labels at existing surfaces |
| G12 navigation/context P2 |37navdestinations, related entities need copying IDs; hidden useful evidence | High observed fragmentation; contextual links/shared rendering only where repeated; preserve bookmarks |

Existing abstractions already cover much of the solution: runtime-config-view, runtime contracts, LoadErrorNotice/useResource, review bundles, provenance DAG, experiment registry, learning ledger, skill admission, signed events, cost ledger and settlement. Technical debt is inconsistent usage/contract scope, not a shortage of abstractions.

Test coverage was inspected by source, not exhaustively executed. Existing targeted suites include skill-loader-service, improvement-funnel, runtime-config-view, service-map, stall-watch, opencode-executor, provenance-dag and experiment/ledger tests. Passing them would validate specified behavior, not causal improvement. This audit's collectors/analyzer assert read-only/shape/arithmetic; application regression testing belongs to implementing each backlog item. Existing tests lacking realistic mixed timestamp/evaluation cohorts should be extended with reproducing fixtures.
