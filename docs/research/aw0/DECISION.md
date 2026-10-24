# AW-0 for DjimitFlo: decision

| Field | Value |
|---|---|
| Subject | Agentic World Action Models (AW-0), arXiv:2610.30136v1 · code `ZhuoyangLiu2005/agentic-wam` @ `7ad228be` · checkpoint `miniFranka/agentic-wam-pretrain-yamego3k-soup-e1` @ `603c59fd` |
| Directive | Operator L4: evaluate AW-0 for transfer to DjimitFlo software-agent orchestration. Source and runtime forensics only. |
| Status | Recommendation by the reviewing session. **Operator decision pending.** Nothing has been adopted, built, run, deployed or flagged. |
| Licences | Code BSD-2-Clause · checkpoint card BSD-2-Clause (Cosmos-derived video weights; licence chain unresolved) · paper CC BY 4.0 · frozen dependencies: Wan2.2 VAE, SDAR-1.7B and Qwen3-VL-2B are Apache-2.0; Cosmos-Reason1-7B and Cosmos-Predict2.5-2B are under the NVIDIA Open Model License |

## Headline

AW-0 is a robotics model. Every result in it is on robot manipulation (RoboTwin 2.0 plus 8 real-robot tasks). Its weights and its jointly trained architecture **do not transfer** to software agents.

- The action space is 64-D robot joints.
- The observations are video frames.
- Training needs H100-class CUDA hardware and millions of aligned samples.

DjimitFlo has about 192 completed maker leases a month, no CUDA training host, and no step-level trajectories.

Some of its **principles** do transfer:

- plan → predicted outcome → action ordering;
- a frozen, contract-checked, evidence-reused skill library;
- a coordinator that distills skills but cannot touch the verifier;
- one-shot locked holdouts with duplicate checks;
- AW-0's own negative lesson: **arbitrate on predicted advantage, not on validity**. Its validity-gated hybrid mode lost 17.7 pp in clean settings.

The one missing capability these principles point to is a **per-lease, pre-maker transition predictor**. DjimitFlo already has its substrate (judgment-service plus the local System One on the RTX 2060) and its scoring (forecastScoresV2). It can be tested offline at $0 without a WIP slot.

## Per-component decisions

| Component | Decision | Reason |
|---|---|---|
| AW-0 checkpoint / weights (any reuse, download, fine-tune) | **REJECT** | No mapping from 64-D robot actions or video to software traces. 9.96 GB untrusted pickle, `trust_remote_code` loaders, CUDA-only. Does not fit RTX 2060 or VPS; R9700 has no tested ROCm path. Licence chain unclear. (FEASIBILITY O1; TRANSFERABILITY M17) |
| AW-0 code (install, run, vendor) | **REJECT** | Nothing in it applies to our domain. It also runs `exec` on generated code inside the process, and has a CUDA, DeepSpeed and simulator stack. Read-only review is complete and the clone was deleted. |
| Joint generative architecture (MoT, masked diffusion, flow matching): **Architecture D** | **REJECT for now** | Data volume is orders of magnitude short. The Soup fine-tune precondition is not shown to be met. The paper has no modular baseline, so even in robotics "joint is necessary" is not supported. Reopen only if: the Soup precondition is met, **and** H1 shows learnable signal, **and** a CUDA training host exists. |
| Plan → predict → act ordering (C → V → A) | **GO as a design rule** · **ITERATE** its value via H2 | Costs nothing to state. The robotics ablation is strong (71.1 vs 48.3) but out of domain, so measure the predictor gain from plan-conditioning (H2). |
| Per-lease shadow transition predictor (**H0 → H1**, offline) | **GO** | Smallest experiment with the highest information gain. $0. No new model, service, flag or prod write. No WIP slot needed. It must beat the existing base-rate forecaster and the effort-controller posterior, so it does not duplicate them. |
| Prospective shadow predictor (H1b) | **HOLD** | Needs a WIP slot (none free) and H1 = GO. |
| Predictor-gated defer/escalate: **Architecture C** (H3, offline counterfactual) | **ITERATE** (after H1) | The counterfactual of skipping a run is identified from logs. Allowed to defer or escalate only; never approve, merge or promote (NE-001 scope, `EFFORT_FLOOR`). |
| Hybrid predictive replanning: **Architecture E** (H5) | **HOLD** | Needs H1 = GO and ≥ 140 paired operator outcomes. Only 42 rebuildable items exist. MFR-001 shows operators can hurt. |
| Planner + skills: **Architecture B** | **No new work.** Await the epoch-1 playbook-gene readout. | Already under test (`g-d14c1156`). Do not duplicate. |
| Coordinator failure taxonomy and admission bar for skill distillation | **HOLD** | Good rule, but skill cards are record-only and `skill_version` is NULL on every outcome. Bind versions and get cards consumed first, or the rule has nothing to act on. |
| Holdout duplicate audit (**X-DEDUP**, "seeds are not scenes") | **GO** (read-only) | Cheap. Protects the epoch-1 trial's power claim. |
| Hopeless-retry count (**X-RETRY**) | **ITERATE** | Read-only count first. Prod diff-hash availability is uncertain. |
| Environment pre-flight as a "simulator" baseline (O5) | **ITERATE** as the B3 baseline inside H1; prospective use **HOLD** | Real sandboxed execution is evidence; LLM simulation is not (NE-010). 39–49 % of non-verified outcomes are environment failures. |
| Tabular transition model (O3) | **GO** as baseline B2 inside H1 | If logistic regression on lease features matches the LLM, keep only the regression. |
| Local LLM fine-tune / LoRA predictor | **HOLD** | Soup precondition applies. Revisit after H1. |

## Ranked next steps, by expected information gain per unit cost

Information gain is judged by how many downstream decisions (C, E, D, H1b, H2) a result settles. Cost includes WIP-slot use.

1. **H0 census.** Read-only count of maker leases with stored checks and reconstructable pre-dispatch context. It decides whether H1 can run offline at all, and at what power. Cost: one query.
2. **H1 offline shadow transition predictor.** Local System One vs B0 base rate, B1 EP posterior, B2 logistic, and B3 environment proxy. Brier skill with the V2 statistics. One result decides the C, E, H1b and H2 branches and bounds D. Cost: $0, RTX 2060 time, one protocol PR and one result PR.
3. **X-DEDUP holdout audit.** Directly affects the trustworthiness of the running epoch-1 trial. Cost: one query.
4. **H2 plan-conditioning delta.** Same replay as H1, so it adds little cost. Probably underpowered, so report it as an estimate.
5. **H3 offline defer/escalate counterfactual.** Only if H1 = GO.
6. **X-RETRY count.** Small, independent token-saving lead.
7. Then, in order of availability: the epoch-1 readout (B); H1b when a WIP slot frees; H5 once ≥ 140 paired operator items exist. D stays rejected.

### The single smallest next experiment

**H1: a shadow transition predictor.** The existing local System One (Qwen3.6-35B-A3B on the RTX 2060), given only context recorded before a maker lease starts, outputs P(all deterministic checks pass). It is scored offline on historical leases by Brier skill against the trailing base rate and the effort-controller posterior, using forecastScoresV2's statistics.

- **GO** to prospective shadow if decision-grade.
- **REJECT** and register a negative-evidence entry if BSS ≤ 0 at n ≥ 250.

The H0 census runs first.

## Suggested registry follow-up (operator decision)

A negative-evidence entry for **AW-0 weight or architecture reuse** (REJECT, documentation only), with the reopen conditions given under Architecture D above. It is not added here; registry entries carry the operator's decision.

## Findings

| # | CLAIM | SOURCE | VERIFIED EVIDENCE | UNCERTAINTY | DJIMIT RELEVANCE | EXPERIMENT | RESULT | DECISION |
|---|---|---|---|---|---|---|---|---|
| D1 | AW-0's evidence is robotics-only | Paper §3, Tables 1–2; repo scope | No software-agent result anywhere | — | All transfer is by analogy | — | — | Treat as hypothesis source only |
| D2 | Weights, code and the joint architecture do not transfer | SOURCE_FORENSICS; TRANSFERABILITY M2, M4, M5, M17; FEASIBILITY F1 | See those files | Inferred VRAM | None | — | — | REJECT |
| D3 | The highest-value transferable idea is a calibrated pre-action outcome predictor used for arbitration | Paper J.2, L; CAPABILITY_INVENTORY I7 | AW-0 lost 17.7 pp without it; DjimitFlo has none | Signal may be absent in our data | Decides C/E | H0 → H1 | Not run | GO (offline) |
| D4 | Most AW-0 process mechanisms already exist in DjimitFlo | CAPABILITY_INVENTORY I1–I4, I15–I17 | Spot-checked on `2a0bff5b` | — | Small ports only | X-DEDUP, X-RETRY | Not run | GO / ITERATE |
