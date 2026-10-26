# Evidence, verification and uncertainty register

Source/build identity is retained in [live-identity.json](live-identity.json). Exact source anchors are in [source-index.md](source-index.md). The dirty authoring workspace was preserved; source and tests used a detached checkout at `/private/tmp/djimitflo-swarm-audit-src`. This assessment adds documentation/evidence only.

## Runtime evidence and provenance

| Artifact | Authority and limits |
|---|---|
| [Schema evidence](schema-evidence.json), [collector](collect-schema.mjs) | Table/column metadata from SQLite readonly/query_only; no secret or message bodies |
| [Runtime evidence](runtime-evidence.json), [collector](collect-runtime.mjs) | Consistent read transaction, explicit SQL/parameters, selected allowlisted effective flags; existing pure resource, scorecard and shadow-allocation readers. Ephemeral inspection omits the process scheduler registry, so allocation summary is consumer evidence, not complete production-scheduler coverage |
| [Learning evidence](learning-evidence.json), [collector](collect-learning.mjs) | Separate consistent read transaction; closure/mission/assignment joins, outcome-credit counts and existing experiment/memory/sibling readers. No tick, promotion, reflection generation or inference invoked |
| [Initial runtime capture](runtime-evidence-initial.json) | Retained before correcting the audit's outcome-family classifier: its `production_maker` bucket also included gym/merge families. Use corrected runtime evidence for that claim; this was an audit classifier error, not production duplication |
| [Initial learning capture](learning-evidence-initial.json) | One audit query referenced nonexistent `agent_eval_runs.source`; corrected by selecting actual suite/status fields. Other queries succeeded. Not an application failure or evidence that source authority was observed |
| [Focused initial tests](focused-tests-initial.log), [resource tests](resource-ledger-tests.log) | Seven suites: 75 tests passed, two skipped. Resource suite initially could not load due temporary alias capturing `/jwt`; corrected alias then passed all ten resource tests. Total 85 existing tests passed, two skipped |
| [Temporary Vitest config](vitest.audit.config.mts) | Reuses installed dependencies while resolving the pinned shared source and JWT subpath. No new dependency installation; reused versions are not a fresh lockfile-install/CI proof |
| [HTTP reproduction](metric-replay.test.ts), [result](metric-replay.log) | One isolated actual GET route check, three fixture runs, one failed middle run, no leases/usage; current endpoint still emits first/last “success rates” 1/1 and costs 0/0. Demonstrates the semantic limitation, not a fixed implementation |
| [Derived validation](validation.json), [validator](validate-pack.py) | Crosschecks retained counts, sources, links, tests and hashes. Not independent experimental replication |

All production DB sessions use `readonly:true`, `fileMustExist:true`, `query_only=ON`, a read transaction and an explicit assertion before closing. Runtime collectors import read-only functions; no service constructors with table-creation side effects are invoked. Selected effective flags contain no token/key values. Evidence is aggregates, type/identity/status and existing bounded read models; no prompts or credential files were exported.

The snapshots occur at different timestamps. Within one file, queries/readers share the same SQLite snapshot; browser, health, schema and different evidence files are not one global transaction. Do not equate seven-day maker rows, 30-day scorecards, lifetime registry counts, latest-100 page samples and settled-only experiments.

## Browser/function verification matrix

| Function/state | Expected / actual | Verdict | Evidence |
|---|---|---|---|
| Open Mission Control | Real dashboard and operational sections render | WORKING for read/render | [top state](03-mission-control-top.txt), [image](03-mission-control-top.png) |
| Inspect capacity/readiness lower panels | Prepared/running/blocked reasons, integration/pilot/skill-readiness information available | WORKING for inspection; no runner execution tested | [lower state](03-mission-control-lower.txt), [bottom state](03-mission-control-bottom.txt) |
| Read historical proof | Completed record also reports missing real-runtime evidence | PARTIAL proof, correctly qualified; no certification inferred | top state/image; no Run Proof or Rollback clicked |
| Read learning curve | Actual success-rate/efficiency trend expected from label; binary first/last and fallback/missing-zero costs actually used | MISLEADING | [curve image](03-learning-curve.png), route source, isolated HTTP reproduction |
| Navigate to Agents | Rendered identity/connection/task cards and lower scorecards | WORKING for read/render | [image](01-agents.png); some Safari AX reads omit visible main content |
| Locate native agent's scorecard | Existing card/row located via Safari Find, not application search | WORKING browser inspection; in-app search not established | [scorecards image](01-agents-native.png) |
| Read agent success with no tasks | Insufficient evidence expected; card shows 0% | MISLEADING | Agents image/source |
| Read 30-day runtime scorecards | Cohorts, n, uncertainty, duration, unknown price visible and reader values reproduced | WORKING for defined observational metrics; comparative superiority unverified | scorecards image, `readers.runtime_scorecards` |
| Open Swarm | Overview, agents, tasks, feed and lower fleet/capability content render after loading | WORKING for read/render | [initial state](02-swarm-initial.txt), [loaded state](02-swarm.txt), [image](02-swarm.png) |
| Read Swarm activity/resource totals | Raw active registration status and zero agent counters displayed as activity/resource totals | MISLEADING | initial state, loaded cards and current runtime aggregate queries |
| Read learning feed | Two existing July notes appear; current execution learning lives in different tables | WORKING endpoint; PARTIAL current-learning coverage | [feed state](02-swarm-feed.txt), `swarm_learning` query and learning route source. Initial loading 0 was not a lasting empty-state defect |
| Mission capability health total | Latest-100 projection shown as total while full registry is 512 | PARTIAL / ambiguous scope | lower state, DB status counts, `missionControl()` source |
| Plan Capacity, Run Proof, Import, Close Learning, Apply Sync, Rollback, governance release | Mutations may persist data or start work | NOT_TESTABLE in this production read-only audit | Visible controls/source inspected; not clicked |
| Generic session execution | Source explicitly throws unconfigured executor; canonical goals/loops use another existing path | NOT_IMPLEMENTED in that generic service; source-only verification | immutable source anchor, zero session rows. No production execute request sent |

All three requested pages were visually inspected. Safe navigation, scrolling, native find and read views were exercised. Further detail/refresh interactions were curtailed after the user changed browser context; no conflicting GUI control continued. No claim is made to all controls, responsive/keyboard accessibility, every agent's native health or every host's meter.

## Semantic cautions and unresolved questions

- The proposed optimization target is independent useful outcome with stated quality constraints. Current `verified` can mean maker gates, proposal status, outcome settlement or a later survival state; retain each contract and provenance rather than summing them into a universal score.
- Corrected seven-day skill cohorts: 69 production-maker outcomes, 173 gym, 23 merge-survival, 40 agent-reported outcomes. These are rows at different grains; do not sum them as 305 independent improvements. Multiple roles/retries and failed assignments require explicit task-level accounting.
- Closure coverage is 29/41 completed repair runs, not 29/all ecosystem operations. Twelve missing cases are historical and need eligibility/evidence diagnosis. No blocked-closure events in the current window does not prove universal closure health.
- A registered mission's observed state can legitimately remain advisory while the linked goal finishes. Derived execution truth should expose that relationship without bypassing the planned-state review route.
- Outcome observations/causal learning are not certified by sender labels. Current outcome service deliberately withholds causal support; older causal-support rows are historical. This audit did not independently recertify them.
- Energy samples are workstation GPU power, not CPU/whole-host/cloud or calibrated wall-meter truth. The package sensor was not independently calibrated against a physical meter. Equal splitting of shared intervals is an allocation convention, not measured per-process causality.
- The retained resource reader's v2 token mirror correction exists already. Unknown/uninstrumented paths remain; its numbers are recorded totals, not complete token or cost truth. The richer canonical cost ledger and coverage should be reused.
- Memory-holdout uses settled proposal outcomes and excludes identified non-maker/fallback failures; X1 reports settled goals. Their Fisher values are existing descriptive readouts, not general effect/ROI certification. Concurrent studies, cluster dependence, unmeasured cost and missing assignments require readout scrutiny.
- No run in inspected experiment-period assignment events had both withheld and injected rules, which rules out that specific observed overlap. It does not rule out all contamination or other memory/retrieval exposure.
- Some registered config fields are absent in process environment. Null means unset, not automatically disabled; source defaults/readers determine effective behavior. Do not infer active behavior from speculative flag names retained as unknown.
- Two canonical-knowledge tests were skipped because the detached source lacked the external knowledge checkout. No fresh whole-platform CI, held-out scientific trial, deployment, native model inference, process-failure injection or real multi-host transfer was performed.

## Reproduction

Read-only production collectors can be sent via stdin to the existing container Node runtime, using authorized SSH. Store each run under a new timestamp rather than overwriting prior snapshots. No live constructor/tick/POST is needed. SQL and parameters are retained with results.

For local checks, check out the stated exact SHA, reuse compatible Node/dependencies and copy `vitest.audit.config.mts` into `packages/server/`. Run the eight files named in `focused-tests-initial.log`; the two knowledge symlink tests require that separate canonical checkout. Copy the audit fixture into `packages/server/src/__tests__/swarm-audit-metric-replay.test.ts` and run it with the same config. It creates an in-memory test DB and loopback HTTP fixture; no real model/runtime is invoked. Fixture auth is test-only pass-through and establishes no production authorization claim.

Primary research/docs were checked during this audit: [agent architecture study v3](https://arxiv.org/abs/2512.08296v3), [NVIDIA GPU power-reading scope](https://docs.nvidia.com/deploy/nvidia-smi/index.html#gpu-power-readings). They inform experimental design and sensor-scope terminology, not ecosystem performance claims. Memory was used to locate prior worker/assurance work; current conclusions were revalidated. No memory was updated.
