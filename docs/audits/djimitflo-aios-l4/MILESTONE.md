# First AIOS milestone

## M1: two real runtimes run one bounded agent application through the same contracts

**The application.** An oracle-lane maker goal (test-gap / mutation-gap). It is bounded:
- one target file and scope;
- deterministic checks;
- a checker;
- a human merge.

**The runtimes.**
- **opencode** on the VPS: the primary maker.
- **remote@workstation**: atomic on the workstation, pulled over `remote_maker_jobs`.

**This already runs.** These are evolve siblings:
- **Eligibility** is a goal with `evolve=true` or test-gap / mutation-gap evidence (`services/evolve-selection.ts:31-37`).
- **Sibling spawn** happens at `services/loop-daemon.ts:685-731`. The sibling gets the primary maker's auto-approved scope (`:402-412`) or inherits the approval (`:416`).
- **Winner selection** is `selectEvolveWinner` (`services/evolve-selection.ts:77`), among gate-passing makers only (`evolve_selected` / `evolve_no_winner`, `:86,154`).
- **Randomisation:** X1 randomises whether a sibling runs (`effort_x1`).
- **Prod use:** the plan reports that every oracle goal gets a remote@workstation sibling (01-10, Z3; OBSERVED), and that the remote sibling won 14/64 (EP, 08-10; OBSERVED).
- **Current flags:** LOOP_EVOLVE_ENABLED and LOOP_EVOLVE_SPECIES are UNKNOWN (not re-read).

### Acceptance items

"Demonstrable" means the records exist in the named prod tables. Nothing was re-queried for this pack, so each item is at most OBSERVED until a read-only probe confirms it on a dated window.

| # | Contract both runtimes must meet | Where it shows in prod | Status |
|---|---|---|---|
| 1 | Same admission decision per attempt | `execution_events` (`metadata.source='runtime-admission'`, `execution/execution-engine.ts:854-861`); `policy_violations` if refused | **demonstrable**. Remote is admitted without a version (CONFORMANCE). |
| 2 | Same approval and scope | `worker_leases.metadata.auto_approved_scope`; `loop_events` `goal_auto_approved`; `approvals` | **demonstrable** |
| 3 | Same gates on the result | `worker_leases` (checks / verdict metadata); `loop_runs` gates; `loop_events` `evolve_selected` / `evolve_no_winner` | **demonstrable** |
| 4 | Same attribution of the outcome | `judgments` (`outcome_attribution`); `outcome_credits` | **demonstrable**. Unattributed rows stay `unknown` (CP3). |
| 5 | Ownership: a stale result is refused | `remote_maker_jobs.lease_id`, `reason` containing `late_result` | **demonstrable** for remote; opencode is in-process |
| 6 | Comparable outcome per runtime | `worker_leases` (runtime, status); `loop_events` `evolve_selected`; X1 arm records | **demonstrable**, with a confound: the sibling runs only after the primary maker |
| 7 | Usage per attempt with coverage | `worker_leases.metadata.token_accounting` | **partial**. opencode is `provider_reported`, remote is `unavailable`. |
| 8 | Cancel with confirmed termination | opencode: process-group stop (`execution/executors/runtime-process.ts:95-115`) | **missing for remote**. The cancel is a DB flag the worker never sees (BACKLOG B7). |
| 9 | Effect states (intended / done / not done / unknown) | none outside the ASG harness (`services/asg/effects.ts`) | **missing** for both |
| 10 | Recovery of an in-flight job after a VPS restart | opencode: task `unknown` + hold. Remote: the result is dropped as `late_result`. | **missing for remote** (BACKLOG B12; the hold is the correct floor) |
| 11 | Runtime identity (version, served model) | `runtime_contract_probes` for VPS runtimes only | **missing for remote** (BACKLOG B13, B16) |

### Done when

All of these hold:
- Items 1–7 are confirmed on one dated 14-day window by a read-only probe.
- Items 8–11 have shipped behind flags, each with its scenario test:
  - cancel mid-flight → container gone ≤ 70 s, no outcome, late result rejected;
  - restart mid-job → result kept as evidence, nothing applied;
  - version and served model recorded or `null`.
- No item depends on runtime-specific code in the gates or in attribution.

**Today:** 6 items are demonstrable, 1 is partial and 4 are missing. Status: **NOT MET**.

## M-EVO: the evolutionary milestone (PL-001)

**Claim to test.** A validated procedure, served only to fitting tasks, raises the share of tasks independently verified within budget. The comparison is against the same species without it.

**Design.** It is fixed in the PROCEDURE-LOOP gap matrix §4 and is not repeated here:
- species atomic@llama-router;
- the arms differ only in the procedure lines;
- a new frozen task set (never epoch-0 or epoch-1);
- its own loop name;
- one-sided exact McNemar, α 0.05, n = 60 pairs (power about 0.84 at +20 pt);
- a harm stop, an e-value of 20 or more, and day 14 → INCONCLUSIVE.

**Prerequisites.**
- B2 (outcome truth).
- B5 (selector, shadow first).
- B6 (panel), for operator legibility.
- B7 is optional.

**Operator gates.**
- Freeze the manifest.
- Assign a share of the cap, because the epoch-1 trials g-a187f81f / g-d14c1156 have claim priority.
- Give the start go.
- Confirm the TG surface change.

**Verdict states.**
- **CAUSALLY_SUPPORTED:** p < 0.05 and no harm trigger. The procedure may then become `active` for fitting tasks only.
- **REJECTED:** a harm stop, entered in the NE registry.
- **INCONCLUSIVE:** day 14 without n.

Today the system has 0 retained verified capabilities from evolution (EVOLUTION-001 #960). M-EVO would be the first controlled, positive inheritance.
