# NE-014 — AW-0 checkpoint / joint model reuse for software agents

**Verdict:** REJECT · **Decided:** 2026-10-24 · **Evidence class:** read-only review of paper, source and Hugging Face metadata (PR #998). Nothing was downloaded, installed or run.

## Hypothesis

Reusing the AW-0 (Agentic World Action Models) checkpoint, its code, or its jointly trained generative architecture improves Djimitflo's software-agent orchestration: maker planning, outcome prediction or action choice.

## Subject (pinned)

| Item | Pin | Licence |
|---|---|---|
| Paper | arXiv:2610.30136v1 | CC BY 4.0 |
| Code | `ZhuoyangLiu2005/agentic-wam` @ `7ad228be` | BSD-2-Clause |
| Checkpoint | `miniFranka/agentic-wam-pretrain-yamego3k-soup-e1` @ `603c59fd` | Card says BSD-2-Clause. The video expert derives from NVIDIA Cosmos-Predict2.5-2B (NVIDIA Open Model License). The licence chain is unresolved. |

## Findings (from PR #998)

| # | Finding | Source in #998 |
|---|---|---|
| A | The action space is 64-D robot joints and the observations are video frames. Nothing maps to code edits, tool calls or check results. | DECISION, TRANSFERABILITY M2/M4/M5/M17 |
| B | The full inference stack is about 21 GB on disk (a 9.96 GB pickled `.pt` plus frozen Wan2.2 VAE, SDAR-1.7B and Qwen3-VL-2B). It is CUDA-only. Pretraining took 48 H100s and 115,213 steps. No Djimitflo host fits it (8 GB RTX 2060, CPU VPS; the R9700 has no tested ROCm path). | FEASIBILITY F1, SOURCE_FORENSICS K1–K4, C7 |
| C | Licence chain: a weight derivative of an NVIDIA-Open-Model-Licensed model is published as BSD-2-Clause. | SOURCE_FORENSICS licence table |
| D | Data scale: the model trains on 2.08 M subtask slices (248,642 episodes). Djimitflo has about 192 completed maker leases per 30 days (#998). The H0 census (2026-10-24) counts 364 terminal maker leases with a check or runtime outcome in 30 days. That is four orders of magnitude short. | SOURCE_FORENSICS P8, EXPERIMENTS §0, [H0_CENSUS.md](../aw0/H0_CENSUS.md) |
| E | The paper has no modular baseline (a separate predictor plus planner). Its 71.1 vs 54.5 comparison is inside one model. So even in robotics, "joint is necessary" is not shown. | EXPERIMENTS H6 |

## What is not rejected

The **principles** are separate and stay open: plan → predict → act ordering, and arbitration on predicted advantage instead of validity. The transferable piece is a calibrated pre-action outcome predictor. That predictor needs no AW-0 artefact and is designed as the code-only H1 in [H0_CENSUS.md](../aw0/H0_CENSUS.md). jev is never used for it (NE-001 scope; jev is not used for code, approval, promotion, risk or fitness judgments).

## Guard

`forbidden_code_patterns`: `miniFranka/agentic-wam` and `ZhuoyangLiu2005/agentic-wam`. These are the Hugging Face and GitHub ids. They may not appear in server or dashboard source, package manifests or agent/MCP settings (`packages/server/src/__tests__/negative-evidence.test.ts`). `match_terms`: `agentic-wam`. "AW-0" is deliberately not a match term, because the allowed H1 work refers to it.

## Reopen condition

Either of these:

- **(a)** A pre-registered comparison on Djimitflo tasks, with a frozen holdout, in which a joint model beats a modular predictor plus planner at matched compute and token budget.
- **(b)** A software-domain world-action-model checkpoint (actions are code edits or tool calls, observations are repository and check state) under a permissive licence with a resolved licence chain.

Either one permits a new pre-registered evaluation, not adoption.
