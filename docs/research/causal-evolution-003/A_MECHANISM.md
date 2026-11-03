# CAUSAL-EVOLUTION-003 · A · Evolutionary mechanism identification

Read-only research. No model call, no GPU, no prod write, no flag change, no merge. This file also holds the conventions
and source keys that files B–H use.

## Conventions

**Classification of every conclusion**

| Tag | Meaning |
|---|---|
| **VERIFIED** | A code read at the running commit, a read-only prod query, or a pre-registered result whose numbers I reproduced |
| **SUPPORTED** | Existing data agree with the claim, but the analysis is post hoc, observational, confounded or small-n |
| **HYPOTHESIS** | Plausible and testable, not tested |
| **UNKNOWN** | No evidence either way. Never read as 0 |
| **FALSIFIED** | A pre-registered test rejected the claim |

**Snapshot.** Prod `/health` at 2026-10-22T20:19Z reported commit `5dfc6cdb`, `commit_matches_build: true`, image
`djimitflo:main-5dfc6cd`. That is `origin/main`, the base of this branch, so every `file:line` below is the code that runs.
The container was recreated at about 20:05Z for the operator's `DREAM_TRIAL_MUTANT_TIERS=3,4,5,6` change (PRE).

**Source keys**

| Key | What |
|---|---|
| EVO | EVOLUTION-001, draft #960, `docs/research/evolution-001/` (branch `docs/evolution-001`). I reuse its numbers and checked the ones I could re-query. They agree |
| JEV | JEV-EVOLUTION-L3-001, draft #961, `docs/research/jev-evolution/` (branch `research/jev-evolution-l3`) |
| MFR | MFR-001, #959, `docs/research/eco/MFR-001_RESULT.md` + `mfr-001/results.json` (branch `exp/mfr-001`). NE-013 |
| PRE | #962, `docs/research/evolution-001/EPOCH1-TRIAL-PREREG.md` |
| SEC | SEC-F1, #941 (merged), `docs/research/eco/SEC-F1_RESULT.md` |
| L3v2 | `docs/research/l3-forensics/L3-REPORT-v2-20261021.md` |
| NE | negative-evidence registry, NE-001…NE-013 (NE-013 on #959) |
| F1 | LLM-checker planted-defect study, `docs/research/intelligence-metrics/AGENT_SWARM_EVALUATION.md:28` |
| P1–P7 | the read-only probes in `probes/`, run 2026-10-22 20:19–20:23Z through `probes/run.sh`. The script goes to `node` over stdin; the DB is opened `{readonly:true}`; nothing is written in the container. P4 imports prod's own compiled `dist` |
| AN | `probes/analysis.py`: offline, standard library only, fixed seeds. It reads `data/*.json` (derived from P1–P6) and MFR's `results.json` |
| F (sibling) | Workstream F, the authority graph and bypass repairs. Another agent owns it. Referenced only |
| STR (sibling) | STR-001 Stage A, draft #966 (branch `exp/str-001-stage-a`), run by another agent. Protocol `docs/research/eco/STR-001_STAGE_A_PROTOCOL.md` was registered 2026-10-22T20:34:58Z. Primary family: Stryker. SUPPORTED needs Holm p < 0.05 and CI lower > +0.05; FALSIFIED is CI upper < +0.05. Its result was not posted at the time of writing. I neither duplicate it nor anticipate it |
| F (sibling PRs) | #963 (proof runs never self-promote memory), #964 (discovery_relevance counted as a promotion gate; stale commons verdicts gate nothing), #965 (capabilities only through promotion; high-risk human gate), #967 (reviewer approval inheritance), #968 (no-escalation write doors). Referenced only |

**What I did not look at.** The epoch-1 trial genomes `g-a187f81f` and `g-d14c1156` and the parent's epoch-1 attempts
have a registered readout (PRE). I report attempt counts and cost for them only, never outcomes. The memory-holdout
experiment has a registered readout on 27-10. I cite EVO's descriptive numbers and do not re-analyse them. The D5-NO
and JEV-114 populations are not analysed.

---

## 1. Answer first

| # | Conclusion | Tag |
|---|---|---|
| A-1 | No loop in Djimitflo meets all three conditions for cumulative adaptation at once: variation selected on a measured fitness, a heritable carrier that reaches production, and more than one generation. | **VERIFIED** (code + P2) |
| A-2 | The Darwin genome loop is designed as evolutionary search. In practice it runs as **single-generation mutate-and-test against a fixed parent**: all 18 dream genomes have parent `baseline`, 0 were promoted, and 0 lineages go past generation 1. That is selection without inheritance, and it is closer to random-restart prompt search than to evolution. | **VERIFIED** (P2, AN A1) |
| A-3 | Even a promotion would not reach production: injecting genome lines into prod makers is not built (`loop-daemon.ts:617-626`, `GENOME_APPLY_MODE` unset in prod, P1). | **VERIFIED** |
| A-4 | The species bandit and the evolve-sibling contest are selection over a fixed set of generators. Neither creates heritable variation. The bandit is selection without inheritance. The contest is repeated independent generation plus best-of-n. | **VERIFIED** (code) |
| A-5 | The only carriers that accumulate across runs and reach production are the **promoted memory rules** and the **merged tests on `main`**. The rules are selected by an LLM panel, not by outcome. The tests are niche construction: the environment accumulates, not agent capability. Whether either improves later performance is **UNKNOWN**. The memory readout is due 27-10. Settlement kill share has 0 maker-time pairs. | **VERIFIED** (structure) / **UNKNOWN** (effect) |
| A-6 | Pooled over the 10 settled epoch-0 genome trials, the effect of a mutation on paired pass is −0.009, 95 % CI [−0.036, +0.017] (8 wins, 11 losses, 320 paired task observations). At that parent pass rate (≈ 0.79) the estimate is indistinguishable from re-sampling the parent. | **SUPPORTED** (descriptive; it ignores the shared parent and task clustering) |
| A-7 | Overall classification: **repeated independent generation with selection without inheritance, plus unselected cumulative accumulation**. It is not genuine cumulative adaptation. The genome terminology does not change this. | **VERIFIED** for the structure. The *capacity* to adapt is **UNKNOWN** |

## 2. The process reconstructed component by component

### 2.1 Genotype representation

| Carrier | Representation | Write point | Tag |
|---|---|---|---|
| Strategy genome | `maker_genomes(id, parent_id, gene ∈ {baseline, strategy_lines, anti_pattern, playbook}, lines_json, status)` | `dream-evolution.ts:373`. A child's lines are `[...parent.lines, ...added]` | VERIFIED |
| Run genome (identity only) | `runGenome()` = sha16({template hash, sorted examples, sorted rule ids:seal}) | `maker-genome.ts:17-34` | VERIFIED |
| Skill content hash | sha256({examples, genome_id, rules, template_hash}) | `maker-genome.ts:43-45`. Present on 34 % of prod maker outcomes (EVO GENOTYPE) | VERIFIED |
| Species | `runtime[@model]`, 2 arms in prod: `opencode`, `remote@workstation/atomic@llama-router` | `runtime-bandit.ts:23-31`. `LOOP_BANDIT_SPECIES` (P1) | VERIFIED |
| Memory rules | `memory_candidates` with `content_hash` seal; status `promoted`/`rejected` (189 / 46, P2) | memory candidate pipeline | VERIFIED |
| Not recorded | served model and worker/harness hash per gym attempt | EVO GENOTYPE §4 | VERIFIED gap |

**Reading.** The representation is an additive list of natural-language lines appended to a fixed template. There is no
crossover operator, no deletion operator, and only one gene changes per mutant (`dream-evolution.ts:15-22`).

### 2.2 Genotype → phenotype mapping

The mapping is: lines → text in the maker goal → model + harness behaviour → executed oracle.

| Link | Observable? | Evidence | Tag |
|---|---|---|---|
| Genome lines → maker prompt (gym) | Only with `GENOME_FIRE_CHECK=true`. The worker then reports the goal sha256 and the number of lines found. Otherwise the treatment may silently not reach the maker | `genome-registry.ts:237-271`. Prod now: `GENOME_FIRE_CHECK=true` (P7). But **0 of 339 epoch-0 mutant-genome attempts carry fire-check evidence and 0 are VOID** (P7), so the check was off for every settled trial | VERIFIED: treatment delivery is **unverified for all 10 settled trials** |
| Genome lines → maker prompt (prod) | **No link.** `strategyGenomeFor` only attributes; nothing injects | `genome-registry.ts:273-286`, `loop-daemon.ts:617-626` | VERIFIED |
| Prompt → behaviour | Measurable only where the endpoint has headroom. MFR moved held-out kill by −0.14 / +0.32 with prompt changes. The genome trials moved nothing on saturated tasks | MFR; AN A1 | SUPPORTED |
| Behaviour → fitness | Executed gates (binary), graded kill (k = 3 mutants), Stryker score (mutation lane) | B file | VERIFIED |

**Key point.** The prompt is *capable* of changing behaviour: MFR showed that a prompt change shifts held-out kill by
0.14 [0.03, 0.25]. That only holds on an endpoint with headroom, and the genome trials were scored on endpoints without
headroom. So "lines do not change phenotype" is not established. "Lines did not change phenotype *on the tasks they were
scored on*" is.

### 2.3 Mutation operators

| Operator | Mechanism | Rate in prod | Tag |
|---|---|---|---|
| Dream mutation | One LLM call per day (`DREAM_EVOLUTION_MODEL` → `SELF_IMPROVEMENT_REVIEW_MODEL` → `kimi-k3:cloud`, temperature 0.7, `dream-evolution.ts:296-299`). In prod that resolves to `gemma4:31b:cloud`: `DREAM_EVOLUTION_MODEL` is unset (P7). It proposes ≤ 3 mutants (`MAX_MUTANTS`, :25), each changing one gene. The guard (`FORBIDDEN` regex, :151; `guardLines`) drops lines that touch gates, tests, the evaluator, etc. Inputs: the last day's failures with holdout tasks excluded (D3, :160-180), plus up to 3 knowledge titles chosen by **jev `discovery_relevance` = yes** (:177) | 18 genomes since 01-10. The ledger shows 1 `dream_evolution` call since purpose tagging started (1 199 in / 738 out tokens, P2). No dream may start while a trial runs (:306) | VERIFIED |
| Playbook gene | Deterministic. Appends the lane playbook built from skill cards (`proposePlaybookMutant`). ≤ 1 per dream | 1 (`g-d14c1156`, in trial) | VERIFIED |
| Evidence-cited mutation | With `DREAM_EVIDENCE_SOURCES`, every line must cite a pack item | 1 (`g-a187f81f`) | VERIFIED |

**Reading.** The variation operator is an LLM rewriting instructions from yesterday's failures. It is *directed*
variation, conditioned on failures, so it is closer to automated prompt engineering than to random mutation. Its input
includes a jev judgment (discovery relevance). jev therefore shapes the variation operator, though not selection. jev is
forbidden only for fitness and promotion, not for variation, so this is allowed. It is still undocumented. See E and F.

### 2.4 Selection mechanisms

| Selector | Population | Criterion | Acts? | Tag |
|---|---|---|---|---|
| Genome trial promotion (`evaluateTrials`, `dream-evolution.ts:588`; boundary `promoteGenome`, `genome-promotion.ts:44-52`) | each trial genome vs its parent on the frozen holdout | `DREAM_PROMOTION_RULE=both`: one-sided McNemar and e-process on deciding tasks; mined net loss ≤ 1; headroom precheck; only production-gated evidence counts | yes, 0 promotions ever (P2) | VERIFIED |
| Species bandit (`chooseSpecies`, `runtime-bandit.ts:35-53`) | 2 fixed species | Thompson sampling on verified/failed `skill_outcomes`, excluding unfair zeros; challenger share cap `LOOP_BANDIT_MAX_SHARE=0.8` (P1) | yes | VERIFIED |
| Evolve contest (`evolve-selection.ts`) | ≤ 3 sibling makers on one objective | size rule (acting). Graded contest in shadow | yes | VERIFIED |
| Memory review (`memory-candidate-review-scheduler.ts:1-40`) | memory candidates | LLM panel consensus (unanimous, confidence ≥ 0.8). Not an outcome test | yes: 189 promoted / 46 rejected (P2) | VERIFIED |
| Merge | verified PRs | human merge, or auto-merge test-only with an assertion-strength `pass` (`loop-auto-merge.ts:150-151`) | yes | VERIFIED |
| Experiment adoption | factor experiments | operator readout | 0 of 11 loops closed (P4 `learning_ledger`) | VERIFIED |

### 2.5 Fitness measurements

Full audit in B. Summary: binary pass under production gates (saturated at epoch 0), graded mutant kill with k = 3
(reliability ≈ 0.50, B §3), Stryker score (mutation lane only), verified label (blind to fault detection, B §2),
merge survival (cannot fail, 22/22), settlement execution (16/16 pass, unpaired). **VERIFIED.**

### 2.6 Inheritance mechanisms

| Carrier | Inherited into what | Generations observed | Prod exposure | Tag |
|---|---|---|---|---|
| Genome lines | child genome = parent lines + new lines (gym only) | **1**: every dream genome's parent is `baseline` (18/18, P2, AN A1) | none | VERIFIED |
| Memory rules | prod maker prompt for 70 % of runs (`MEMORY_HOLDOUT_RATE=0.3`, P1; `assignment-context.ts:28-34, :78`) | rules accumulate over time. 189 promoted, but only 19 distinct rules are read (EVO HEREDITY) | yes | VERIFIED |
| Examples / KB (K1, ACE) | prod maker prompt | per run, recency or similarity. No fitness selection | yes | VERIFIED |
| Bandit posterior | next species choice | continuous | yes | VERIFIED |
| Merged tests | the repository every later run executes against | continuous | yes | VERIFIED |

### 2.7 Environmental variation

| Source | Effect | Recorded per attempt? | Tag |
|---|---|---|---|
| Router model load state (`qwen38-27b:loaded`, others unloaded in MFR) | the served model can differ between parent and mutant | **no** on gym attempts | VERIFIED gap |
| D9 hardened runner from 22-10 ~03:40Z (#955/#958) | 21 of the parent's first 35 epoch-1 mined attempts predate it (PRE) | no worker hash | VERIFIED |
| Holdout epochs (0 exposed, 1 fresh) | rotation changes task difficulty | yes (epoch) | VERIFIED |
| Gate policy (`prod_gates/v1:<hash>`) | changes what "pass" means | on decisions, not attempts | VERIFIED |
| Repository `main` grows (merged tests) | later tasks and gates run on a different repo | implicitly (commit) | VERIFIED |

### 2.8 Retention mechanisms

Genome: `status='active'` (never reached). Memory: `promoted`. Code: merge plus the 14-day line-survival check (cannot
fail) and settlement execution (shadow). There is no 30-day check and no capability-gain link (P4 `lineage`:
`survived_30d` and `capability_gain` are `not_measured`). **VERIFIED.**

### 2.9 Production exposure

| Mechanism | Exposed to prod? |
|---|---|
| Genome lines | **no** (attribution only) |
| Memory rules | yes (70 %) |
| Bandit | yes |
| Evolve contest | yes (size rule) |
| Graded contest, graded fitness, settlement execution, assertion-strength | shadow |
| Merged tests | yes |

## 3. Classification per loop, with the observable causal pathway

The five classes from the directive, made operational:

| Class | Requires |
|---|---|
| (1) evolutionary search | variation, selection on fitness, and heredity of the selected variant into the next round of variation |
| (2) prompt optimization | search over instruction text against a score, with no population or lineage needed |
| (3) repeated independent generation | i.i.d. re-sampling from a fixed generator |
| (4) selection without inheritance | choose among variants; nothing selected becomes the parent of new variation |
| (5) genuine cumulative adaptation | (1), plus improvement that persists and compounds across ≥ 2 generations, shown on held-out tasks |

| Loop | Class (designed → realized) | Observable causal pathway | Where the pathway is cut | Tag |
|---|---|---|---|---|
| Darwin genome loop | (1) → **(4) / (2)** | failures → LLM mutation → gym trial vs baseline → McNemar → `active`? | cut at selection (0 promotions: 6 no-headroom, 2 blind, 10 retired) and at heredity (parent always baseline), and absent at prod exposure (no injection) | VERIFIED |
| Species bandit | **(4)** | outcomes → posterior → species share | no variation operator. Arms are fixed by config. Effect not measured (OPE of a different policy +0.0018 [−0.0112, 0.0144], P4) | VERIFIED |
| Evolve contest | **(3) + best-of-n** | k siblings → size rule → winner merged | nothing about the winner is inherited by the generator. 12 of 16 scored contests had all siblings tied on graded (AN B3) | VERIFIED |
| Memory rules | **cumulative accumulation selected by approval** (closest to (2) with a human/LLM curator) | failed runs → consolidation → LLM panel → prompt of 70 % of makers | selection is not on fitness. The effect is pending (readout 27-10). Earlier NE-002 INCONCLUSIVE | VERIFIED (structure) / UNKNOWN (effect) |
| Merged tests | **niche construction** | maker → gates → merge → `main` → every later run | improves the environment's oracle. Whether later agents perform better because of it is unmeasured | VERIFIED / UNKNOWN |
| Factor experiments | operator-mediated (2) | randomised arm → readout → operator adopts | 0 of 11 closed | VERIFIED |

**Classification of the system (A-7).** Djimitflo today is **repeated independent generation with
selection-without-inheritance (bandit, contest, genome trials), plus two accumulating carriers (memory rules, merged
tests) that are not selected on outcome fitness**. Class (5) requires a selected, heritable, prod-exposed carrier with ≥ 2
generations, and none exists. That is a structural fact, so the absence of cumulative adaptation is **VERIFIED by
construction**. It is not a negative empirical result about what Djimitflo *could* do.

## 4. Pooled evidence from the settled genome trials (epoch 0)

From the `maker_genomes` notes (P2; AN A1). The two open epoch-1 trials are excluded.

| Trials | Paired task observations | Mutant wins (b) | Mutant losses (c) | Pooled paired Δ (pass) | 95 % CI (normal approx.) |
|---|---|---|---|---|---|
| 10 settled (4 on a 20-task mined holdout, 6 on 40 tasks = 20 mutant + 20 mined) | 320 | 8 | 11 | **−0.009** | **[−0.036, +0.017]** |

Plus 6 genomes settled `inconclusive: no_headroom` before any deciding attempt, because the parent failed 3 of 20 and
≥ 5 are needed (P2).

**Reading.**
- SUPPORTED: the 10 mutations, pooled, changed paired pass by between −3.6 and +1.7 pt.
- The parent passed ≈ 79 %, and most tasks are deterministic for the species. The test is therefore a statement about
  **these tasks**, not about the operator. The code says the same (Z5, `genome-registry.ts:103-108`): "it measured task
  difficulty, not strategy".
- The CI ignores the shared parent (one parent attempt set for all trials of an epoch) and task clustering. A proper
  interval is wider. **SUPPORTED, not VERIFIED.**
- Cost of the Darwin loop so far: 415 trial attempts, about 50.5 gym wall-hours (379 attempts and 45.3 h before 16-10;
  P3). One cloud call per dream. 0 promotions.

## 5. Competing explanations for the absence of retained improvement

None of these excludes the others. The table says what each one predicts and which experiment separates it from the rest.

| # | Explanation | Status of evidence | Distinguishing prediction | Experiment that separates it (design in C/D) |
|---|---|---|---|---|
| C1 | **Structural**: no carrier connects a selected variant to production | VERIFIED (A-3) | Holds whatever the fitness data say. It explains *prod* non-retention and not the 0 gym promotions | none needed. Do not build injection before a powered gym promotion (D §8) |
| C2 | **No headroom**: the parent already solves almost every deciding task | VERIFIED for epoch 0 (15/20, 32/40; 6 no_headroom) | Discordance is near 0 *for every genome*, including obviously harmful ones | positive control (C3 below) on a set with headroom. The epoch-1 parent has 12/35 gated mined passes (EVO); its outcomes are not analysed here |
| C3 | **Phenotypic inertness**: lines reach the prompt but the fixed model ignores them | HYPOTHESIS; pooled Δ ≈ 0 is consistent with it but confounded with C2 | A deliberately **harmful** line ("stop after reading the files") and a known **helpful** line (the MFR control instruction) also produce Δ ≈ 0 | **INH-000 dose-response positive control** (D §3): baseline vs harmful vs helpful line, 40 write_test tasks, graded k ≥ 9. If harmful ≈ baseline, the channel is dead |
| C4 | **Treatment never delivered** (lines not in the maker goal) | **UNKNOWN for all settled trials.** The fire check was off then: 0/339 epoch-0 mutant attempts carry fire-check evidence (P7). It is on now (`GENOME_FIRE_CHECK=true`) | VOID rate > 0 now that the check is on | read `gym_result.fire_check` on the epoch-1 trial attempts *after* the registered readout (counting VOIDs is a validity check, not an outcome look) |
| C5 | **Noise floor ≥ effect**: mutant-vs-parent discordance equals baseline-vs-baseline discordance | HYPOTHESIS; 19/320 = 5.9 % discordance observed. No A/A replicate exists | A/A discordance ≈ 6 % | **AA-001** (C §1): the parent twice on the same 40 tasks, ≈ 13 GPU-h |
| C6 | **Invalid fitness**: selection rewards something other than the target | VERIFIED for the verified label and merge survival (B); SUPPORTED for gym proxy pass (0.867 proxy vs 0.311 prod gate, P4) | selected winners do not improve on an independent oracle (fresh mutant family, Stryker) | B's validity tests. STR-001 Stage A/B uses two independent families |
| C7 | **Low power / unreliable endpoint** | VERIFIED: power ≤ 0.09 on 10 deciding tasks, 0.17–0.31 on 40 at q = 0.2 (EVO); k = 3 kill reliability 0.50 [0.21, 0.74] (B) | effects of the size MFR found (0.14) would be missed | raise k to ≥ 9–12 mutants per family (B §6); paired designs with n from C |
| C8 | **Non-stationary environment** (model load, runner change, repo growth) | VERIFIED that it happens; size UNKNOWN | parent pass rate shifts across an environment change at a fixed genome | record served model + worker hash (operator OK needed: gym-worker files); AA-001 split across an environment change |
| C9 | **Overfitting / negative transfer** to evaluator idiosyncrasies | FALSIFIED as a benign assumption for mutant feedback (NE-013: shown 0.81, held-out 0.325 vs 0.467) | selected variants gain on the selection set and lose on held-out families | every design in C/D scores on an independent held-out family |
| C10 | **Capacity ceiling of M + H**: the model/harness bounds performance and S-lines cannot move it | HYPOTHESIS; species differ more than prompts do (exports graded 0.313 vs 0.187, observational, EVO) | variance across M/H ≫ variance across S | **HF-001** factorial (C §3): variance decomposition |

**Which explanations are already settled?**
- **VERIFIED:** C1, C2 (epoch 0), C6 (for two proxies), C7.
- **FALSIFIED:** C9 as a benign assumption.
- **Open and cheap to decide:** C3/C5. The cheapest decisive step is AA-001 plus a dose-response positive control. Both
  are gym-only, ≈ 13–20 GPU-h, and would show whether the genome channel can carry any signal at all.

## 6. What would change this classification

1. One `active` genome, promoted on a powered trial (≥ 40 deciding tasks, Gate A band, pinned model and worker). Its child
   then trialled and promoted again. This is the first second generation, and it moves the Darwin loop from (4) to (1).
2. A prod inheritance path (injection), *after* (1) and only through D's decision rule. It is not recommended now.
3. A held-out, attributable gain of a memory-rule cohort over withheld rules (registered readout 27-10). This moves
   memory from "accumulation" to "adaptation". A one-off positive readout would be L4 for one generation, not cumulative.
4. Settlement kill share paired with maker-time scores showing that merged tests catch later mutants or regressions
   better over time. This shows the niche-construction path has value. It is still not agent adaptation.
