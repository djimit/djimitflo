# AW-0 → DjimitFlo transferability

Inputs: [SOURCE_FORENSICS.md](SOURCE_FORENSICS.md) (what AW-0 is), [CAPABILITY_INVENTORY.md](CAPABILITY_INVENTORY.md) (what DjimitFlo already has), [WORLD_MODEL.md](WORLD_MODEL.md) (DjimitFlo as a POMDP).

**Headline:** the AW-0 *weights* do not transfer at all, and its *architecture* (one jointly-trained generative model over plan, future observation and action) is not justified at our data volume. What transfers is a set of **process and ordering principles**: plan → predicted outcome → action; skills as frozen, contract-checked, evidence-reused programs; a coordinator that distills skills but cannot edit the verifier; one-shot locked holdouts; and, from AW-0's own failure, **arbitrate between channels on predicted advantage, not on validity**. A modular predictor + planner built from existing records and an existing local LLM is the right shape for DjimitFlo. A shared learned generative model is not needed and is not affordable.

## 1. Mechanism matrix

Legend: **T** = transfers (as a principle or process; nothing is copied), **R** = needs redesign, **X** = does not transfer.

| # | AW-0 mechanism | Verdict | Reason | DjimitFlo landing point (existing first) |
|---|---|---|---|---|
| M1 | Three coupled streams C (code plan), Z (future observation), A (action) | **R** | The decomposition is sound. In our domain the streams are a plan/skill choice, a predicted check/test/CI outcome, and a maker diff/tool call. None of them is continuous, and Z is a small structured vector, not video. | Plan = work-item/skill-card selection; Z = check-outcome forecast; A = maker run. See WORLD_MODEL §1 and §8. |
| M2 | Mixture-of-Transformers with per-layer joint attention | **X** | It needs a jointly trained network and millions of aligned (C, Z, A) samples (2.08 M slices in AW-0). We have hundreds of verified outcomes per month. A per-layer coupling also has nothing to couple: our "experts" are separate external systems (LLM CLIs, test runners, CI), not trainable transformers. | — |
| M3 | Ordering C → V → A (plan conditions the predicted future, and both condition the action), worth 71.1 vs 48.3 for V → C → A | **T** | This is a pipeline-ordering result and needs no shared model: form the plan first, predict outcomes *given the plan*, and choose or abort the action given both. Only the robotics ablation supports it; on our side it is a hypothesis. | Predictor inputs must include the chosen skill/playbook and the planned files, not only the raw task text. EXPERIMENTS H2. |
| M4 | Masked (LLaDA) diffusion for code | **X** | A decoding method for a model you train. We consume autoregressive LLMs through CLIs/Ollama and do not train code generators. | — |
| M5 | Flow matching for video and actions | **X** | Continuous-latent generation. Our observations are discrete (pass/fail), counts and durations. A calibrated classifier/regressor is the right tool. | — |
| M6 | Noise resampling + importance weighting (train under the inference distribution) | **T** (principle) | The idea is to fit and score a predictor on the distribution it will face in deployment, and reweight when the training distribution differs. | Score forecasters on dispatched work, not on gym tasks, or reweight gym results to the dispatch mix. EXPERIMENTS H1 design. |
| M7 | Automatic annotation: an LLM labels trajectories with programs over a declaration-only API; static validation with rewrite-on-failure | **R** | Our trajectories (execution_events, diffs, checks) are already symbolic. "Labelling with programs" becomes labelling runs with the skill/playbook calls that explain them. That is cheap and does not need a VLM. | Skill distillation / outcome attribution (inventory). |
| M8 | Coordinator protocol: audit, classify failures (detector limit / misread / abstraction break / vocabulary gap / segmentation), admit skills only from vocabulary gaps; admission bar generic + recurrent in ≥2 tasks + right altitude + non-duplicate + machine-checked contract; retire to `_attic/` with a reason; the coordinator never edits the verifier or prompts | **T** | Pure governance, domain-independent, and stricter than "promote what worked". The failure taxonomy is the useful part: only one of five failure classes may create a skill. | Skill-card distillation + genome registry admission gates (inventory). Candidate port: the 5-class failure taxonomy as a required field on distillation proposals. |
| M9 | Frozen skill library; editing it bumps the prompt version and invalidates caches | **T** | Versioned vocabulary and cache invalidation on change are already standard. AW-0 makes the coupling explicit. | Genome/playbook versioning (inventory). |
| M10 | Evidence-verified reuse cache (reuse a cached program only if the observed contact events match its contract) | **T** | Reuse by *contract match on observed evidence*, not text similarity. Our analogue: reuse a fix or playbook only if the failing-check signature matches the skill's declared precondition. | Skill-card preconditions vs failing check IDs. |
| M11 | Memory of earlier slices (K learned slots, scheduled self-sampling) | **X** / **T** (exposure-bias lesson only) | Learned slots need training. The lesson that matters: if a predictor is ever trained on its own past outputs, train with self-generated history to avoid exposure bias. Not relevant until we train anything. | — |
| M12 | Fixed-interval replanning (every 24 steps), with a fresh plan each time | **R** | Our loops replan on *events* (checker verdict, failed check, lease expiry), which is the better trigger in a discrete, delayed-outcome world. Keep event-driven. | Maker/checker retry loop (inventory). |
| M13 | Hybrid execution: run the code slice if it passes validity gates, otherwise the learned action | **T** (as a lesson) | AW-0's own data: validity-gated arbitration **cost 17.7 pp** in the clean setting and helped only out of distribution (+8.6 pp). Their stated fix is to arbitrate on predicted advantage. For us: choosing between deterministic skill/playbook and free LLM maker, or between "run maker now" and "escalate/skip", should be gated on a *calibrated predicted success difference*, never on "the plan parses". | EXPERIMENTS H5 (hybrid predictive replanning) builds on H1. |
| M14 | Gate stack before execution: stage, dependency, syntax, whitelist (AST), vacuity, hopeless-retry skip, retry cap R = 3; retrieval-assisted numbers reported separately | **T** | Domain-independent gating hygiene. The rule "a number produced with retrieved/repaired code must be reported separately" maps to our fail-before-pass-after and evidence-provenance rules. | Existing gates + provenance DAG (inventory). Candidate port: a "hopeless retry" rule (same diff on same failing state means no retry). |
| M15 | Debug seeds vs locked one-shot validation seeds; scripts refuse reserved bands; "seeds are not scenes" dedup | **T** | Identical in spirit to gym holdouts. The new item is the *scene-collapse* check: duplicate holdout items silently inflate n. | Gym holdouts (inventory). Candidate port: dedup holdout items by content hash before counting. |
| M16 | Evosearch: K candidates × 10 debug seeds, stop at ≥8/10, 5 iterations, or BLOCKED with trace evidence; fall back to the incumbent if not better | **T** | Same as mutants + gates. The stop rules are well specified and cheap to compare against ours. | Gym mutants / gates (inventory). |
| M17 | Pretrained checkpoint (9.96 GB, 64-D bimanual action space, video latents) | **X** | Weight reuse is impossible in substance. The action space is 64-D end-effector/hand joints, observations are 3 × 224×320 RGB video, and the code vocabulary is robot skills. No layer maps to software traces. Licence chain also unclear (Cosmos-derived weights relabelled BSD-2). | — |
| M18 | Code expert body (SDAR-1.7B, Apache-2.0) as a small diffusion LLM | **X** (for now) | Usable on its own merits, but we already run larger local LLMs through Ollama/LiteLLM and have no need for diffusion decoding. | — |

## 2. Shared learned generative model vs modular predictor + planner

| Criterion | Shared generative model (AW-0 style) | Modular: planner (existing LLM/skills) + separate transition predictor |
|---|---|---|
| Training data needed | Millions of aligned (plan, outcome, action) tuples. AW-0 used 2.08 M slices, 2.9 k hours. | Hundreds of labelled (state, plan, outcome) rows for a calibrated classifier; zero for a prompted local LLM. |
| Our data | Order of 100 verified outcomes/month (directive; see CAPABILITY_INVENTORY for measured counts) | Enough for Brier-scored shadow evaluation within weeks (EXPERIMENTS sample sizes) |
| Compute | 48 H100 for pretraining; 8–24 H100 for post-training | Existing workstation Ollama; no training, or a CPU logistic regression |
| Failure isolation | Errors in any stream contaminate the others through shared attention | Each component scored separately (Brier for the predictor, verified rate for the planner) |
| Auditability (governance requirement) | Opaque joint latent | Each prediction is a logged record with inputs, model, timestamp and an outcome join |
| What AW-0's evidence actually supports | Joint > AR within one trained model (71.1 vs 54.5) | Plan-first ordering (C→V→A) and the need for an advantage-aware arbiter, both achievable modularly |
| Verdict | **Not needed; not affordable; not auditable** | **Chosen shape**: Architectures B, C, E in EXPERIMENTS.md |

The case for a joint model rests on shared representations learned from large aligned corpora. We have neither the corpus nor the training budget, and the AW-0 ablations do not show the joint model beating a *modular* pipeline. They only compare variants inside one jointly-trained model. Without a modular baseline, "joint is necessary" is unsupported even in robotics.

## 3. Architectural reuse vs weight reuse

| Level | Reusable? | Notes |
|---|---|---|
| Weights (checkpoint, experts) | **No** | 64-D robot action space and video frames have no counterpart in software traces. Fine-tuning would replace every input/output projection and leave a video DiT with nothing to predict. Licence chain unclear. Pickle format with `trust_remote_code` loaders. |
| Network architecture (MoT, masks, diffusion heads) | **No** | Only meaningful with joint training at scale (§2). |
| Pipeline architecture (plan → predict → act; arbitration; gates) | **Yes, as principles** | Implemented with existing components; see the matrix rows marked T. |
| Process/governance (coordinator, admission bar, frozen library, seed discipline, evosearch stops) | **Yes** | Mostly already present in DjimitFlo (CAPABILITY_INVENTORY). The deltas are small ports: failure taxonomy, hopeless-retry rule, holdout dedup. |

## 4. Domain gap, explicitly

| Robotics (AW-0) | DjimitFlo (software agents) | Consequence |
|---|---|---|
| Dense, fast feedback (30 Hz frames; episode in seconds or minutes) | Sparse, slow feedback (check results in minutes; merge in hours; 14-day survival) | Outcome labels are delayed and censored; a predictor must handle right-censoring (WORLD_MODEL §6). |
| Physics is stationary; the same scene gives the same dynamics | The repo, dependencies, CI and models drift weekly | A learned transition model goes stale. AW-0 itself collapses from 80.8 to 20.6 under visual shift. Recalibrate on a rolling window. |
| Observation is high-dimensional and fully visible each step | Observation is low-dimensional (check outcomes, diffs, logs), but key state is latent (true correctness, reviewer intent, flaky tests) | POMDP with partial observability over latent quality; WORLD_MODEL §3. |
| Actions are continuous and reversible in sim | Actions are discrete, sometimes irreversible (merge, deploy) and gated by approvals | Predictions must feed *gates*, never autonomous execution. Governance overrides. |
| Simulator available (RoboTwin) for unlimited rollouts | No faithful simulator. Gym tasks + mutants are a narrow, capped proxy | Sample sizes are the binding constraint (EXPERIMENTS). |
| Tools are deterministic given state | LLM tools are nondeterministic (temperature, model updates, provider routing) | The predictor must output distributions; replicate runs to estimate aleatoric variance. |

## 5. Findings

| # | CLAIM | SOURCE | VERIFIED EVIDENCE | UNCERTAINTY | DJIMIT RELEVANCE | EXPERIMENT | RESULT | DECISION |
|---|---|---|---|---|---|---|---|---|
| T1 | Weight reuse is impossible in substance | SOURCE_FORENSICS C1, K1–K4 | 64-D action/proprio, 3-camera 224×320 video, robot skill vocabulary | — | None | — | — | REJECT |
| T2 | A shared learned generative model is not needed; modular predictor + planner suffices | §2; paper has no modular baseline (R3) | Joint > AR only *within* one model (71.1 vs 54.5) | Untested in our domain | Choose the modular shape (Architectures C/E) | H1 → H3/H5 | Not run | Modular |
| T3 | Plan-first ordering transfers as a hypothesis | Paper Fig. 5 (C→V→A 71.1 vs V→C→A 48.3) | Robotics ablation, 3×16 rollouts/task | Out of domain; small n | Predictor must see the plan | H2 | Not run | ITERATE |
| T4 | Validity-only arbitration hurts; arbitrate on predicted advantage | Paper Table 1 (hybrid 63.1 vs 80.8 clean), J.2, L | Authors' own attribution | Confounded by different training data (J.2) | Any skill-vs-LLM or run-vs-defer switch needs a calibrated predictor | H3, H5 | Not run | Lesson adopted |
| T5 | AW-0's governance process (coordinator, admission bar, frozen library, seed bands, evosearch stops) largely exists in DjimitFlo already | SOURCE_FORENSICS C9/C10; CAPABILITY_INVENTORY I1–I4 | Gym holdouts, genome versioning, gates present | — | Small ports only: failure taxonomy, hopeless-retry, holdout dedup | X-DEDUP, X-RETRY | Not run | Ports gated per DECISION |
