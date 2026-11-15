# M2 — value-contract coverage per recurring loop (proposals only)

Master prompt v1.1, milestone M2. This file is a proposal. It decides nothing, changes no flag and edits no protected
file. Every keep / improve / merge / pause / retire below is the operator's decision.

## 1. Scope, sources and windows

| Item | Value |
|---|---|
| Source read | origin/main `b496916b` (#1271) |
| Running build | prod `/health` 2026-11-15T00:54Z: commit = built_commit = `7758d153`, `commit_matches_build` true. #1264–#1271 are on main but not deployed. |
| Window | every runtime number below is **30 d: 2026-10-16T00:53Z → 2026-11-15T00:54Z**, recomputed with read-only `better-sqlite3 {readonly:true}` probes inside `djimitflo-live` (no writes, no model calls), unless the row says otherwise |
| Value allocator | the latest `value_allocation` shadow row (2026-11-14T03:54Z, its own w30 window). It is read as it is, not recomputed. |
| Reused | M0 inventory (`m0/inventory-summary.md`, 24 value contracts, 2026-11-14). I reuse its *list* of loops and its proposals. I cite none of its numbers without recomputing them. Where a recomputed number differs from M0, I give the new one. |
| Not measurable | self-improvement auto-review tokens: `llm_model_calls` has no row for them, and the value allocator lists `scheduler:self_improvement_auto_review` as UNKNOWN_COST. OpenMythos GPU: no ledger row. |

**The §6 elements.** The v1.1 text is not in the repository. I use the element list of the M0 value-contract schema:
1. goal and beneficiary
2. value type
3. baseline
4. outcome metric (independent of the component)
5. budget / cost carrier (tokens, kWh)
6. stop rule
7. decision rule and owner

**Existing carriers (no new one is proposed):**

| Code | Carrier |
|---|---|
| **FC** | `packages/server/src/services/fitness-contracts.ts`: 49 contracts. closed_loop 6, measured_no_selection 19, unmeasured 19, circular 5 (CODE). `cost.kwh` is null in all 49. |
| **LC** | loop contract (`loop-service.ts` `LOOP_CONTRACTS`, 7 loops). It carries goal, verification and `stop_conditions`. It is copied onto each run's `metadata.contract`. |
| **ER** | `experiment-registry.ts`: 11 experiments, each with a stop_by and a target n. |
| **MC** | `docs/research/intelligence-metrics/METRIC_CONTRACTS.yaml`: 13 metrics (VIG … ECON) with denominators, censoring and independence rules. |
| **RL** | the resource ledger (`resource-ledger.ts` / `cost-ledger.ts` `efficiencyWithCost`). It records cloud tokens per consumer and GPU-s / Wh per local job. |
| **VA** | the value allocator (`value-allocator.ts`, `VALUE_ALLOCATOR_MODE=shadow`). It records a class and a proposed action per consumer. |
| **LSC** | `loop_stop_condition` judgments (this PR, `LOOP_STOP_CONDITIONS_MODE=shadow`). It is the shadow check of LC `stop_conditions`. |

Legend for the coverage cells: ✔ = the element lives on that carrier; ✘ = missing; ~ = partial (the reason is in the note).

## 2. Spend in the window (who costs what)

The RL `efficiencyWithCost` view, 30 d:

**Cloud tokens:**

| Consumer | Tokens |
|---|---|
| maker:opencode | 126,210,870 |
| reviewer:security_checker:opencode | 6,448,773 |
| reviewer:checker:opencode | 4,927,909 |
| maker:codex | 1,052,652 |
| llm:jev | 857,335 |
| llm:content_safety | 482,228 |
| llm:evolution_gym | 308,129 |
| llm:panel_review | 193,674 |
| maker:claude | 188,725 |
| llm:embeddings | 46,878 |
| llm:content_drafts | 11,974 |
| llm:fallback | 9,503 |

**Local GPU:**

| Consumer | GPU-s | Wh | Jobs |
|---|---|---|---|
| gym:atomic@llama-router | 547,783 | 30,509 | 1,085 |
| maker:remote@workstation | 40,623 | 1,995 | 57 (16 verified of 42 attempts) |
| committee | 2,959 | 166 | 17 |

**Token-spending shadow judgments** (`judgments.input_tokens + output_tokens`, 30 d, `@jev-1.14.0` challenger arm in brackets):

| Judgment | Tokens |
|---|---|
| checker_second_opinion | 443,246 (+70,338) |
| failure_cause | 202,640 (+50,282) |
| decision_context | 164,715 (+27,054) |
| risk_atomic | 147,425 (+34,557) |
| proposal_prescreen | 122,345 (+22,797) |
| kb_passage_relevance (enforce) | 66,669 (+15,025) |

**Loop runs started in the window** (`loop_runs`):

| Loop | Runs |
|---|---|
| repo-maintenance-loop (GitHub PR review) | 1,258 |
| evolution-gym | 1,085 |
| doc-drift-and-small-fix-loop | 236 (221 daemon runs with a goal) |
| pl-001 | 134 |
| cv-001 | 53 |
| tg-001 | 21 |

5 of the 7 LC loops have no run in the window, and they have none all-time either.

## 3. What the stop-condition shadow will show (retro estimate)

`LOOP_STOP_CONDITIONS_MODE` is unset in prod, and `loop_stop_condition` has 0 rows. I applied the shadow's evaluators to the
**stored** `findings_json` / `plan_json` / `metadata` of the 221 daemon doc-drift runs in the window. These are start-time
fields; a retry or split can rewrite the plan later.

| Condition (LC, doc-drift) | holds | false | unknown |
|---|---|---|---|
| `no_findings` | 0 | 221 | 0 |
| `scan_budget_exhausted` | 0 | 0 | 221. All 221 are objective-mode runs, so no discovery scan ran. |
| `findings_planned` | 221 | 0 | 0 |
| `all_gates_passed_or_human_required` | not estimable retroactively: gates and status are final values, not dispatch-time values | | |

- **Verdict: would_stop 221 of 221 (100 %).** In every case it is `findings_planned`, at the point where the daemon dispatched the maker.
- 221 of 221 runs carry the same 4 conditions in `metadata.contract`.
- Reading: the doc-drift contract describes the read-only planning slice. There, "findings planned" means stop and wait for a human.
- Since objective mode, the daemon executes the maker after that point. So the contract has no stop rule for the maker cycle, and the cycle's real stops (retry once, token budget gate, approval wait) are on no contract.
- Treat this as a prediction for the shadow to confirm, not as a measurement.

## 4. Coverage per recurring loop, lane and scheduler that spends tokens or GPU

Columns: elements 1–7 from §1. Each cell names the carrier that has the element. Under it are the evidence and the proposal.

### 4.1 Maker lanes: LoopDaemon → doc-drift-and-small-fix-loop in objective mode (test_gap, exports, mutation_gap, finding_fix)

| 1 goal | 2 type | 3 baseline | 4 metric | 5 budget | 6 stop | 7 decision |
|---|---|---|---|---|---|---|
| ✔ LC + FC lane_* | ✘ (direct result: on no carrier) | ✔ RL north_star | ✔ FC `VERIFIED` + MC (settled) + VA | ✔ RL tokens; ✘ per-lane roll-up (FC `LANE_TOKENS`: "no per-lane roll-up exists") | ~ LC stop_conditions only describe planning (§3); lane caps exist (`TEST_GAP_MAX_PER_DAY=8`, `MUTATION_GAP_MAX_PER_DAY=2`) | ~ FC lane_test_gap / lane_exports / lane_mutation_gap / lane_finding_fix: decision_rule null for all 4 (lane_finding_fix is circular); the auto-merge revoke rules exist (FC auto_merge) |

**Evidence (30 d):**
- `self_improvements` settled in the window: 112 verified, 64 regressed, 32 infra_failed, 3 no_change (211 in total).
- VA classes maker:opencode `VALUE_PROVEN`: 104 verified, 49 survived. RL north star, week of 11-08: 29 verified at 0.801 per M cloud tokens.
- **1,473 of 1,473 goals created in the window have no `metadata.lane`.** So per-lane value and per-lane stop rules cannot be computed.

**Proposal: keep + improve.**
- Missing → carrier:
  - lane on the goal (FC lane_* `unit`; one additive metadata key where the lane source creates the goal)
  - per-lane token roll-up (RL `tokenLedger` grouped by that key)
  - **cycle-level stop conditions on the LC entry**: `retry_budget_exhausted`, `wall_clock_budget_exhausted` and `token_budget_exhausted`, which are already the doc-drift LC `escalation` names. LSC can then evaluate them, and the stale planning conditions get a separate `planning_stop_conditions` list.
  - value type `direct result` as an FC `note` per lane_*
- Decide on stop rules only after ≥ 2 weeks of LSC shadow rows.

### 4.2 Reviewers (checker, security_checker)

| 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|
| ✔ FC | ✘ (maintenance-risk) | ✔ ER F2 (checker) | ~ FC checker measured_no_selection via F2; security_checker **unmeasured** | ✔ RL (4.93M + 6.45M tokens) | ✔ ER F2 stop_by 2027-01-15 (checker only) | ✘ FC decision_rule null for both |

**Evidence:**
- ER F2 n = 57 (same family) and 46 (cross family) of a 93 target per arm.
- security_checker spends more tokens (6.45M) than checker (4.93M), and nothing measures it.

**Proposal:**
- **keep** checker until F2 reads out.
- **improve** security_checker: missing outcome metric → MC (a new `metric_id`, e.g. security-finding precision against djimitsec / settled reverts) and an FC decision rule. Until then its spend has no value claim.

### 4.3 Remote evolution gym (workstation GPU)

| 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|
| ✔ FC gym_genomes | ✘ (bounded knowledge) | ✔ FC (frozen holdout) | ✔ FC closed_loop (McNemar per genome) | ~ RL has GPU-s / Wh; **FC `cost.kwh` null; VA lists only `llm:gym` (UNKNOWN_COST), not the GPU consumer** | ~ per-genome McNemar (`DREAM_PROMOTION_ALPHA`); daily cap `EVOLUTION_GYM_REMOTE_MAX_PER_DAY=72`; no lane-level stop | ~ promotion rule only |

**Evidence:**
- 1,085 runs, 547,783 GPU-s (30.5 kWh), all `completed`.
- Genomes: 1 active, 3 trial, 18 retired, 6 inconclusive (all-time).
- `dream_ledger` in the window: 26 ACCEPT / 27 REJECT / 44 INCONCLUSIVE.

**Proposal: improve.**
- Missing → carrier: kWh on FC gym_genomes `cost.kwh` (point it at RL `gpuJobs`); the gym GPU consumer in VA's catalogue; a stop rule on decisions per kWh (FC `decision_rule`).
- Size the 72/day cap only after "promotion decisions per kWh" is on a carrier.

### 4.4 Remote maker (workstation, local model)

| 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|
| ✔ FC maker_species | ✘ | ✔ | ✔ FC (bandit, closed_loop) | ✔ RL (40,623 GPU-s, 1,995 Wh) | ~ bandit `LOOP_BANDIT_MAX_SHARE` only | ✔ FC bandit rule |

**Evidence:** 16 verified of 42 attempts. `maker/claim` polls: 6,207 in the window (`usage_counts`).

**Proposal: keep.** Missing → carrier: kWh is in RL but not in the bandit reward (FC note "cost is ignored"). Propose `cost.kwh` on FC maker_species. Do not change the bandit.

### 4.5 CV-001 (control vector, GPU in its window)

| 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|
| ✔ ER + FC control_vector | ✔ ER (bounded knowledge) | ✔ ER | ✔ ER four-rule | ~ RL (counted inside `gym:atomic`) | ✔ ER stop_by 2026-12-08 | ✔ ER |

**Evidence:** 53 cv-001 runs in the window; 23 pairs (ER) against a 120 target.

**Proposal: keep to readout.** Fully covered. Its energy is not split out from the gym consumer (RL).

### 4.6 Closed and overdue experiments that still hold WIP

- ER, as computed by the prod build `7758d153`: ACE-001 is overdue with every arm at or over its 50 target (65 / 60 / 62 / 52), stop_by 11-15. STE-001 is overdue at 135 / 100, stop_by 11-14.
- The STE-001 readout (#1271, INSUFFICIENT_EVIDENCE) is merged on main but not deployed.
- Closed experiments whose flags may still be set: PL-001, TG-001, X1, memory-holdout. M0 listed them; I did not recheck the flags.

**Proposal: read out ACE-001 (improve).** For STE-001, deploy the registry close. Retiring the flags of closed experiments is a config decision (operator).

### 4.7 Specialist panels (backlog proposals → goals)

| 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|
| ✔ FC specialist_panel | ✘ (direct result) | ✘ | ✘ FC **circular** | ✔ RL `llm:panel_review` 193,674 tokens; VA `llm:panel_review:review` INSUFFICIENT | ✘ none | ✘ FC decision_rule null |

**Evidence:** 215 `specialist_panels` rows in the window. `ORACLE_LANES_SKIP_PANEL=true` already bypasses panels for the oracle lanes.

**Proposal: improve.** Missing → carrier: an independent outcome (MC metric: verified rate of panel-created goals against oracle-lane goals that skipped the panel, on the same settlement definition). Until that metric exists, the panel has no value claim; it does not have to stop.

### 4.8 Token-spending shadow judgments

| Judgment | FC status | VA class (w30) | VA action | Tokens (30 d) | Stop rule |
|---|---|---|---|---|---|
| checker_second_opinion | circular | NO_CONSUMER | pause | 443,246 | ✘ |
| decision_context | unmeasured | NO_CONSUMER | pause | 164,715 | ✘ |
| risk_atomic | unmeasured | NO_CONSUMER | pause | 147,425 | ✘ |
| failure_cause | unmeasured | VALUE_PROVEN (learner-consumed, `DREAM_STATE_ENABLED=true`) | keep | 202,640 | ✘ |
| proposal_prescreen | measured_no_selection | EXPERIMENT (D5-NO) | keep | 122,345 | ✔ ER D5-NO stop_by 2027-01-09 |
| `*@jev-1.14.0` arms of the 5 above | — | EXPERIMENT (JEV-114) | keep | 205,028 total (plus the kb_passage_relevance arm, 15,025) | ✔ ER JEV-114 stop_by 2027-01-14 |

**Proposals:**
- **pause** checker_second_opinion, decision_context and risk_atomic. This matches VA's own `pause`; the flags are `TYPESAFE_*_MODE`, today `shadow`.
- **keep** failure_cause. This **revises M0**, which proposed pausing it: VA now classes it VALUE_PROVEN, because the dream-state learner consumes it.
- **improve** D5-NO: ER n `confident_no` = 0 of 100. It closes INCONCLUSIVE unless accrual starts.

Missing → carrier: an FC `decision_rule` for each judgment that stays.

### 4.9 Content safety

FC: no entry; `CONTENT_SAFETY_MODE` is a `NON_EVOLUTION_FLAGS` safety flag (`env-flags.ts`), so no fitness contract covers it. It spends 482,228 tokens (RL). VA lists `judgment:content_safety` as UNKNOWN_COST: tokens are reported for under 50 % of its 820 calls. Prod mode `CONTENT_SAFETY_MODE=shadow`; M0 said enforce, and the current value is shadow.

**Proposal: keep.** Missing → carrier: token reporting per call (VA coverage).

### 4.10 OpenMythos nightly (workstation GPU)

| 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|
| ✘ (no FC entry, no consumer named) | ✘ | ✘ | ✘ | ✘ RL and VA have no GPU row for it | ✘ | ✘ |

**Evidence:**
- `OPENMYTHOS_NIGHTLY_ENABLED=true`.
- 86 completed runs in the window, average `overall_score` 2.32.
- 4 runs stuck in `running`, the oldest since 2026-09-13.

**Proposal: pause** (operator flag) unless a consumer is named. If it stays, the missing elements go on FC (new component entry) and RL (its GPU job windows).

### 4.11 Committee swarm

FC committee_swarm closed_loop. `COMMITTEE_SWARM_ENABLED=false`. RL still shows 17 committee jobs (2,959 GPU-s, 166 Wh) inside the window. `/api/gym-worker/committee/claim` was polled 6,128 times.

**Proposal: retire (keep off).** Stop the worker's committee polling (worker config, not server).

### 4.12 Small LLM consumers

| Consumer | Tokens (30 d) | VA | Proposal |
|---|---|---|---|
| content drafts | 11,974 | NO_CONSUMER, pause | keep in shadow (cheap) or pause per VA; operator |
| dream evolution | 9,503 | INSUFFICIENT | keep (cost counted with the gym) |
| embeddings | 46,878 | UNKNOWN_COST | keep |
| self-improvement auto-review | not metered | UNKNOWN_COST | improve: a token row in `llm_model_calls` (RL) |

### 4.13 Recurring work that spends neither tokens nor GPU (listed so the M0 proposals stay visible; CPU only)

| Unit | Recomputed evidence (30 d) | Missing element → carrier | Proposal |
|---|---|---|---|
| GitHub PR review (label `repo-maintenance-loop`) | 1,258 runs: 1,256 completed, 2 failed | LC: it reuses the repo-maintenance contract label but never runs its discovery or its stop conditions | keep; rename the label |
| Dependency lane (`DEPENDENCY_LANE_MODE=act`) | 38 PRs tracked, **0 merged ever**, 3 open | FC lane_dependency has a rule but no outcome | improve or pause |
| Continuous learning loop | 791 `learning_cycles`, 0 patterns, 0 proposals; `meta_tuning_log` last 2026-11-05 | no FC entry, no consumer | merge / retire |
| Evidence room (`COMMONS_EVIDENCE_ROOM_MODE=on`, residents off) | 1,372 messages: 1,351 expired, 21 pending | no consumer (`SOCIAL_AUTOPILOT_RUNTIME=off`) | pause |
| Discovery backlog | 4,032 rows in `discovery_relevance_backlog`, judging paused | — | pause ingest or retire backlog |

## 5. Summary table (proposal per loop)

| Loop / lane | Spend (30 d) | Elements missing | Proposal |
|---|---|---|---|
| Maker lanes (LoopDaemon) | 127.4M cloud tokens (maker:opencode + codex + claude) | lane key, per-lane roll-up, cycle stop rule, value type | keep + improve |
| Reviewers | 11.4M cloud tokens | security_checker metric + rule | keep (checker) / improve (security_checker) |
| Remote gym | 30.5 kWh | kWh on FC, GPU consumer in VA, stop on decisions per kWh | improve |
| Remote maker | 2.0 kWh | kWh in the bandit reward | keep |
| CV-001 | in the gym kWh | split energy | keep to readout |
| ACE-001 / STE-001 | maker tokens | readout | read out / deploy close |
| Specialist panels | 0.19M tokens | independent metric, stop, rule | improve |
| Shadow judgments (3) | 0.76M tokens | consumer | pause |
| failure_cause / prescreen / JEV arms | 0.53M tokens | rule (failure_cause) | keep |
| Content safety | 0.48M tokens | token coverage | keep |
| OpenMythos nightly | GPU, unmetered | all 7 | pause |
| Committee swarm | 0.17 kWh | — | retire (off) + stop polling |

The per-loop share of the stop-condition shadow is in §3 for the one loop that runs (doc-drift). The other 6 LC loops have no
run, so the shadow will record no row for them. That is no observation, not green.

## 6. Proposed negative-evidence entry (text only; `NEGATIVE_EVIDENCE.yaml` is protected and not edited)

```yaml
- id: NE-018 (proposed)
  title: Loop-contract stop_conditions written for the read-only planning slice are not a maker-cycle stop rule
  status: CANDIDATE (confirm with >= 14 d of loop_stop_condition shadow rows before the operator files it)
  evidence:
    - retro on stored plan_json / findings_json / metadata of 221 daemon doc-drift runs, 2026-10-16..2026-11-15:
      would_stop 221 / 221 via findings_planned at maker dispatch; scan_budget_exhausted unknown 221 / 221 (objective mode)
    - packages/server/src/services/loop-service.ts LOOP_CONTRACTS (doc-drift stop_conditions)
  implication: do not enforce the current stop_conditions list as is (it would stop every maker run); define cycle-level
    conditions from the existing escalation names before any enforce mode
  owner: operator
```

## 7. Open questions for the operator

- Should the doc-drift contract get a separate cycle-level list (proposal 4.1), or should LSC evaluate the `escalation`
  names directly?
- Is OpenMythos read by anyone outside Djimitflo, for example the public leaderboard (`OPENMYTHOS_LEADERBOARD_PUBLIC` is set)?
  If so, name that consumer, and it gets FC and RL entries instead of a pause.
