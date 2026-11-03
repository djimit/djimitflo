# CAUSAL-EVOLUTION-003 · H · Scientific verdict

Conventions and source keys: `A_MECHANISM.md`. Evidence: files A, B, C, D, E, G in this directory, plus the referenced
PRs. Snapshot: prod `5dfc6cdb` = `origin/main`, probes 2026-10-22 20:19–20:23Z.

**One-paragraph verdict.**
- Djimitflo does not currently show cumulative, causally attributable, retained improvement in agent capability, and
  its architecture cannot yet produce it.
- No carrier combines fitness-based selection, inheritance into production, and more than one generation (**VERIFIED**).
- The genome loop has run 18 single-generation trials against a fixed parent. Treatment delivery is unverified for all
  of them, and they were scored where the parent had no headroom (**VERIFIED**).
- The only accumulating carriers are memory rules and merged tests. Neither is selected on outcome (**VERIFIED**).
- The most promising lever is not evolutionary: a generic "strengthen the assertions" retry, +0.317 [0.217, 0.425]
  held-out kill, post hoc (**SUPPORTED**). The pre-registered STR-001 Stage A (#966) is the smallest test that can
  falsify it.
- Fitness measurement is the binding constraint, more than variation is. The verified label is structurally blind to
  fault detection, and a k = 3 kill share has reliability ≈ 0.5 (**VERIFIED** / **SUPPORTED**).
- No jev decision has shown positive expected utility (**VERIFIED**).

---

## The ten questions

### 1. Is cumulative evolution currently observable?

**No.**

| Claim | Tag | Evidence |
|---|---|---|
| Not observable: L4 = 0, loops closed 0 of 11, 0 genome promotions, 0 lineages beyond generation 1 (18/18 dream genomes have parent `baseline`) | **VERIFIED** | P2, P4, AN A1 |
| Not *possible* in the current wiring: no prod injection of genome lines (`loop-daemon.ts:617-626`), and the only prod-inherited learned carrier (memory rules) is selected by panel approval, not outcome | **VERIFIED** | A §2, §3 |
| Pooled effect of the 10 settled mutations on paired pass: −0.009, 95 % CI [−0.036, +0.017] | **SUPPORTED** (descriptive) | A §4 |
| "Djimitflo cannot evolve" | **UNKNOWN**. Not falsified: the trials were underpowered, saturated, and delivery was unverified | A §5 |

### 2. Which causal mechanisms are missing?

| Missing link | Tag | Evidence |
|---|---|---|
| Inheritance into production (genome injection) | **VERIFIED** missing | `loop-daemon.ts:617-626`; `GENOME_APPLY_MODE` unset |
| Multi-generation lineage: a promoted parent producing children | **VERIFIED** missing | 0 promotions; parent always `baseline` |
| Verified treatment delivery for settled trials (fire check off: 0/339 attempts with evidence) | **VERIFIED** missing (now on) | P7 |
| A selection endpoint with headroom and reliability (binary saturated at epoch 0; k = 3 kill r ≈ 0.50) | **VERIFIED** / **SUPPORTED** | A §4, B §2.5 |
| A pinned evaluation contract (served model + worker hash per gym attempt) | **VERIFIED** missing | EVO GENOTYPE §4 |
| A noise floor (A/A) for gym trials | **VERIFIED** missing | A §5 C5 |
| Outcome-based selection of memory rules | **VERIFIED** missing (panel consensus) | `memory-candidate-review-scheduler.ts:21-22` |
| A retention signal that can fail (settlement paired with maker-time) and a link from retention to later capability | **VERIFIED** missing | P4: 0 pairs; `capability_gain` not measured |

### 3. Which fitness metrics are invalid or insufficient?

| Metric | Verdict | Tag |
|---|---|---|
| verified label (as test-strength fitness) | **invalid**: no step on the verified path runs the test against faulty code; Δ graded +0.014 [−0.215, +0.231] at n 50 vs 7 | VERIFIED |
| `test:mutation:grounded` outside the mutation lane | **mislabelled**: a no-op recorded as `pass` (57/57) | VERIFIED |
| merge survival (14 d line retention) | **invalid** as a learning label: cannot fail (22/0) | VERIFIED |
| assertion-strength at threshold 0.5 | **non-discriminating**: 54/54 pass, incl. 21 zero-kill tests | VERIFIED |
| graded kill at k = 3 | **insufficient**: reliability 0.50 [0.21, 0.74]; prod set vs fresh r 0.12 [−0.16, 0.41] | SUPPORTED |
| gym proxy pass | **invalid for prod**: 0.867 vs 0.311 (mined) | VERIFIED |
| binary gym pass at epoch 0 | **insufficient**: no headroom (6/16 trials no_headroom; power 0) | VERIFIED |
| panel / committee verdicts as fitness | **insufficient**: Brier 0.33; 0/20 decision-grade | VERIFIED |
| bandit success rate | **insufficient**: inherits the verified label; no effect estimate | VERIFIED |
| hack detector | **untested sensitivity** (0 flagged, no planted hack) | UNKNOWN |
| Valid as measured: executed gates (execution), LLM checker (gross defects, AUC 0.95), security checker (AUC 0.975), held-out fresh-mutant harness (discriminated MFR arms) | valid within their construct | VERIFIED |

Full matrix: `fitness-validity-matrix.json`.

### 4. Does genome inheritance have a defensible causal hypothesis?

**As a hypothesis to test offline: yes. As a basis for production inheritance: no.**

| Claim | Tag | Evidence |
|---|---|---|
| A causal pathway exists in code (lines → gym maker prompt, fire-checkable → behaviour → oracle) | **VERIFIED** | A §2.2 |
| Prompt text *can* move test-writing behaviour on an endpoint with headroom (MFR: −0.142 [−0.250, −0.033] feedback vs strengthen) | **VERIFIED** (registered) | MFR |
| Selected, inherited genome lines improve held-out performance more than random inheritance or independent regeneration | **HYPOTHESIS**: never tested; 0 generations | D §1 |
| Production inheritance justified now | **No.** All 8 gates in D §8 are unmet | VERIFIED |

### 5. Is assertion-strengthening a superior optimization operator?

**Provisionally yes against the alternatives measured so far. Not yet confirmed.**

| Comparison | Estimate | Tag |
|---|---|---|
| strengthen retry vs no retry (held-out kill, one family) | +0.317 [0.217, 0.425]; 23 better / 0 worse / 17 equal | **SUPPORTED** (post hoc, MFR-RA) |
| strengthen retry vs mutant-feedback retry | +0.142 [0.033, 0.250] in favour of strengthening | **VERIFIED** (registered; NE-013) |
| strengthen retry vs genome mutation (return per GPU-h) | ≈ +2.1 kill-share points per GPU-h vs 0 measured | **SUPPORTED** (G §4) |
| strengthen retry vs a compute-matched fresh attempt | not measured | **UNKNOWN** (STR-001 Stage B, R2 arm) |
| holds on an independent mutant family (Stryker) | pending #966 | **UNKNOWN** |
| gain not explained by size (+194 lines median) | pending #966 size control | **UNKNOWN** |

### 6. Which jev decisions have demonstrated positive expected utility?

**None.**

| Claim | Tag | Evidence |
|---|---|---|
| 0 of 10 jev judgments shows an improved outcome; the one acting path (`kb_passage_relevance`, enforce) is unlabelled and its outcome link is not estimable (31/38 `no` rows vs 5/132 `yes` rows join a proposal) | **VERIFIED** | E §1, P5 |
| Paths that change no decision have EU = −cost at any accuracy. Three of them (`checker_second_opinion`, `risk_atomic`, `decision_context`) use ≈ 66 % of jev input tokens (≈ 1.57 M of 2.40 M per 30 d) | **VERIFIED** | E §2, §5 |
| `names_file` and `risk_atomic` are dominated by deterministic rules | **VERIFIED** | E §4 |

### 7. Where can decision mechanisms exercise unauthorized influence?

Workstream F owns the authority graph and repairs (sibling PRs #963–#968). This list covers only influence that this
study's evidence touches.

| Path | Kind of influence | Status | Tag |
|---|---|---|---|
| `kb_passage_relevance` (jev, enforce) filters the evidence an **approval** panel sees | indirect approval influence by a probabilistic judgment, unvalidated | acting | **VERIFIED** (E-4) |
| `discovery_relevance` (jev) decided expert-unit creation ("a promotion") while labelled shadow | indirect admission/promotion | paused (#825); bookkeeping in #964 | **VERIFIED** |
| `discovery_relevance = yes` chooses the knowledge titles in the **genome mutation prompt** (`dream-evolution.ts:177`) | jev shapes variation (not selection) | acting whenever a dream runs; rows age out of the 30-day window by about 11-13 | **VERIFIED** (allowed by the rule, undocumented) |
| `failure_cause` (jev) → memory candidates → LLM-panel promotion → 70 % of prod maker prompts | probabilistic judgments chained into a promotion that reaches production behaviour, with no outcome test | acting | **VERIFIED** (structure) |
| Memory promotion by LLM panel consensus (and by proof runs, F) | promotion without human or outcome validation | acting; proof-run path repaired in #963 | **VERIFIED** / F |
| `threadGated` reads stale `commons_contribution` rows of a judgment that is `off` | a disabled judgment still gates | #964 | **VERIFIED** |
| Bandit reward = reviewer-dependent `verified` | reviewers indirectly allocate maker traffic | acting | **VERIFIED** (B R7) |
| Auto-merge eligibility relies on assertion-strength `pass` (`loop-auto-merge.ts:150-151`), which passes zero-kill tests | a weak deterministic proxy gates a promotion to `main` with no human in the loop | acting (`LOOP_AUTO_MERGE_TEST_ONLY=act`, P7); test-only PRs only, capped per day | **VERIFIED** |

### 8. Which interventions have the highest expected value of information?

Ranked by decision impact per unit cost (C §9). These are qualitative judgements, not computed values.

| Rank | Intervention | Cost | Why | Tag |
|---|---|---|---|---|
| 1 | **STR-001 Stage A** (#966, running) | 0 GPU | decides whether the only positive lever survives an independent family | SUPPORTED |
| 2 | **GR-REL-001** as a pre-registered secondary analysis of Stage A outputs | ≈ 0 | sets k for every graded endpoint; decides whether graded fitness is valid | SUPPORTED |
| 3 | **Measurement repairs** (B §6: `skipped` for no-op checks, k ≥ 9 in two families, grade failed makers' tests, report size) | CPU, small code | raises the information of every later experiment | SUPPORTED |
| 4 | **SETTLE-PAIR** | 0 GPU | gives the only L3 path a retention signal that can fail | SUPPORTED |
| 5 | **E-KB** | ≈ 2 h operator | keep or remove the only acting jev decision | SUPPORTED |
| 6 | **AA-001 + INH-000** | ≈ 40 GPU-h | decides whether the genome channel can carry signal at all; tells how to read E0 | SUPPORTED |
| 7 | STR-001 Stage B | ≈ 16 GPU-h, 30–40 days | confirmatory adoption of the strengthen operator (shadow) | SUPPORTED |
| 8 | E0 readout (registered) | running | first promotion, if any; power 0.17–0.31 | VERIFIED (power) |
| 9 | HF-001 | 58–116 GPU-h | M/H vs S lever choice | HYPOTHESIS (value) |
| 10 | INH-001 | 155–224 GPU-h | production inheritance yes/no; only after 6 | HYPOTHESIS (value) |

### 9. Which existing capabilities should be retained, modified or retired?

| Capability | Decision | Reason | Tag |
|---|---|---|---|
| Executed gates, LLM checker, security checker | **RETAIN** | validated within their construct | VERIFIED |
| Held-out fresh-mutant offline harness (MFR/STR) | **RETAIN** | the best existing endpoint | VERIFIED |
| Merged-test path + settlement execution (shadow) | **RETAIN**; **MODIFY** to pair with maker-time scores | the only L3 chain; retention cannot fail yet | VERIFIED |
| Graded fitness (shadow) | **MODIFY**: k ≥ 9 per family, two families, size reported; stay shadow until GR-REL-001 | reliability ≈ 0.5 | SUPPORTED |
| Graded contest (shadow) | **RETAIN shadow** | ≈ free; small upside (+0.042, 2/16) | SUPPORTED |
| `test:mutation:grounded` reporting | **MODIFY**: record `skipped` when it is a no-op | mislabelled pass | VERIFIED |
| Assertion-strength check | **RETAIN** as a floor. **MODIFY** what it gates: auto-merge should also need an executed kill share | non-discriminating at 0.5 | VERIFIED |
| Merge survival as a learning label / Gate B input | **RETIRE** as a learning label (keep as a report) | cannot fail | VERIFIED |
| Dream genome loop | **MODIFY**: finish the registered E0 readout; no further dreams or trials until AA-001 + INH-000; record served model + worker hash (operator OK) | unverified delivery, no headroom, 0 generations | VERIFIED / SUPPORTED |
| Genome prod injection | **DO NOT BUILD** (D §8) | no gate met | VERIFIED |
| Species bandit | **RETAIN**; shadow-read graded Q per species before any change | no effect estimate; reward is reviewer-dependent | VERIFIED |
| Memory rules | **RETAIN pending the 27-10 readout**, then apply the G3.3 freeze rule if no positive effect; promotion should need an outcome test (F) | approval ≠ outcome | VERIFIED (structure) |
| jev: `checker_second_opinion`, `risk_atomic`, `decision_context`, `reflection_triage`, commons judgments | **RETIRE** | no consumer, or dominated by a rule | VERIFIED |
| jev: `kb_passage_relevance` | **MODIFY** → shadow until E-KB passes | acting, unvalidated, approval-adjacent | VERIFIED |
| jev: `failure_cause` | **MODIFY** (dedupe re-rolls, E-FC), else retire | feeds promotion; no ground truth | VERIFIED |
| jev: `proposal_prescreen` | **MODIFY**: frozen until D5-NO ends; then retire names_file and very likely the path | dominated / never acted | VERIFIED |
| jev: `discovery_relevance` | **RETIRE authority** (keep paused; rank-only if reopened); declare its mutation-input role | side door | VERIFIED |
| Commons / residents as growth engines | **RETAIN off** (NE-003, NE-010) | no outcome | VERIFIED |

### 10. What is the smallest experiment capable of falsifying the preferred evolutionary hypothesis?

**The preferred hypothesis.** On current evidence the most plausible route to cumulative improvement is not genome
evolution. It is the **test-quality ratchet**: a generic strengthen-assertions operator, selected on held-out fault
detection, whose output is retained as merged tests that later runs inherit as their environment.

**Its smallest falsifier is STR-001 Stage A (#966).** It is already pre-registered and authorised.
- Unit: the 40 existing MFR-001 items.
- Contrast: the original test vs the control-retried test.
- Families: Stryker (primary) and a fresh seeded generator.
- Cost: 0 maker runs, 0 GPU, 0 tokens, a few CPU hours.

The registered rule is **FALSIFIED if the Stryker CI upper bound < +0.05**. If that happens, the operator is
generator-specific, the ratchet loses its only positive lever, and the plan should fall back to measurement repair and
deterministic testing. **Tag: VERIFIED** as a valid falsifier (pre-registered before scoring, independent family,
existing items). Its result is **UNKNOWN** here: not anticipated.

**For the genome-evolution hypothesis specifically**, the smallest falsifier is **INH-000 + AA-001**: ≈ 40 GPU-h, 0 cloud
tokens.
- If a deliberately harmful line, a known helpful line, and a baseline re-run all fall within ±0.10 of each other on 42
  write_test tasks with the fire check on, then the strategy-line channel does not move behaviour on this model and
  harness. Dream evolution of S-lines is then falsified as a lever, whatever any future promotion rule says.
- The registered 40-task E0 trial **cannot** falsify it. Its power is 0.17–0.31, so a non-promotion is
  INSUFFICIENT_EVIDENCE (PRE).
