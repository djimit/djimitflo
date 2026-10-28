# EVOLUTION-001 · 2 · Genotype G = (M, H, S, C, W, R) on existing structures

Conventions and source keys: file 1. This file maps a genotype onto what Djimitflo already records. It proposes only the
smallest extension that the evidence needs.

**Reading of the letters (assumption, stated because the directive does not define them).**

| Letter | Meaning |
|---|---|
| M | model (weights, served id) |
| H | harness/runtime: executor, tool interface, step and time budget |
| S | strategy/instructions: template, genome lines, playbook |
| C | context: memory rules, examples, KB, evidence packs |
| W | workflow: siblings, retries, reviewer chain, dependency preparation |
| R | risk and governance envelope: scope, gates, risk inputs, approval |

H, S, C and W line up with the paper's five harness components (file 4): S ≈ system prompt, H ≈ tool interface and
observation, C ≈ context management, W ≈ workflow.

## 1. Where each gene lives today

| Gene | Existing structure (write point) | Recorded per run? | Coverage (prod, 30 d) | Tag |
|---|---|---|---|---|
| **M** model | lease `model` / `effective_model` (`leaseRanOn`, #915); `skill_outcomes.model`; species key `runtime@model` (`runtime-bandit.ts:34 speciesKey`) | prod makers: yes. **Gym attempts: no served-model id** (`gym_result` keys = status, reason, hack_flags, prod_gates, graded, graded_kind, diff_ref, fire_check; S5) | prod yes; gym no | FACT |
| **H** harness | `runtime` (opencode / remote / claude / codex / atomic); remote species string `remote@<host>/<rt>@<model>`; worker image tag; `OPENCODE_MAX_RUN_TOKENS`, timeouts, `--max-steps` 60 (prod remote) vs 40 (gym) (TG) | runtime yes; **worker/harness hash only in TG-001 manifests**, not per gym attempt (S5) | partial | FACT |
| **S** instructions | `MAKER_TEMPLATE_HASH` (`maker-genome.ts:15`), STE arm → `STE_TEMPLATE_HASH` (`maker-genome.ts:22`); `maker_genomes.lines_json` (gene ∈ strategy_lines / anti_pattern / playbook); `genome_id` on the maker lease (`loop-daemon.ts:621-623`) | yes (hash); genome id on 12 leases (S1) | yes | FACT |
| **C** context | `assignment_context` event: `examples`, `rule_ids` (sealed by `content_hash`), `ace_001` arm, `kb_paths` (`maker-genome.ts:17-33 runGenome`); `evidence_sources_json` / `knowledge_refs_json` on genomes | yes | yes | FACT |
| **W** workflow | `effort_arm` (X1), `maker_deps_arm`, `checker_family_arm`, evolve `evolve_sibling_of`, requeue edges | per experiment flag | partial | FACT |
| **R** envelope | `risk_inputs` on maker leases (#947), objective-scope gate, effective diff limit on the lease (#557), gate policy `prod_gates/v1` (`dream-evolution.ts:424`) | `risk_inputs` on 7 of 57 leases since 22-10 (S1). Grandfathered leases carry none | partial | FACT |
| Identity hash | `skill_content_hash` = sha256({examples, genome_id, rules, template_hash}) (`maker-genome.ts:43`) | **on 112 of 329 prod maker outcomes (34 %); 217 null** (S1) | low | FACT |
| Run genome id | `runGenome().id` = sha16({template, examples, rules}) (Y2) | computed per run; stored as `genome:<id>` evidence | yes | FACT |

**Uniqueness.** Over 30 d the 112 hashed outcomes carry **65 distinct hashes**. 51 of them occur once, 11 occur 2–4 times
and 3 occur ≥ 5 times (33 outcomes) (S1). **FACT.** So almost every prod run has a unique genotype, because examples and rule
sets drift per run. **INFERENCE.** Per-genotype fitness cannot be estimated from prod data. Only genes held constant by
design (template, species, experiment arm) have repeated observations.

## 2. Property matrix

Legend: **Y** yes, **P** partly, **N** no, **—** not applicable. "Learnable" = some mechanism changes it from outcomes. "Inheritable" = a
change persists into later runs. "Recombinable" = two variants can be combined by an existing operator.

| Gene | Immutable | Configurable | Learnable | Inheritable | Recombinable | Env-dependent | Evidence | Tag |
|---|---|---|---|---|---|---|---|---|
| M | N | Y (opencode.json, router model) | N (no training; G6 gated, not started) | — | N | **Y**: router loads/unloads models (`qwen38-27b:loaded`, `gpt-oss-120b:unloaded` in MFR) | MFR `router_models` | FACT |
| H | N | Y (flags, image) | N | Y (config) | N | **Y**: the D9 hardened runner changed the gym runtime on 22-10 (#955/#958) | PLAN 22-10 | FACT |
| S template | P (code) | Y (STE flag) | N (only by experiment adoption) | Y (code) | N | N | STE-001 | FACT |
| S genome lines | N | Y | **P** (dream proposes; selection never promoted) | P (gym only) | **N**: one gene per mutant by design (`dream-evolution.ts:15-22`); no crossover operator | P | S1 | FACT |
| S playbook | N | Y | P (rebuilt from cards) | P (gym only) | N | P | `lane-playbook.ts:1-15` | FACT |
| C memory rules | N | Y (holdout rate) | **Y** (dream → review → promoted) | **Y** (prod prompt) | P (rule sets combine by selection, unordered) | P | S1 | FACT |
| C examples / KB | N | Y (ACE) | P (recency/similarity, no fitness) | Y | P | Y (needs merged tests in checkout; ACE Amendment 1) | ACE | FACT |
| W | N | Y | N (operator-adopted only) | Y (config) | N | Y | EE experiments | FACT |
| R | **Y by charter**: "gates/oracles/auth/deploy/secrets never evolve" (PLAN G invariants; guard `guardLines` forbids gate/scope/secret lines, `dream-evolution.ts:154`) | operator only | N | — | N | N | code + charter | FACT |

**Conclusion (INFERENCE).** The only gene that is learned from outcomes and inherited into prod behaviour today is **C/memory
rules**. Its effect is negative-trending (file 5). The gene the Darwin loop evolves, **S/genome lines**, is learnable in
principle but not inheritable into prod.

## 3. Genotype → phenotype: which gene changes measurably changed behaviour

Phenotype = an observable behaviour or outcome distribution under a controlled change of one gene, everything else fixed.

| Gene changed | Study | Design | Phenotype effect | Verdict | Tag |
|---|---|---|---|---|---|
| S+C: retry prompt with surviving mutants vs generic "strengthen assertions" | MFR-001 | paired, 40 items, held-out mutants | **Yes, large.** Shown-mutant kill 0.81 vs 0.53; held-out 0.325 vs 0.467 (Δ −0.142 [−0.250, −0.033]); median added lines 90 vs 206 | measurable change, wrong direction → NE-013 | FACT |
| W: one generic retry vs no retry | MFR-RA (post hoc, not registered) | within-item, deterministic counterfactual (the original test) | held-out kill 0.150 → 0.467, +0.317 [0.217, 0.425], 23 better / 0 worse / 17 equal, sign test p 1.2e-7 | **descriptive only**: needs confirmation (file 6 E1) | FACT (numbers) / INFERENCE (meaning) |
| S: assignment representation (gym goal vs prod `LOOP_WORK.md`) | TG-001 r2 | paired Latin square, 20 tasks | A 0.737 vs B 0.55; A−B +0.158 [−0.128, 0.422], McNemar p 0.45 | INCONCLUSIVE | FACT |
| S: dream strategy lines (16 settled genomes, epoch 0) | genome trials | paired holdout 20+20 | 0 discordant pairs on the deciding mutants in all 8 recorded trials, and 0–1 in the earlier retired ones; holdout 30–33/40 vs parent 32/40 (S1, EE `genomes.recent`) | **no measurable phenotype change** (no headroom: parent 17/20) | FACT |
| S: STE template | STE-001 | randomised, interim 47/46 | 0.681 vs 0.630; tokens 0.30 M vs 0.46 M per run | interim, descriptive | FACT |
| C: KB retrieval / similarity examples | ACE-001 | 2×2, interim 21–28 per arm | R −0.172, S −0.024 | interim, descriptive | FACT |
| C: memory rules vs withheld | memory holdout | randomised 0.3 | 0.802 (96) vs 0.903 (31), Fisher p 0.28 | readout 27-10 | FACT |
| W: dependencies prepared before the maker | MAKER-DEPS-001 | randomised, 29/37 | verified +0.043 [−0.196, 0.274]; **mean tokens per lease 0.73 M → 0.39 M** (descriptive) | interim. The token phenotype is the most visible change, still unregistered as primary | FACT |
| W: evolve siblings | X1 | randomised | 0.727 vs 0.746, p 0.83 | no effect visible | FACT |
| M (checker): same vs cross family | F2 v2 | randomised | 15/15 vs 7/7 accepted; κ undefined | collecting | FACT |
| M+H: opencode glm-5.2 vs remote atomic | bandit (not randomised) | observational | exports verified 56/114 vs 16/54; graded exports 0.313 vs 0.187 (S1, S3) | confounded by assignment | FACT / INFERENCE |
| M+S (security checker) | SEC-F1 | planted items | AUC 0.975 | validated verifier phenotype | FACT |

**Reading (INFERENCE).**
- Single-gene prompt/context changes can move behaviour measurably, but only when the endpoint has headroom and a paired
  design. MFR moved held-out kill by 0.14 to 0.32 at n = 40.
- On saturated or binary endpoints (genome trials at epoch 0, X1, F2) no gene change has been visible.
- The genotype → phenotype map is therefore limited by **endpoint resolution**, not by a lack of variation.

## 4. Smallest compatible extension (proposal only; nothing built)

Needed because two facts block any genotype-level analysis:
1. Gym attempts do not record the served model or the worker/harness hash (S5). A parent and its mutant can run on different
   M or H without anyone seeing it (file 6 E0).
2. `skill_content_hash` is null on 66 % of prod maker outcomes and covers only S + C.

| Change | Where | Why minimal | Owner |
|---|---|---|---|
| Add `served_model` and `worker_sha256` to `gym_result` (the worker already knows both; TG-001 records them) | gym-worker report → remote gym record | one field each, no new table. **Touches `scripts/gym-worker.mjs` / `remote-gym-service.ts` → needs the operator's explicit OK** (builder rule) | operator decision |
| A `genotype` object on the maker lease: `{m, h, s: template_hash + genome_id, c: rule seal set hash + examples hash, w: arm map}` | lease metadata, written where `risk_inputs` is written | additive; `skill_content_hash` keeps its meaning, so running experiments see no change | builder, flag-free (record only) |
| Explain the 217 null hashes before trusting per-skill fitness | read-only audit | unknown cause | builder |

No new table, registry or genome type is proposed. **HYPOTHESIS:** after this extension, a per-gene ANOVA over existing
experiment arms is possible without new experiments.
