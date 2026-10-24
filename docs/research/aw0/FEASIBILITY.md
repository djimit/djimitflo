# AW-0 feasibility on DjimitFlo hardware

Hardware facts come from existing documents. No host was logged into.

| Host | Measured facts | Source |
|---|---|---|
| Workstation (100.81.133.48) | 48 threads, 125 GB RAM (95 free), **AMD Radeon AI PRO R9700 32 GB (gfx1201)** + **NVIDIA RTX 2060 SUPER 8 GB**, rootless docker, 135 GB free disk. llama-router serves gpt-oss-120b, qwen36-a3b, qwen38-27b. Model-fit rule: "≤ ~32B dense Q4 or MoE A3B". GPU energy 13.5 kWh/30 d at 38 % coverage. The R9700 is shared by the gym, the remote maker and offline experiments, and contention has been observed. The RTX 2060 runs the local System One (Qwen3.6-35B-A3B, llama.cpp Vulkan, experts in RAM). | Operator plan lines 600-604 (measured 27-09), 625, 633, 331; `scripts/local-systemone.mjs:4-9`; L3-v2 |
| ROCm status on R9700 | "ROCm: no code path" in Soup; torch-rocm "still to be installed and tested for the R9700". transformers + peft + trl present in `~/openmythos/.venv` on the RTX 2060. | `docs/research/soup/SOUP_DECISION.md:13, 19` |
| VPS agentical (100.86.47.122) | 2 cores / 7 GB, no GPU. Runs every maker, checker, mutation and VPS-gym worker. | Operator plan lines 600-604 |
| agenticservices (100.77.58.72) | Small Ollama models + cloud aliases | `reference_inference_inventory` (13-09) |

AW-0 requirements, all from [SOURCE_FORENSICS.md](SOURCE_FORENSICS.md):

- **Checkpoint:** 9.96 GB pickled `.pt`. Probably bf16 (inferred), about 5 B stored tensors.
- **Frozen dependencies:** about 11.1 GB (Wan2.2 VAE 2.82 GB, SDAR-1.7B 4.06 GB, Qwen3-VL-2B 4.26 GB). The full inference stack is about 21 GB on disk, plus 16.6 GB for Cosmos-Reason1-7B if new instructions must be embedded.
- **Software stack:** CUDA only (`torch==2.7.1+cu128`, flash-attention, DeepSpeed, cuRobo for the simulator).
- **Training:** H100-class GPUs. Pretraining used 48 H100. Post-training uses 8–24 GPUs.
- **Inference:** latency was measured on an RTX 5090 (32 GB). Inferred VRAM floor is ≥ 16–24 GB.

## 1. Can AW-0 itself run here?

| Host | Inference of the released checkpoint | Post-training | Verdict |
|---|---|---|---|
| R9700 32 GB (ROCm) | Memory: plausible (similar to the 5090 class). Stack: **no** CUDA wheel, no flash-attn CUDA kernels, DeepSpeed/accelerate untested on gfx1201, torch-rocm not installed (SOUP_DECISION). It would mean porting kernels on a shared, contended GPU. | No. A single 32 GB card cannot hold fp32 master weights + Adam for about 3.3–5 B trainable params (≈ 16 bytes/param, so about 50–80 GB, inferred); the repo's "~90 GB" optimizer state confirms the scale. | **Not feasible without a ROCm port. Not worth one.** |
| RTX 2060 SUPER 8 GB (CUDA) | No. 21 GB of weights against 8 GB of VRAM; even the 9.96 GB checkpoint alone does not fit. CPU offload at video-diffusion sizes would take minutes per step, if it works at all. | No | **Infeasible** |
| VPS 2 cores / 7 GB | No GPU; 7 GB RAM is below the checkpoint size. | No | **Infeasible** |
| Any host, as a *software-agent* model | Even if it ran, it would predict robot video and 64-D joint actions. There is nothing to feed it from DjimitFlo (TRANSFERABILITY §3). | — | **Pointless** |

Running the code was also out of scope under this review's hard limits: no execution, no weights download. Beyond those limits, loading needs `torch.load` on an untrusted pickle and `trust_remote_code=True` for SDAR. If anyone revisited this, it could only happen in a network-less throwaway sandbox (cf. `feedback_no_branch_code_in_prod_container`).

## 2. The five options

| # | Option | What it would be for DjimitFlo | Compute / host | Data needed vs available | Governance / risk | Prior negative evidence | Cost | Verdict |
|---|---|---|---|---|---|---|---|---|
| O1 | **Direct adaptation** of AW-0 (load checkpoint, replace projections, fine-tune on software traces) | Re-purpose the MoT: code expert generates plans, the "video" expert predicts check vectors, the action head emits… nothing meaningful (diffs are discrete text) | Needs CUDA H100-class GPUs. None on our hosts (§1). | Needs ~10⁵–10⁶ aligned (plan, outcome, action) samples. We have ≈ 192 completed maker leases per month and no step-level trajectories. Soup precondition (≥ 300 gym attempts / ≥ 200 tasks / ≥ 100 failures / holdout ≥ 100) not shown to be met. | Opaque joint latent; pickle + remote code; unclear licence on Cosmos-derived weights | NE-006 (Soup fine-tune REJECT) and its precondition apply | High (hardware we do not have) | **REJECT** |
| O2 | **Distillation of principles** (no model) | Port process rules: plan → predict → act ordering; coordinator failure taxonomy and admission bar; hopeless-retry rule; holdout scene-dedup; advantage-based (not validity-based) arbitration | None | None beyond existing records | Pure documentation and small rule changes, each behind existing review | — | ≈ 0 | **GO** (documented here; individual ports gated per DECISION) |
| O3 | **Small domain transition model** (tabular: logistic regression / gradient boosting on lease features; later perhaps a LoRA-tuned small LM) | P(checks pass \| lane, runtime@model, genome, task kind, #target files, retry_attempt, recent base rate) | CPU on any host. A LoRA small LM would go on the RTX 2060 venv. | Tabular: works with a few hundred labelled leases (≈ 1–3 months of history; census needed). LoRA: Soup precondition applies. | Fully auditable coefficients | — | ≈ 0 (tabular) | **GO as a comparator inside H1**; LoRA variant HOLD |
| O4 | **Existing local LLM with structured prediction** | judgment-service typed `noul` question → local System One (Qwen3.6-35B-A3B on RTX 2060) → p from top logprobs, written as shadow `judgments`, scored by forecastScoresV2-style Brier | Already running code on the RTX 2060 (last documented trial 28-09). Does not touch the contended R9700. | Zero training data. Scoring needs n ≥ 100 with ≥ 10 positives (V2 rule). | Shadow-only, below `EFFORT_FLOOR`. NE-001 forbids using jev-style routing for approval/promotion. A *forecast* is allowed; a *gate* needs a separate decision. | NE-001, NE-005 (specific routing uses, not forecasting) | $0, about one token per question | **GO (smallest first experiment, H1)** |
| O5 | **Simulator baseline** (execution, not learning) | Before dispatching a maker, run a cheap pre-flight in the existing sandbox: does the parent build, and do the target package's tests pass? Most environment failures (38.8–48.6 % of non-verified outcomes) would show up here. | Gym docker runner / settlement throwaway worktree on the workstation; seconds to minutes per item | No training data. Offline proxy: the historical `environment_failure` share is an upper bound on what pre-flight can catch. | Real execution is evidence; an LLM "simulation" is not (NE-010). A prospective pre-flight is a new runtime step, so it needs a WIP slot or approval. | NE-010 rejects *LLM simulation*, not sandboxed execution | Low compute; adds latency per lease | **ITERATE**: use as a baseline in H1 offline; prospective use HOLD (no WIP slot) |

## 3. Why O4 + O3 + O5 together are the right shape

- O4 answers the only question that matters before any architecture work: **is there predictable signal about the next observation, beyond the base rates we already have?**
- O3 is the cheap non-LLM control. If a logistic regression on tabular lease features matches the LLM, the LLM adds nothing.
- O5 is the execution control. If a pre-flight explains most of the predictable variance, no predictor is needed for that share.

All three run offline on existing records, need no new service, no flag change and no WIP slot. They use the RTX 2060 and CPU and leave the contended R9700 alone. O1 is ruled out on hardware alone, before data or relevance are even considered.

## 4. Findings

| # | CLAIM | SOURCE | VERIFIED EVIDENCE | UNCERTAINTY | DJIMIT RELEVANCE | EXPERIMENT | RESULT | DECISION |
|---|---|---|---|---|---|---|---|---|
| F1 | AW-0 cannot run on any DjimitFlo host as released | §1; SOURCE_FORENSICS K1–K4; SOUP_DECISION.md:13, 19 | CUDA-only pins; 21 GB stack; 8 GB / 7 GB hosts too small; R9700 has no tested ROCm path | Inference VRAM is inferred, not measured | Rules out O1 | None (no execution permitted) | — | REJECT O1 |
| F2 | The local System One is a $0 substrate for structured prediction that avoids the contended R9700 | local-systemone.mjs:4-9; plan line 1783 (trial 28-09) | Logprob label distribution over single-token answers | Current uptime UNKNOWN | H1 runs without new services | H1 | Not run | GO O4 |
| F3 | Real sandboxed execution can observe the environment-failure share | gym runner, settlement worktree; attribution 38.8–48.6 % | Sandboxes exist | Prospective use needs a slot | B3 baseline | H1 (B3) | Not run | ITERATE O5 |
| F4 | A learned fine-tuned predictor is gated by the Soup precondition | SOUP_DECISION.md:19 | Precondition text | Whether it is met: UNKNOWN (`gym_attempt_diffs` count) | Gates O3-LoRA and D | H0 (count) | Not run | HOLD |
