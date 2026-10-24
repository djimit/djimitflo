# DjimitFlo as a world model: a formal frame on existing records

Purpose: before anyone builds or borrows a "world action model", state precisely what the *world* is for DjimitFlo, which parts of it the existing records observe, and which parts are latent or unknown. Every symbol below maps to a table or field that already exists on origin/main `2a0bff5b` (see [CAPABILITY_INVENTORY.md](CAPABILITY_INVENTORY.md) for paths). Nothing here proposes new tables.

## 1. Decision process

DjimitFlo is a **partially observable, delayed-reward, nonstationary decision process** (a POMDP) with hard governance constraints:

𝓜 = ⟨𝒮, 𝒜, 𝒪, T, Z, R, 𝒞, γ⟩

- 𝒮: world state (repo, work, resources, latent quality). Partly observed.
- 𝒜: control actions DjimitFlo can take (dispatch, retry, split, escalate, merge…).
- 𝒪: observations returned by tools (checks, verdicts, CI, judgments).
- T(s′ | s, a): transition kernel. **Unknown, stochastic, nonstationary.**
- Z(o | s′, a): observation kernel. Deterministic checks are near-deterministic given s′; LLM verdicts are stochastic.
- R: reward. Immediate parts are noisy; delayed parts are censored at 14 days.
- 𝒞: hard constraints that no policy may trade against reward: `EFFORT_FLOOR` (deterministic gates, checker, security checker, scope gate, human merge, auth), approvals, `EXPERIMENT_WIP_LIMIT`, budgets.
- γ: no explicit discount. In practice the horizon is one work item: dispatch → verified → merged → 14-d settled.

The agent never sees s_t. It acts on a history h_t = (o_1, a_1, …, o_t) and, ideally, a belief b_t(s) = P(s_t = s | h_t).

### Mapping to AW-0

AW-0 models p_θ(C, Z, A | 𝒞_t) (code plan, future observation, action, given context).

The DjimitFlo analogue factorises into three separate pieces:

| AW-0 | DjimitFlo analogue | Factor |
|---|---|---|
| C | the plan (skill/playbook choice, planner `plan_json`) | π_plan(c \| h) |
| Z | the predicted next observation | p(o_{t+1} \| h_t, c, a) |
| A | the maker/tool action | π_act(a \| h, c) |

**The missing component is the middle factor**: a predictor of o_{t+1} given the history and the planned action. That is "Z" for us, and the subject of H1 in [EXPERIMENTS.md](EXPERIMENTS.md).

## 2. State S_t: what is observable today

| Component | Symbol | Existing record (table.field) | Observable? |
|---|---|---|---|
| Code base | σ_t | origin/main sha; per-lease worktree (`worker_leases` metadata) | Yes (sha). The full content is observable but high-dimensional. |
| Work state | w_t | `work_items` (status, risk_class, value_score, confidence, recommended_loop, assigned_runtime); `self_improvements` (source, status, fingerprint, evidence_refs_json); `goals` (objective, constraints, acceptance criteria, risk_class, budget_json, metadata.effort_arm); `loop_runs` (status, plan_json, findings_json, gates_json, next_actions_json, metadata.pr_url / failed_gates); `worker_leases` (role, runtime, status, budget_json, metadata.model / genome_id / retry lineage) | Yes |
| Agent configuration | g_t | `maker_genomes`; species = runtime@model on the lease | Yes on the prod lease path. **No** for gym attempts (served model/worker not recorded). |
| Skill/plan library | 𝓛_t | `skill_cards` (record-only); `lane-playbook` output (gym only) | Yes, but no `skill_version` is bound to executions (all NULL). |
| Resources | ρ_t | budgets on goals and leases; `fleet_hosts` heartbeats; gym caps (env); token usage (`runtime_usage`) | Partly. kWh coverage is about 38 %, € partial. |
| Experiment arm | e_t | `experiment-registry` defs; goal metadata.effort_arm; memory holdout | Yes |
| Latent quality | q_t | none (see §3) | **No** |

## 3. Latent and unknown state

| Latent variable | Why it matters | Best existing proxy | Proxy quality |
|---|---|---|---|
| True correctness of a change | Reward is about this, not about passing checks | checker verdict; deterministic checks; settlement re-execution | Checker AUC 0.95 offline, κ(checker, outcome) 0.318 |
| Test fault-detection strength | Passing weak tests says little | graded mutant kill (k = 3); Stryker held-out kill (offline) | k = 3 kill reliability ≈ 0.50 (CE-003 B) |
| Environment/infra health | 38.8–48.6 % of non-verified outcomes are `environment_failure` | outcome_attribution class; `stderr_class`; `maker_runtime_exit_zero` signature (120×) | Attribution is post hoc. `runtime_signal` is null on all 216 failed makers. |
| Maker internal trajectory | Explains *why* a lease failed | stdout/stderr files on VPS disk | Not in DB; retention UNKNOWN |
| Assignment packet content | Actual input to the maker | the packet is written to the worktree | sha not stored, so integrity is unobservable |
| Reviewer/operator intent | Determines merge vs reject | human merge events; manual_attestation | Sparse |
| Flakiness of a check | Same state, different observation | FRR (repeated-failure rate) 0.4065 [0.353, 0.462], n = 310 | Aggregate only, not per check |
| Capability gain | The thing self-improvement is for | provenance DAG capability node | "not measured" |
| Origin of a proposal | Credit assignment upstream | provenance edges | discovery → proposal `not_linked` (0 of 9,126) |

**Unknown (not even proxied):** how stable T is over time (model and provider updates, dependency drift), and the joint distribution of failures across concurrent leases (shared GPU contention, plan line 331).

## 4. Actions A_t

| Action | Record that logs it | Reversibility |
|---|---|---|
| Dispatch maker (runtime, model, genome, packet) | `worker_leases` role maker; `loop_runs` | Reversible (worktree) |
| Dispatch checker / security checker | `worker_leases` roles | Reversible |
| Retry (operator: plain, strengthen-assertions, etc.) | `retryLoopRun`; lease `retry_of` / `retry_attempt` | Reversible, costs budget |
| Split finding / continue / sibling | `loop_events` (`finding_split`), evolve-selection | Reversible |
| Escalate | `escalateIfFailureThresholdExceeded` | — |
| Judgment run/skip | `effort_decision` events (shadow) | — |
| Remote maker job | `remote_maker_jobs` (no lease_id/run_id) | Reversible; provenance gap |
| Merge (auto test-only / human) | loop-auto-merge; PR metadata | **Effectively irreversible** (revert is a new action) |
| Gym claim / attempt | gym tables, `gym_attempt_diffs` | Sandboxed |

The maker's *internal* actions (individual tool calls and edits) are not logged as rows on the loop path. For DjimitFlo the action granularity that is observable and decision-relevant is **the lease**, not the token or the tool call. This differs from AW-0, whose actions are 32-step chunks at 30 Hz.

## 5. Observations O_t

| Observation | Record | Latency | Noise |
|---|---|---|---|
| Deterministic check exit codes | `worker_leases.metadata.deterministic_checks` (hidden shadow checks removed by `withoutHiddenChecks`) | Minutes | Low, but includes flakiness |
| Runtime signals | `runtime_signal`, `runtime_timed_out`, `exit_code`, `stderr_class`, `runtime_usage` | Minutes | `runtime_signal` mostly null |
| Checker verdict | `CheckerVerdictInput` (accepted / needs_revision / rejected / insufficient_evidence) | Minutes | LLM-stochastic |
| Gates | `loop_runs.gates_json`, `metadata.failed_gates` | Minutes | Low |
| CI / PR state | GitHub API (GET) via merge-survival | Hours | Low |
| Judgments | `judgments` (graded, FBPA shadow, outcome_attribution, settlement_execution, merge_survival_poll, forecasts, commons) | Minutes to 14 d | Varies |
| Skill outcomes | `skill_outcomes` (success, tokens, duration, domain prod/gym/merge/fleet) | Minutes to 14 d | `skill_version` NULL |

## 6. Reward R_t

The reward is a vector, not a scalar. Hard constraints 𝒞 apply first.

| Component | Signal | Delay | Valid as learning label? |
|---|---|---|---|
| r_verified | `self_improvements.status = verified` (gates + checker accept) | Minutes to hours | **Noisy.** About 44 % of non-verified outcomes are non-maker failures. Use only with an attribution filter. |
| r_checks | all deterministic checks exit 0 | Minutes | **Yes**: deterministic, immediate |
| r_checker | checker `accepted` | Minutes | Yes, within its construct (AUC 0.95) |
| r_kill | held-out Stryker / fresh-mutant kill (offline harness) | Hours (offline) | Yes for test-writing leases (STR-001 design) |
| r_survival | 14-d merge survival | 14 d, right-censored | **No**: 22 survived / 0 regressed; it "cannot fail" (CE-003) |
| r_settle | settlement re-execution at +14 d | 14 d | Shadow; 22/22 pass so far, same ceiling concern |
| −c_tok, −c_kWh, −c_€ | `runtime_usage`, energy telemetry | Immediate | Partial coverage |

**Delayed outcomes.** For an item dispatched at t, r_survival resolves at t + 14 d or later (53–56 items were pending on 21–24-10). Any learning or scoring on delayed labels must treat unresolved items as **right-censored**, not as failures or successes. It must join outcomes through provenance `evidence_ref` edges, never by timestamp proximity. Because r_survival has shown no variance so far, it has no information content for a predictor today. Predictors should be scored on r_checks, with r_checker as secondary.

## 7. Transition kernel T and nondeterminism

T(s′ | s, a) is unknown. It has four properties a model must respect:

1. **Stochastic given the observable state.** The same packet sent to the same runtime@model can produce different diffs (LLM sampling, provider routing). FRR 0.4065 shows repeated failure is common but not certain.
2. **Tool nondeterminism.** Llama-router GPU contention (gym vs offline experiments, plan line 331), CI load flakes, and timeouts. The same diff can produce different o.
3. **Nonstationary.** Models, prompts, dependencies and the repo change weekly. AW-0's own degradation from 80.8 % (clean) to 20.6 % (randomised) shows how sharply a learned dynamics model degrades under distribution shift. Every predictor must be scored on a **trailing, temporally later** window (V2's trailing base rate already does this).
4. **Partly controllable by cheap pre-flight execution.** For the environment-failure share, s′ is largely determined by whether the base commit builds and tests on the target host *before* the maker acts. That component of T can be **observed by execution** (a sandbox run), not predicted. This is the "simulator baseline" in FEASIBILITY.

## 8. What a DjimitFlo "transition predictor" is, precisely

Given the history h_t up to lease dispatch (work item, goal, lane, runtime@model, genome, planner `plan_json`, target files, retry lineage, and recent base rates), all stamped with `as_of` < lease start (DI-001), predict:

  p̂ = P(o_{t+1} = "all deterministic checks pass" | h_t, c_t, a_t)

and optionally P(checker = accepted | …). The predictor is scored by Brier score against the realised o_{t+1} with forecastScoresV2's statistics. It must beat:

- the trailing per-lane base rate, and
- the effort-controller posterior P(success | lane, species).

Both already exist; see EXPERIMENTS H1.

This predictor is **observation prediction, not state prediction**. It never claims to know q_t. It only claims calibrated foresight over the next observable signal. That is the most that ≈ 192 completed maker leases per month can support.

## 9. Findings

| # | CLAIM | SOURCE | VERIFIED EVIDENCE | UNCERTAINTY | DJIMIT RELEVANCE | EXPERIMENT | RESULT | DECISION |
|---|---|---|---|---|---|---|---|---|
| W1 | The decision-relevant, observable action unit is the lease, not the tool call | worker_leases schema (migrate.ts:811, :1581); loop path stores no per-step rows | No maker tool-call rows on the loop path; only stdout files (CAPABILITY_INVENTORY I9) | stdout retention UNKNOWN | Rules out step-level world models (AW-0-style chunks) on current data | H0 census | Not run | Model at lease granularity |
| W2 | Executed checks are the only immediate, low-noise, varying label | §6; outcome_attribution shares; survival 22/0 | verified is noisy (about 44 % of non-verified outcomes are non-maker); survival has no variance | Per-check flakiness unknown | Primary label for any transition predictor | H1 | Not run | Use r_checks; r_checker secondary |
| W3 | 14-d outcomes are right-censored and currently uninformative | merge-survival.ts:21; L3-v2; CE-003 | 53–56 pending; 0 regressions observed | Could gain variance as volume grows | Exclude from predictor labels; treat pending items as censored | — | — | Exclude |
| W4 | T is stochastic and nonstationary; an environment-health share is observable by execution | FRR 0.4065; attribution environment 38.8–48.6 %; plan line 331 | Repeat failures common; contention observed | Exact share a pre-flight would catch is unknown | Pre-flight execution is the B3 baseline | H1 (B3) | Not run | Score on later windows; keep B3 |
| W5 | The missing world-model factor is p(o_{t+1} \| h_t, c, a), observation prediction, not state prediction | §1, §8; CAPABILITY_INVENTORY I7 | No per-lease forecaster exists | — | Defines H1 precisely | H1 | Not run | GO (offline) |
