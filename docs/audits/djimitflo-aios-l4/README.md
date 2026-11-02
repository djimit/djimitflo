# DjimitFlo AIOS L4: readiness assessment

- **Source:** origin/main `a4a083ac` (#1015, 2026-10-25 21:41 +0100). The research used `57182e9f` (#1014); #1015 landed during writing. Its engine citations were re-pinned to `a4a083ac`, and no other cited file changed between the two commits. Every `file:line` in this pack refers to that commit. Server paths are under `packages/server/src/`.
- **Date:** 2026-10-25.
- **Kind:** this pack consolidates existing evidence. It is not a new audit. It ran no prod queries, ran no app code, and ran no tests. Prod facts come from the cited sources, with their dates.
- **Files:**
  - [REVALIDATION](REVALIDATION.md): the 8 earlier findings, checked again.
  - [CONFORMANCE](CONFORMANCE.md): the runtime matrix.
  - [INVARIANTS](INVARIANTS.md): invariants A–G.
  - [BACKLOG](BACKLOG.md): the work packages.
  - [MILESTONE](MILESTONE.md): the first AIOS milestone and the evolutionary milestone.

## Verdict

DjimitFlo is a working **single-controller control plane** for one capability class: oracle-gated test work on its own repo. It is **not yet an agent OS**:
- Effects inside an agent CLI are not mediated.
- Ownership and permits live in one process.
- Recovery settles a run or puts it on hold. It never resumes.
- Two metrics still turn "unknown" into 0 or into "verified": the economy endpoint and gym outcome tokens. Engine outcomes were fixed in #1015.
- The learning loop has produced 0 promoted, inherited capabilities (L4 = 0, EVOLUTION-001 #960).

## What exists, what works, how it is proven

| Area | Works today | Proof (evidence status) |
|---|---|---|
| Authorization | Route permissions; Workstream F bypass repairs #963–#968 | [AUTHORITY_GRAPH](../../research/authority/AUTHORITY_GRAPH.md): 60 edges, failing-first tests (SOURCE_VERIFIED) |
| Runtime admission | A ledger checked on every attempt, enforced since 02-10 | `execution/runtime-admission.ts`, `execution/execution-engine.ts:324,630,845` (SOURCE_VERIFIED); the enforce flag is per the plan (OBSERVED 02-10) |
| Process termination | Process-group SIGTERM, then SIGKILL after 5 s (ORCA-PG) | `execution/executors/runtime-process.ts:95-115`; #1002 harness: 0 orphans; RUNTIME_PROCESS_GROUP_KILL=on in prod (RUNTIME_VERIFIED in the container, per the plan) |
| Result truth (gym) | Oracle red→green, mutant kill, prod gates, ELIGIBLE_GATED | `scripts/gym-worker.mjs:99-104`, `services/genome-registry.ts:258` (SOURCE_VERIFIED); gap matrix §1 |
| Cost truth | Unknown ≠ 0 in the cost ledger, token accounting and account usage | `services/cost-ledger.ts:15-16`, `services/maker-token-accounting.ts` (#818), #1012 (SOURCE_VERIFIED) |
| Operator truth | Cockpit states: null → UNKNOWN; mission detail is read-only | [CP3 FINAL_DECISION](../../research/operator-cockpit-3/FINAL_DECISION.md) (RUNTIME_VERIFIED on 10-10); #1006, #1010 |
| Learning discipline | Pre-registered trials, frozen holdouts, reuse block, NE registry | [EPOCH1-TRIAL-PREREG](../../research/evolution-001/EPOCH1-TRIAL-PREREG.md), [ACE-001](../../research/ace/ACE-001_PROTOCOL.md) (SOURCE_VERIFIED) |
| Recovery after data loss | Lost window labelled LOST, never zero | [RECOVERY-2026-10-12](../../research/RECOVERY-2026-10-12.md) |

## Missing guarantees

Details are in [INVARIANTS](INVARIANTS.md).

1. **Effect control (D).** Nothing mediates tool, fs, network or credential use inside a CLI (`services/tool-broker.ts:4-6`). Makers run as the uid that owns the DB (S0, #948). The sandbox-runner design is #950, still a draft that waits on operator root steps.
2. **Ownership (B).** There is no cross-process fencing. Permits and stop handles are in-memory (REVALIDATION #5).
3. **Recovery (E).** There is no resume path (`resumeInterruptedRuns` has no caller), no time-based sweep for gym runs, no cancel channel to a remote worker, and no per-effect states.
4. **Result truth (F).** `/swarms/economy` counts completed maker leases as verified (`services/loop-budget-service.ts:140`). Gym outcomes record unknown tokens as 0.
5. **Resource conservation (C).** The scheduler decides from constants. The observed-capacity shadow (#1014) mixes a cgroup CPU count with the host-wide load (`services/resource-scheduler.ts:78/96`).
6. **Learning truth (G).** No validated procedure reaches a fitting task. Skill cards are record-only by design.

## Evidence standard

| Status | Meaning |
|---|---|
| OBSERVED | A dated prod or host observation recorded in a cited source. It was not re-queried here. |
| SOURCE_VERIFIED | Read at `a4a083ac` with `file:line`. Callers were traced with `git grep`. |
| LOCAL_REPRODUCED | Reproduced by running code or tests locally on fixtures. **None in this pack.** The tests it names were not run. |
| RUNTIME_VERIFIED | A behaviour checked against its contract in the running prod system (read-only), dated, in a cited source |
| END_TO_END_VERIFIED | The full path (input → effect → recorded outcome) shown on prod records |
| CAUSALLY_SUPPORTED | A pre-registered controlled comparison supports the effect |
| INFERRED | Derived from the statuses above, not checked directly |
| UNKNOWN-BLOCKED | Not checked here, or not checkable without a blocked step (a prod read or an operator action). It never means "safe". |

## Sources reused (cited, not repeated)

- **PROCEDURE-LOOP gap matrix.** Local, 2026-10-25, source `57182e9f`. Not in the repo.
- **Orca delta review 976fa11e → 92fd257b.** Local, 2026-10-25. Not in the repo.
- **Operator plan.** Local. Entries used:
  - the AIOS readiness check, PROCEDURE-LOOP and AIOS L4 (25-10);
  - Workstream F (22-10);
  - the runtime admission gate (01-10, 02-10);
  - S0 / sandbox-runner (22-10);
  - #880 (17-10);
  - Phase E/EP (08-10);
  - CP3 (10-10).
- **On main:**
  - [authority](../../research/authority/);
  - [l3-forensics](../../research/l3-forensics/) (L3-REPORT-v2);
  - [evolution-001 prereg](../../research/evolution-001/);
  - [operator-cockpit-3](../../research/operator-cockpit-3/);
  - [ace](../../research/ace/);
  - [orca](../../research/orca/);
  - [swarm-evolution-2026-10-25](../swarm-evolution-2026-10-25/);
  - [djimitflo-l6](../djimitflo-l6/).
- **Drafts, not on main:**
  - EVOLUTION-001 #960;
  - CAUSAL-EVOLUTION-003 #969;
  - sandbox-runner #950;
  - DKF-EVOLUTION-001 #971.
