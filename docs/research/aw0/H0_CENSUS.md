# AW-0 H0: census of historical maker leases, and the H1 design

| Field | Value |
|---|---|
| Directive | Operator: H0 census first (read-only), then design H1 as a **code-only** per-lease outcome predictor. No LLM. jev is the only System One backend and is never used for code, approval, promotion, risk or fitness judgments. The local System One was retired on 2026-09-30. |
| Parent | PR #998 (`docs/research/aw0/EXPERIMENTS.md` §2–3, `DECISION.md`). This file **replaces #998's H1 mechanism**: #998 proposed a local-LLM predictor; H1 is now a logistic regression. |
| Data | Production DB `/data/djimitflo.sqlite` in `djimitflo-live`, opened `readonly` + `query_only=ON`. Three aggregate-only scripts were run with `docker exec` and removed afterwards. Nothing was written. Snapshot taken 2026-10-24, last maker lease 2026-10-24T21:12Z. |
| Disclosure | The census saw aggregate label × lane × month counts, including the period that will become the H1 test window. No feature was fitted and no predictor or baseline was scored. The H1 protocol must be frozen before any score is computed. |
| Status | Census done. The H1 protocol is a later PR. Nothing built, flagged or deployed. |

## 1. Census results

### 1.1 Population

| Set | n | Note |
|---|---|---|
| `worker_leases` with `role = 'maker'` | 1,895 | 2026-06-02 … 2026-10-24 |
| of which `metadata.synthetic = true` | **1,126** | `repo-maintenance-loop` backfill rows (`runtime = manual`, only `github_pr` / `notes`). These are not maker runs and are **excluded from everything below**. |
| Real maker leases | **769** | |

Real maker leases by month, loop, runtime and terminal status:

| Month | n | | Loop | n | | Runtime | n | | Status | n |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-06 | 203 | | doc-drift-and-small-fix-loop | 685 | | opencode | 368 | | completed | 347 |
| 2026-07 | 5 | | legacy-evidence-recovery | 65 | | remote | 157 | | failed | 359 |
| 2026-08 | 0 | | research-loop | 18 | | codex | 144 | | cancelled | 62 |
| 2026-09 | 166 | | repo-maintenance-loop | 1 | | agent_mesh | 65 | | prepared | 1 |
| 2026-10 (to 24th) | 395 | | | | | atomic 16 · claude 13 · mock 5 · manual 1 | | | | |

Goal lane comes from the proposal's `evidence_refs_json`: exports 192, mutation-gap 151, test-gap 80, other proposal 8. A further 338 have no proposal: doc-drift 254, legacy recovery 65, research 18, repo maintenance 1.

### 1.2 Where check results live, and the two labels

Check results are stored in `worker_leases.metadata.deterministic_checks`, written once by `runDeterministicChecks` (`loop-service.ts`) together with `checks_completed_at`. There is no separate table. `withoutHiddenChecks` removes the FBPA shadow check. Checks run **only when the maker runtime exited 0**. All 376 leases with a check verdict have `exit_status = 0`. Runtime failures (116 non-zero exits) and timeouts (74) never get checks.

| Label | Definition | n | pass / fail | pass rate | goals (clusters) |
|---|---|---|---|---|---|
| **L-checks** (#998's label) | All non-hidden deterministic checks exit 0. A missing tool (127 / `missing_script`, 4 leases) is not a verdict. | **376** | 279 / 97 | 0.742 | 281 |
| **L-lease** (composite) | pass = L-checks pass. fail = checks failed, **or** the runtime exited non-zero, **or** it timed out. Excludes cancelled/prepared (63), never-ran/denied (88), exit 0 without checks (48) and tool-missing (4). Only goal-linked leases are counted. | **524** | 279 / 245 | 0.532 | 369 |

L-checks by lane, all time: test-gap 44/44 · exports 138/147 · mutation-gap 53/82 · doc-drift 38/94 · research 4/7 · other 2/2.

L-checks by month: 06: 24/78 · 09: 36/41 · 10: 219/257. The months differ sharply: in June codex failed checks 54 of 78 times on doc-drift. In October most leases are oracle lanes on opencode (`glm-5.2:cloud`) and `remote@workstation/atomic@llama-router`.

### 1.3 Temporal split (fixed cutoff at the census median)

| | L-checks | L-lease |
|---|---|---|
| Cutoff (median lease start) | 2026-10-05T12:15Z | 2026-10-05T09:17Z |
| Train (before the cutoff) | 188 (116 pass) | 262 (115 pass) |
| **Test (after the cutoff, so far)** | **188 (163 pass / 25 fail, 0.867)** | **262 (164 pass / 98 fail, 0.626)** |
| Test goals (clusters) | 144 (mean cluster 1.31) | 175 (mean cluster 1.50) |
| Test by lane | exports 98/105 · test-gap 24/24 · mutation-gap 41/59 | exports 98/133 · test-gap 24/25 · mutation-gap 42/103 · other 0/1 |
| Test rows in lanes with a trailing rate in [0.1, 0.9] | 59 (41 / 18) | 249 (152 / 97) |
| Volume, last 30 d | 270 (9.0 / day) | 364 (12.1 / day) |
| Evolve siblings (share a goal with the first maker) | 103 | 132 |

Every test row is from an oracle lane. All doc-drift failures fall in the train half, so the halves differ in distribution. This is kept, because it is the deployment condition.

### 1.4 Power at the observed base rates

#998's power table assumed base rates of 0.35–0.50. This census repeated the same simulation at the observed rates: a calibrated binormal forecaster, a paired Brier-gain test against the true base rate, two-sided α 0.05. The design effect (DE) is bounded by the mean cluster size, because DE = 1 + (m − 1)·ICC ≤ m.

| Label, test half | base | n for 80 % power at AUC 0.66 / 0.70 / 0.74 | Power now at AUC 0.70 (DE 1 / 1.3 / 1.5) |
|---|---|---|---|
| L-checks, n = 188 | 0.867 | ≈ 1,020 / **704** / 520 | 0.26 / 0.21 / 0.17 |
| L-lease, n = 262 | 0.626 | ≈ 376 / **238** / 148 | 0.86 / 0.74 / 0.71 |

**Is the ≈ 250–350 from #998 met?** In total eligible rows, yes: 376 (L-checks) and 524 (L-lease). By #998's own H0 rule ("≥ 250 eligible → run H1 offline in one pass"), that would be enough. But #998's H1 row asks for 250–350 **test** leases at a base rate near 0.5. With L-checks the test half is 188 rows at 0.87, so it detects only a strong predictor; at AUC 0.70 its power is 0.17–0.26. L-lease brings the test half close to 50/50, and that makes the study feasible.

### 1.5 Pre-lease features: recorded vs. available only after the run

`worker_leases.metadata` is **one merged JSON blob with no per-key timestamps**. Keys written at insert, before the runtime starts, sit next to keys written after the run. Every key below was classified from its writer in code. Counts are over the 376 L-checks leases.

| Candidate feature | Recorded at dispatch? | Coverage | Source, and the rule for H1 |
|---|---|---|---|
| Lane: loop name, goal lane | Yes. Run and proposal exist before the lease. | 376 / 376 · 275 / 376 | `loop_runs.loop_name`, `self_improvements.evidence_refs_json` |
| Risk class | Yes, with a caveat | 376 / 376 (low / medium; no high) | `goals.risk_class`. Goal rows are **mutable with no history** (`goal-service` update can change risk_class, objective and acceptance criteria). 334 / 376 goal rows have `updated_at` after the lease was created, mostly status changes. **Rule:** use it, and run a sensitivity check without it. |
| Runtime / species as dispatched | Yes | 376 / 376 | `requested_runtime` and `effective_runtime` at insert. The bandit rewrites `runtime` and `bandit` **before** execution (fine; 163 have a bandit choice). An engine fallback rewrites the runtime **after** the run (4 leases). **Rule:** use the as-dispatched species, never the `runtime` column read afterwards. |
| Model | Yes | 243 / 376 have `model` / `model_id`. A bandit choice without a model means the runtime default. | `model` at insert or bandit time. `model_id`, `provider`, `prompt_hash` are written at dispatch (`leaseIdentity`, before `executeTask`). `effective_model` can be rewritten on fallback. **Rule:** a missing model is its own "default" category. |
| Genome / skill | Partly | `genome_id` 11. Strategy genome `genome` 168 and ACE/STE arms 85 are **stamped on the lease after the run** (daemon step 9). | **Rule:** read genome, examples, rules and the ACE/STE arm from the `assignment_context` loop event created **before** `started_at`. 267 / 376 have one; none was found only after start. |
| Retry lineage / evolve sibling | Yes | retry or sibling 124 / 376. Siblings 103. | Written at insert. A retry or sibling is created after its predecessor's checks, so the predecessor's outcome is legitimately known for those leases. |
| Prior outcomes on the target file | **Derivable** | Target file known for 275. 97 had an earlier lease on the same target. | `grounding_json.target`. **Rule:** count only earlier leases whose `checks_completed_at` (or terminal `updated_at`) is **before** this lease's `started_at`. Counting by creation time would leak concurrent siblings. |
| Plan | Yes, via snapshot | `plan_json` on 376 runs. `checkpoint_before` snapshot for 696 / 769 real leases. | **Rule:** read the plan from the `loop_checkpoints` row named by `checkpoint_before_id` (state at start), never from the live `loop_runs.plan_json`. |
| Target file size | **Not recorded** | 0 | The base commit is not stored (`verified_head_sha` exists on only 19 runs, and is post-run). It can be rebuilt only approximately (the last `origin/main` commit before `started_at`). **Excluded from the primary model.** |
| Assignment packet size | **Not recorded** for 98 % | `assignment_packet_copy` / sha256 on 9 / 376 | The packet file lived in the deleted worktree. **Excluded.** |
| B1 recorded at dispatch | Partly | `fitness_shadow` event before start: 217 / 376. `effort_decision`: 135, of which **93 were recorded after this lease started** (written after the first maker's checks, for the sibling decision). | See leakage L5 below. |

**After the run only (never features):** `exit_status`, `timed_out`, `diff*`, `changed_files`, `deterministic_checks`, `checks_completed_at`, `failure_reason`, `failure`, `graded`, `runtime_usage`, `token_accounting`, `token_efficiency`, `evidence_read_set`, `risk_inputs` (it contains `changed_files_risk_reason`), `superseded_by_maker_lease_id` (123, the evolve selection result), `evolve`, `genome` / `ace_001` / `ste_001` as lease stamps, `checkpoint_after_id`, `completed_at`.

### 1.6 Leakage findings

- **L1.** Lease metadata mixes pre-run and post-run keys with no per-key time. H1 must use an explicit allow-list (§2.2), never "all metadata".
- **L2.** Checks exist only when the runtime exited 0, so L-checks is a **conditional** label: P(checks pass | runtime ok). A predictor trained on it says nothing about the 190 runtime failures and timeouts. L-lease removes this selection.
- **L3.** Genome, ACE and STE are stamped onto the lease after the run. The same facts exist before start in `assignment_context` events.
- **L4.** The `runtime` column and `effective_runtime` / `effective_model` can be rewritten after the run on engine fallback (4 leases).
- **L5. `fitnessPosterior(db, lane, species, now)` does not filter by time.** Rows after `now` get age 0, which is full weight. So a replay at the lease start against today's DB **includes later outcomes, including this lease's own**. The same holds for `speciesOption`, so for the effort-controller posterior. B1 must be recomputed with `skill_outcomes.created_at < started_at` (a filtered in-memory copy), or taken from a `fitness_shadow` event before start. B1 also targets *verified*, not checks-pass.
- **L6.** Goal rows (risk class, objective, acceptance criteria) can be edited with no history. The run-level snapshot (`checkpoint_before`) is the trustworthy as-of state.
- **L7.** The 1,126 synthetic maker rows would swamp any count that does not filter `metadata.synthetic`.
- **L8.** Secondary label: `outcome_attribution` judgments exist for only 145 runs (87 verified, 23 maker, 25 environment, 10 reviewer). An attribution-filtered sensitivity analysis will be small.

## 2. H1 design: a code-only per-lease outcome predictor

### 2.1 Question

Given only facts recorded before a maker lease started, does a pre-registered logistic regression predict the lease outcome better than the trailing per-lane base rate (B0) and the effort-controller posterior (B1)?

No LLM, no jev, no model call. Nothing is written to prod, no flag, no service, no WIP slot (offline replay).

### 2.2 Features (allow-list, as of `started_at`)

There are 9 feature groups, about 20 parameters after one-hot coding. Train has 147 failure events, so about 7 events per parameter. That is low for unpenalised regression, so the model is ridge (L2) with a fixed λ = 1.0 on standardised inputs. λ is never tuned on test.

1. goal lane: exports / test-gap / mutation-gap / doc-drift / other (one-hot)
2. species as dispatched: runtime × model family, with categories under 15 train rows pooled to "other"
3. `goals.risk_class` (low / medium / missing)
4. retry attempt (0 / 1 / 2+)
5. is evolve sibling
6. prior leases on the same target with a known outcome before start: count, and smoothed pass rate (k + 0.5)/(n + 1)
7. earlier makers of the same goal known before start: any passed (0 / 1 / none)
8. `assignment_context` before start: number of examples, number of rules, memory-holdout flag
9. plan present in the `checkpoint_before` snapshot

Excluded:
- every post-run key in §1.5;
- target-file and packet size (not recorded);
- jev or any judgment row;
- the B0 and B1 values themselves (they are baselines, not inputs).

### 2.3 Labels, split and exclusions

- **Primary: L-lease.** Secondary: L-checks, reported as an estimate only.
- **Sensitivity:** L-lease restricted to maker-attributed failures, where an attribution exists.
- **Train:** leases started before 2026-10-05T09:17Z (fixed now).
- **Test:** leases started from the cutoff until the test set reaches n = 357, at which point it is frozen.
- **Exclusions:** synthetic rows, cancelled/prepared, never-ran/denied, exit 0 without checks, tool-missing, and the 4 fallback-rewritten leases. Report the count of each.

### 2.4 Baselines and scoring (reuse forecastScoresV2's statistics, unchanged)

- **B0:** per-lane trailing rate (k + 0.5)/(n + 1), over leases of the same lane whose outcome was known strictly before this lease's `started_at`. This is forecastScoresV2's `trailingRate`, keyed by lane instead of source.
- **B1:** `fitnessPosterior(lane, species).mean_clean`, recomputed on an as-of copy (L5). Reported raw, and after one Platt recalibration fitted on train.
- **Metrics:** Brier, BSS against each baseline, AUC, and paired Brier gain. Each has a seeded cluster bootstrap CI: cluster = goal, B = 2000, mulberry32 seed 20261005, the same code path as `forecastScoresV2`. Also the calibration slope and intercept.
- **decision_grade:** forecastScoresV2's rule unchanged: ≥ 10 positives, n ≥ 100, and a skill CI that excludes 0.
- **Output:** a local JSON file and `docs/research/aw0/H1_RESULT.md`. Never `judgments`.

### 2.5 Decision rule

| Outcome | Condition (test half, against the **better of B0 and B1**) |
|---|---|
| **GO** to prospective shadow (H1b: needs a WIP slot and operator approval) | Paired Brier-gain CI lower bound > 0, decision_grade, and calibration slope in [0.5, 1.5] |
| **ITERATE** | Point gain > 0 but the CI includes 0 |
| **REJECT**, and register a negative-evidence entry | Point BSS ≤ 0 at n ≥ 250 |

Even at GO, the predictor may only **defer, or escalate to a human**. It never approves, merges, promotes or judges risk or fitness (NE-001 scope, `EFFORT_FLOOR`).

### 2.6 n and date

L-lease needs about 238 test leases for 80 % power at AUC 0.70. With the design-effect bound of 1.5, the target is **357**. The test half has 262 today and grows at about 12.1 a day.

## 3. Verdict

**H1 = HOLD until about 2026-11-01. Then GO, with one offline pass on L-lease.**

The trigger is a test-half size of n = 357, not the calendar. If volume falls, the date slips. At design effect 1.3 it would be reached by about 2026-10-28.

**L-checks as a decision label = HOLD.** At current volume (9 a day, test base rate 0.87) it needs about 704–920 test rows, which means about 2026-12-20 to 2027-01-13. Until then it is reported as an estimate only.

The pre-registration (`H1_PROTOCOL.md` + `.sha256`, frozen before any score) can be written now, in a separate PR.
