# Soup (MakazhanAlpamys/Soup) — training backend decision

Evaluated 2026-10-09. Pinned HEAD `61e8c2bf` (main says 0.75.0); PyPI `soup-cli` 0.75.2 (wheel sha256 `ac8e97ca…`); the claimed v0.73.0 exists but is not current. Apache-2.0.

## Decision: REJECT as a DjimitFlo training backend (HOLD research only for layer streaming)

| Question | Answer |
| --- | --- |
| Missing capability it fills | None today: DjimitFlo has **no gold training data** (see the SOUP section of the plan / INTELLIGENCE_BASELINE.md: gym stores 0 diffs; prod 45 verified / 4 maker_failure; checker labels circular). The blocker is data, not a trainer. |
| Advantage over transformers + peft + trl | None for SFT / LoRA / DPO: Soup wraps `trl.SFTTrainer`, `trl.DPOTrainer`, `peft.get_peft_model`. Same task in the same sandbox: Soup YAML 20 lines vs plain script 22 lines. |
| Verified in sandbox (CPU, `--network none`) | SFT+LoRA (loss 3.17→0.79), DPO (0.69→0.14), adapter load changes output, merge (Δ 0.005), f16 GGUF conversion, bit-identical adapters with the same seed. |
| Failed | Quantized GGUF export (default q4_k_m / q8_0): `llama-quantize` not found → default `soup export` fails out of the box. |
| Unverified / absent | Layer streaming (own CUDA-only code, author benchmarks only, re-measurement "pending"); QLoRA, ORPO/SimPO/KTO (not run); **ROCm: no code path** — our main GPU (R9700, gfx1201) is AMD; Vulkan absent. Tests assert existence, not that loss decreases. |
| Security | `torch.load(weights_only=False)` on checkpoint resume (`utils/rl_checkpoint.py:409-410`); export clones llama.cpp by tag (not commit) and `pip install`s unpinned deps at runtime (`commands/export.py:552-613`); GRPO code rewards run model code with a Python-level network block. Good: `trust_remote_code` off by default, telemetry opt-in, no install hooks. |
| Supply chain | ~216k lines src + 375k tests, mostly AI-generated (558 commit bodies with Claude co-author trailers), one dominant maintainer, Alpha, 179 releases in 7 months, `trl<1` cap. |

## If a fine-tune becomes justified

Use transformers + peft + trl directly (already present in `~/openmythos/.venv` on the workstation's RTX 2060; torch-rocm still to be installed and tested for the R9700), with a commit-pinned, vendored llama.cpp for conversion. Precondition (pre-registered): ≥ 300 stored gym attempts (task, diff, oracle, prod_gates) over ≥ 200 tasks incl. ≥ 100 failures, split by source file, holdout ≥ 100 weighted to tiers 4–6, paired McNemar against the prompt-only baseline. `GYM_STORE_DIFFS` (#730) starts the dataset.

Reopen Soup only for a CUDA layer-streaming test on a real GPU, if a model too large for plain LoRA on the 2060 is ever needed.
