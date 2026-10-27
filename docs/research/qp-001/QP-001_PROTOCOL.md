# QP-001 — does the maker's learned context stack earn its place? (quality-preserving comparison, pre-registration)

Status: **pre-registered, frozen in the PR that adds this file** (2026-10-27). Nothing has been executed: no runner, no
manifest, no attempt, no flag, no production write. This is preparation, not results. QP-001 starts only after PL-001 has
read out, never at the same time as PL-001, and only on an operator decision (see Start condition).

Source: forensic audit 2026-10-26, roadmap rank 10 (`22_EXECUTION_ROADMAP.md`: "quality-preserving comparisons; prune
complexity that does not render"), finding **L-F03** (skill promotion uses unmatched all-time cohorts and point estimates)
and the common contract plus E1–E3 of `23_EXPERIMENT_PROTOCOLS.md`. All file:line references are to `origin/main` at
`e9278a3e`.

## 1. The comparison, and why this one

**Current maker setup:** a production maker gets `LOOP_WORK.md` from `renderWorkAssignment` (loop-service.ts:317-349). Besides
the task (file, finding, evidence, suggested fix) and the fixed maker policy template, it carries three learned, retrieved
blocks — the **context stack**:

| Block | Source | Rendered at |
|---|---|---|
| Advisory Past Experience | `retrieveLocalRelevantRuns(loop_name + message + suggested fix, 3)` (loop-service.ts:2425-2429) | loop-service.ts:339 |
| Proven Examples | verified test-gap artifacts, `LOOP_SKILL_CARDS_ENABLED` (assignment-context.ts:52-56) | assignment-context.ts:127 |
| Engineering Rules | promoted memory rules, up to 3, `LOOP_MEMORY_RULES_ENABLED` (assignment-context.ts:83-112) | assignment-context.ts:128 |

**Matched simpler baseline:** the same assignment, rendered by the same function from the same finding, with the same ids
lines and the same policy template, **without the three blocks**. Same worker, species, model, step budget, timeout, tools,
delivery path and oracle. The only difference between the arms is the context stack.

**Why this comparison** (candidates from the audit protocols, one chosen):

- **Chosen — the context stack as one bundle (E1 + E2 at bundle level).** It is the largest learned complexity that reaches
  every production maker (rules were read in 121 of 122 maker runs, assignment-context.ts:28), it is maintained by its own
  pipelines (memory promotion, retrieval, skill cards), and no controlled readout shows it helps (plan, Phase G: "memory and
  knowledge show no measured effect"; learning ledger 0/11 loops closed). The only paired evidence is TG-001, which pointed
  the other way but proved nothing: minimal gym goal 14/19 vs full production assignment 11/20, A − B +0.158, Tango 95 % CI
  [−0.128, 0.422], 19 of 20 tasks previously exposed, write_test only. TG-001 never isolated the stack: its arm C removed ids,
  advisory and policy together and kept rules and examples. A bundle verdict answers the operator's KEEP/SIMPLIFY question
  in one experiment under the WIP limit (G1.5). Per-component ablations are only worth their cost after a KEEP.
- Not chosen — step budget 40 vs 60 (TG-001's named next experiment): it changes the budget, so it is not a matched-budget
  comparison; it needs its own pre-registration.
- Not chosen — committee or swarm vs single agent (E3): the current maker is a single agent; a committee arm would test added
  complexity, not the existing setup.
- Not chosen — memory rules alone (E2): the production memory holdout already randomises that factor (readout 27-10); a second
  runner for the same factor duplicates it (audit E1: "no second runner").
- Not chosen — instruction lines (E1): PL-001 and PL-002 cover them.
- Not chosen — router vs a fixed model: violates "same model".

**Hypotheses** (d = p_C − p_S, the paired difference in gated verified completion, arm C minus arm S):

- **H-KEEP (superiority of the current setup):** H0 d ≤ 0 against H1 d > 0, one-sided α 0.025.
- **H-SIMPLIFY (non-inferiority of the baseline):** H0 d ≥ Δ against H1 d < Δ, one-sided α 0.025, margin **Δ = 0.10**
  (10 points of gated verified completion).

Both are read from one two-sided 95 % interval; KEEP takes precedence, so the verdicts exclude each other. Testing
superiority and non-inferiority from the same interval needs no multiplicity correction (interval-inclusion principle,
CPMP/EWP/482/99).

**Relation to L-F03:** QP-001 produces the matched-cohort evidence that `assertSkillPromotionEvidence`
(swarm-intelligence-service.ts:520-568) lacks — frozen comparable tasks, one evaluator, one model, one harness, an interval
instead of a point estimate. It does not change promotion code; that fix is separate.

## 2. Arms

| Arm | Prompt (rendered once at freeze, stored verbatim) |
|---|---|
| C — current | `renderWorkAssignment(run, finding, 'remote', advisory, ctx)` with production's control context: `assignmentContext` run inside a rolled-back transaction with `ACE_001_MODE=off`, `STE_001_MODE=off`, `MEMORY_HOLDOUT_RATE=0`, and `LOOP_MEMORY_RULES_ENABLED` / `LOOP_SKILL_CARDS_ENABLED` as production has them at freeze (recorded); advisory from the production retrieval call. This is the TG-001 `productionArms` pattern (tg-001.ts:105-126). |
| S — simpler | `renderWorkAssignment(run, finding, 'remote', '', { examples: [], rules: [] }, { omit: ['advisory'] })`: the same run, finding, ids lines and policy template; no Advisory, no Proven Examples, no Engineering Rules. |

- **Same for both arms:** worker host and worker version (`scripts/gym-worker.mjs` sha256), runner image digest, species
  atomic@llama-router, the router model (recorded per attempt), `--max-steps 40` (gym-worker.mjs:593), `GYM_MAKER_TIMEOUT_MS`,
  tools, delivery through `prompt_override` flattened by `oneLine` (gym-worker.mjs:119), a fresh atomic state per attempt
  (EV1, gym-worker.mjs:45), the oracle, mutant kills, production gates and hack classifier.
- **Finding per task kind:** a failure-derived `write_test` task uses the real production run and finding it came from (as
  TG-001). A repair task has no production finding; it gets one frozen adapter finding with the same information as its gym
  goal and nothing more: file = `task.source`; message = the named failing tests; evidence = the test names only (no test
  output); suggested fix = "change only `task.source` so that the named tests pass; do not edit the tests"; loop name
  `doc-drift-and-small-fix-loop` (production's small-fix lane, used for the header and the advisory query). The adapter is the
  same in both arms, so it cannot create a difference between them.
- **Eligibility (treatment must exist):** a task is eligible only if arm C's stack is non-empty (≥ 1 retrieved advisory
  episode, rule or example). Otherwise C and S differ by nothing, and the task is excluded before the freeze and counted.
- **Arm order:** per task, C runs first when the first byte of `sha256('qp-001:20261026:' + task_key)` is even, else S first
  (seed 20261026, the audit's proposed pre-registration seed).
- **Delivery proof:** the manifest stores, per task and arm, the prompt and `goal_sha256 = sha256(oneLine(prompt) + '\n')`.
  The worker's `fire_check.goal_sha256` (gym-worker.mjs:87-90) must equal it. For arm C the stack lines must all be found in
  the sent input; for arm S none of them. Anything else is VOID and re-served.

## 3. Data: a versioned task set, frozen before any attempt

- **Kinds:** TypeScript repair tasks on `packages/server/src/services/**/*.ts` (seeded mutants at tiers 3–6 from the deploy
  checkout, mined repairs when available) and failure-derived `write_test` tasks whose production run and finding still
  exist. Excluded paths: `**/__tests__/**`, `**/*.test.ts`, `**/*.d.ts`, `**/*.generated.ts`. At most 2 tasks per source file.
  Kind is recorded and never rebalanced after the freeze.
- **Disjoint from:** the PL-001 manifest and every key with a `pl-001` run; the PL-002 manifest and every key with a
  `pl-002` run; the epoch-1 holdout and every other holdout key of any table and epoch (`gym_holdout`,
  `gym_mutant_holdout`, `gym_write_test_holdout`); every TG-001 key (`tg_attempts`, `tg_experiments`); every trial-attempted or
  dream-exposed key (`holdoutExclusions`); every key with an earlier `evolution-gym` attempt; canaries.
- **Size:** 180 tasks (150 pairs plus a margin of 30 for INVALID tasks), served in order of `sha256('qp-001:20261026:' +
  task_key)`. Fewer than 180 eligible tasks → nothing is frozen and the shortfall is recorded.
- **Manifest (immutable, sha256 stored at freeze):** task keys, kind, base commit, task bytes (mutant content, test list) and
  their sha256, the finding, both prompts and their goal digests, the stack content per task (advisory episode ids, rule ids
  and hashes, example paths), the production flags read at freeze, worker sha256, runner image digest, oracle and gate config,
  hack classifier version, the arm-order seed, and this protocol's PREREG_SHA256. The freeze is the operator's.
- Frozen tasks are reserved: never served as ordinary gym work and never frozen into a later holdout.

## 4. Isolation

- Own loop name `loop_runs.loop_name = 'qp-001'`; gym statistics, breaker, IRT, hack rate, graded pool, trial deciding sets,
  dream inputs and the bandit read `evolution-gym` only (the TG-001 provenance pattern).
- Rendering arm C writes nothing: rule sealing and memory-read logging run in a rolled-back transaction. No `skill_outcomes`
  row, no memory or knowledge write, no `maker_genomes` row, no dream input from any QP-001 attempt.
- No production maker, production flag or production prompt changes. QP-001 is gym-only.

## 5. Scoring: independent, with the production-gated oracle

- **Gated verified completion** = `gym_result.status = 'success'` on a claim with production gates, carrying the per-check
  `prod_gates` map (`ELIGIBLE_GATED`: `test:changed`, `lint`, `type-check`, diff limit), not VOID, not quarantined. Repair: the
  named tests green, source file only. `write_test`: green on the real target and red on ≥ 1 seeded mutant.
- A success without changed files and a diff is an infra discard. A success the hack classifier flags is quarantined: not
  verified, and it counts toward the harm rules.
- The scorer is independent of the maker and blind to the arm: the oracle, gates and classifier are deterministic functions of
  task and diff, never of the prompt; no LLM judge, no checker, no human label decides an outcome. Neither arm can change the
  evaluator.

## 6. Outcomes

**Primary endpoint:** gated verified completion per task and arm, paired by task, intention to treat (an INFRA_CENSORED arm
counts as not verified).

**Secondary** (descriptive; no claims; unknown is never 0 — it is counted apart, excluded from rates, with coverage per arm):

- **Functional survival** (§7) and survival-adjusted completion (verified and survived).
- Safety and scope: `out of scope` results, `prod_gate_failed:*` by check, hack flags (`tests_touched`,
  `ci_or_config_touched`, `readme_only`, `assertion_removed`, `skip_or_only_added`), canaries.
- Failure categories (`classifyTgFailure`, tg-001.ts:323), graded score, diff lines.
- Cost and time (§8), prompt size in characters (exact for both arms).
- Order effect: completion by execution position (first or second arm on a task).

## 7. Functional survival

After the last attempt, every gated verified success is replayed once, oracle-only (no maker): its stored diff is applied to
the frozen base in a fresh runner from the frozen image, and the same oracle, mutant kills and production gates run again.
A success that verifies again **survived**; one that does not is a **non-survivor** (flaky or environment-dependent). The
replay is a second, independent execution; it cannot turn a failure into a success. Replay infra discards retry at most 2
times, then the survival of that success is unknown, not assumed. The runner stores each verified diff on the `qp-001` run so
it can be replayed. Production 14-day survival is out of scope: nothing from QP-001 merges.

## 8. Total cost of ownership

Per arm, over **all physical attempts** (verified, failed, infra, VOID and censored):

- tokens (the maker's printed total; coverage = share of attempts with a total), maker wall time (`maker_ms`), runner wall
  time from claim to result, replay time;
- **cost of failed work** apart: tokens and time spent on attempts that did not end verified;
- cost per gated verified completion = all tokens (and all maker time) of the arm ÷ its verified count; null with 0 verified;
- paired differences in maker time and tokens with a paired task bootstrap 95 % CI (10 000 resamples, seed 20261026) on the
  tasks where both values are known; descriptive.

**Unknown stays unknown** (reported as unknown, never 0 or estimated): tool calls (atomic prints none), files inspected, input
tokens of the prompt unless the maker prints them, GPU Wh (no sampler on the gym), € per verified completion (workstation kWh
price not in the ledger), the render cost of arm C, and the maintenance cost of the stack's pipelines (memory promotion,
retrieval, skill cards). A SIMPLIFY or KEEP verdict is a quality verdict; it does not claim a € saving.

## 9. Missing data and infra

An infra discard (`infra:` reason, discarded, lost or orphaned run) or a VOID attempt re-serves the arm, at most 2 retries (3
physical attempts). The first non-infra, non-VOID result is the observation. After 3 the arm is **INFRA_CENSORED**: not
verified in the primary analysis, its pair dropped in the sensitivity analysis. A `task:` discard (for example the test is
already green at base, or the mutant survives) makes the task **INVALID** for both arms: its other arm is not served, it is
excluded from the pairs and reported. **Every physical attempt is kept**, failed and inconclusive ones included, and appears in
the readout.

## 10. Analysis and decision rule

- Pairs: n complete pairs; b = tasks where C is verified and S is not; c = tasks where S is verified and C is not.
- Interval: Tango score 95 % interval for d = (b − c)/n (`tangoInterval`, tg-001.ts:369), unrounded. Exact two-sided McNemar
  p (`mcnemarExact`, tg-001.ts:355) is reported, not used for the verdict.
- Analysis set: the first 150 complete pairs by completion time. If the run ends by date (§12) with 100–149 complete pairs, the
  same rules apply to those pairs (a calendar stop does not depend on the data); with fewer than 100 the verdict is
  INCONCLUSIVE.

| Verdict | Rule (all on the primary interval [L, U]) | What follows (each an operator decision; nothing is automatic) |
|---|---|---|
| **KEEP** | L > 0, and arm C has at most 2 more non-survivors than arm S | The stack stays: it earns its place under the gym harness. Next, only if wanted: per-block ablation under a new pre-registration. A KEEP is not a licence to grow the stack. |
| **SIMPLIFY** | not KEEP; U < 0.10; arm S has at most 2 more non-survivors and at most 2 more out-of-scope or hack-flagged results than arm C | The data rule out a loss of 10 points or more from removing the stack (smaller losses are not ruled out). Proposal: stop delivering the stack to production makers, confirmed first by a production holdout under its own pre-registration (gym → production transfer is unproven, TG-001), with a permanent 10 % holdout (G3.2); freeze growth of the stack's pipelines (G3.3). Retire nothing before its consumers and rollback are shown (audit 20). |
| **INCONCLUSIVE** | neither of the above, or < 100 pairs | No change. Not a win and not a proven no-effect. No re-run until significant; a new attempt needs a new pre-registration and new tasks. |
| **STOPPED_FOR_HARM** | a harm rule fired (§11) | As named in §11. |

- **Sensitivity** (descriptive): the same interval on pairs with no censored arm; by kind (repair, `write_test`); a cluster
  bootstrap by source file (seed 20261026); survival-adjusted completion.
- If the sensitivity analysis on uncensored pairs would give a different verdict, the primary verdict stands and the
  difference is reported.

## 11. Stop rules

- Stop at 150 complete pairs or at day 28 after the first attempt, whichever comes first.
- **Early stop for harm only**, checked after every complete pair. The change under test is simplification, so harm is harm
  from arm S:
  1. the e-value for "C beats S" over the discordant pairs (`ePaired`, paired-stats.ts:28, C-only coded +1) reaches 20 →
     STOPPED_FOR_HARM (simplification harmful) → decision as KEEP;
  2. arm S has 3 or more out-of-scope or hack-flagged results more than arm C → STOPPED_FOR_HARM (scope harm) → decision as
     KEEP;
  3. any canary is solved since the first attempt → STOPPED_FOR_HARM (oracle compromised) → INCONCLUSIVE, results unusable
     until the oracle is repaired.
- **Never** an early stop for SIMPLIFY, for success or for futility. No interim look at the interval.
- A change during the run to the worker, runner image, router model, step budget, oracle, gates, classifier or the frozen
  prompts stops the run as INCONCLUSIVE and is recorded as an amendment.

## 12. Sample size and power

- **Base rates** (`~/.claude/plans/eventual-brewing-cray.md`): gated pass 34/91 = 0.37 since 10-08; epoch-1 parent 18/39 = 0.46
  on mutant tasks; mutant tiers 3–6 gated 0.35–0.39. TG-001 (`write_test`, prod gates, exposed tasks): minimal 14/19, full
  production 11/20, discordance 7/19 = 0.37. Planning range for arm S 0.37–0.46; discordance ψ 0.30–0.44 (as PL-002). The
  interval depends only on (b, c, n), so the decision probabilities depend only on ψ and d. TG-001 is a planning input, not a
  prior.
- **Exact decision probabilities** at n = 150 pairs, Δ 0.10, full enumeration of the paired trinomial (computed for this
  protocol):

  | ψ | d −0.10 | d −0.05 | d 0 | d +0.05 | d +0.10 | d +0.15 |
  |---|---|---|---|---|---|---|
  | 0.30 | SIMPLIFY 0.995 | SIMPLIFY 0.917 | SIMPLIFY 0.603 · KEEP 0.025 | KEEP 0.198 · SIMPLIFY 0.199 | KEEP 0.617 · SIMPLIFY 0.025 | KEEP 0.936 |
  | 0.36 | SIMPLIFY 0.984 | SIMPLIFY 0.863 | SIMPLIFY 0.527 · KEEP 0.025 | KEEP 0.171 · SIMPLIFY 0.172 | KEEP 0.536 · SIMPLIFY 0.025 | KEEP 0.880 |
  | 0.44 | SIMPLIFY 0.960 | SIMPLIFY 0.790 | SIMPLIFY 0.453 · KEEP 0.025 | KEEP 0.149 · SIMPLIFY 0.150 | KEEP 0.458 · SIMPLIFY 0.025 | KEEP 0.803 |

  Error rates hold: false SIMPLIFY at a true 10-point loss is 0.025; false KEEP at a neutral stack is 0.025.
- **With the harm stop** (Monte Carlo, 20 000 runs per cell, mulberry32 seed 20261026): at d 0 the harm stop fires 0.023–0.028
  and KEEP-or-harm totals 0.038–0.044 (bound 0.025 + 0.05 by Ville's inequality); SIMPLIFY 0.447–0.603 (unchanged). At d +0.10
  KEEP-or-harm is 0.49–0.64 and SIMPLIFY 0.023–0.026; at d +0.15 KEEP-or-harm is 0.82–0.94.
- **n = 150 complete pairs, because:** a stack worth +15 points gives KEEP with power 0.80–0.94; a stack that costs 5 points
  gives SIMPLIFY with power 0.79–0.92; a stack worth 10 points is wrongly simplified at most 2.5 % of the time.
  **Limitation:** if the stack is exactly neutral, SIMPLIFY has power 0.45–0.60 only; INCONCLUSIVE is then likely. n = 200
  would raise that to 0.57–0.72 for about 6 more days at 20 claims a day; not chosen because the cap is shared with trials
  and PL-002. A tighter margin (5 points) would need about 1 100 pairs (ψ 0.36, power 0.8 at d 0).
- **Volume:** about 340 maker claims (300 observations plus about 12 % infra) and about 120 oracle-only replays — about 17
  days at 20 claims a day, about 9 days at 40.

## 13. Start condition

- QP-001 starts **only after PL-001 has read out** (a recorded PL-001 verdict, or an operator close), and **never at the same
  time as PL-001**: both draw from the same rolling remote gym cap (stall-watch.ts counts every remote claim regardless of loop
  name), and PL-001's final manifest is needed for the disjointness rule. Not at the same time as PL-002 either, unless the
  operator splits the cap explicitly; the order of QP-001 and PL-002 is the operator's.
- Whatever PL-001 decides is held constant: a change it causes to the gym or production surface is in both arms or in
  neither, and is recorded in the manifest.
- **Gym capacity per operator decision:** a cap share (default 0) and a WIP slot under the experiment limit (G1.5).
- It also needs: the QP-001 runner (a separate PR: flag `QP_001_MODE=off|on`, default off; loop name; manifest freeze;
  rendering both arms; goal-digest and stack-line checks; diff storage for the replay; `maker_ms` and tokens on its claims),
  the workstation worker reinstalled from `main`, and the operator's freeze. Building the runner, freezing, the flag in
  `runtime.env` with a backup, the cap share and the GPU budget are all operator decisions.

## 14. Kept separate

QP-001 tests the context stack only. The policy template, the ids lines, the task information, instruction lines (PL-001,
PL-002), step budget, model routing and the evaluator are held fixed. Whether the gym result transfers to production is not
tested here.

## 15. Rollback

The runner's flag goes off; claims are then byte-identical to claims without QP-001.

## Amendments

Amendments are appended below the fingerprint line, dated, with a reason. They never change the text above it.

---
PREREG_SHA256: 60428ab207008ba6b6fa5f2b743c435cee24cc46cdb2fc601aa3ac5b534f2e11 (sha256 of everything above this line; computed 2026-10-27 before any QP-001 runner, manifest or attempt existed)
