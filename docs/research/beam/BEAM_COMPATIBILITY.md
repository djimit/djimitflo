# BEAM-001 Phase 2: Beam technical facts and schema compatibility

**Date:** 2026-10-21. **Scope:** read-only. I made 9 model calls with synthetic content (limit 10) plus 1 opencode attempt that was rejected before any model call. I changed no config, flag, DB row or file in prod.

**Tags:** FACT = observed by me or read from a primary source as quoted; VENDOR_CLAIM = stated by Reflection or Ollama and not reproduced here; INFERENCE = follows from facts; UNKNOWN = not established.

## 1. Verdict

- **FACT: Beam is reachable on our Ollama Cloud account.** I made authenticated `POST https://ollama.com/v1/chat/completions` calls with the prod key (`SOCIAL_COMPAT_API_KEY`) and got HTTP 200 answers. The agenticservices Ollama proxy that opencode uses (`OLLAMA_URL`, `/v1` and `/api/chat`) also served `beam:cloud`. I did not take the model list as proof of access: `GET https://ollama.com/api/tags` returns the same 23 models with and without auth.
- **FACT: opencode in prod cannot address Beam today.** `opencode run --model ollama/beam:cloud` fails with `ProviderModelNotFoundError: Model not found: ollama/beam:cloud`, before any model call. The fix is a config change (§5), so I did not run it.
- **INFERENCE: on raw API semantics, Beam is a drop-in candidate for the opencode maker, checker and security-checker roles.** Plain chat, JSON-only, OpenAI-format tool calls with a round trip, and streaming all worked. What we do not know is how it behaves inside a multi-step opencode tool loop, and whether reasoning effort can be controlled through opencode.

## 2. Source facts

| Item | Value | Tag | Source |
|---|---|---|---|
| Model | Beam 1.0, 501B total / 23B active, sparse MoE, 256 experts, 8 per token, 52 layers (3 dense + 49 MoE), gated GQA + sliding window (512) interleaved with full attention (every 6th layer) | FACT (config.json) | HF `reflection/Beam-1.0-501B-A23B` config.json; Ollama library page |
| Context | 1M (`max_position_embeddings` 1 048 576; Ollama `/api/show` `beam.context_length` 1 048 576) | FACT | config.json, `/api/show` |
| Weights / format | safetensors BF16 (188 shards, 1.00 TB stored), FP8, NVFP4, plus a DFlash2 speculative drafter; HF sha 78f8f654, last modified 2026-10-16 | FACT | HF API |
| Licence | Apache-2.0 (LICENSE file is the Apache 2.0 text). The model card says Reflection "does not prohibit distillation, use of outputs to train other models, fine-tuning …" and points to a separate Usage Policy, which I did not read | FACT; Usage Policy UNKNOWN | HF LICENSE, model card |
| Chat template | "Modified Harmony": channels `analysis` and `final`, **no `commentary` channel**, tool-call bodies are XML (`<\|constrain\|>xml`). It is not byte-compatible with gpt-oss Harmony | FACT | chat_template.jinja header |
| Reasoning effort | Template kwarg `reasoning_effort`: an int, or `minimal 8 / low 32 / medium 64 / high 128 / xhigh 256 / max 512`. **Default when unset: 512 (`max`).** Ollama `/api/show`: `thinking.values` low, medium, high, xhigh, max; default `max` | FACT | chat_template.jinja:11-12, 282-293; `/api/show` |
| Knowledge cutoff | 2026-06-30 | VENDOR_CLAIM | model card |
| Benchmarks | Terminal Bench 2.1 80.1 (GLM 5.2 81.0, Kimi K3 88.3); SWE-Bench Verified 80.9–81.6; SWE Bench Pro v2-Hard 76.5–78.6; MCP Atlas 78.7–81.5 | VENDOR_CLAIM | blog (10-05, updated 10-08), model card |
| Efficiency | "comparable to GLM-5.2 while using 3–4× less inference compute" on reasoning benchmarks. "~3x fewer inference-time reasoning tokens". FLOPs are estimated as 2 × active params × generated tokens, prefill excluded | VENDOR_CLAIM | blog, model card |
| Safety | Iris: harmful refusal/pivot 88.5–89.7 %, harmless compliance 81.5–82.1 % (~18 % over-refusal on harmless prompts) | VENDOR_CLAIM | model card |
| Ollama tag | `beam:cloud`, tag digest `84a1b11bb377` (library tags page). The catalog `/api/tags` lists `beam` with digest `f32ced497c69`, modified 2026-10-16T06:00-07:00, size 0. Only a cloud tag exists, no local tag | FACT | ollama.com/library/beam/tags, `/api/tags` |
| Ollama capabilities | `completion`, `thinking`, `tools`; text only | FACT | `/api/show` |
| Ollama price | **Not in the Ollama pricing table** (glm-5.2 is $1.40 in / $0.26 cached / $4.40 out per M; gemma4 $0.14 / $0.05 / $0.40). The library labels Beam "Low Usage", and the page does not define the term | FACT (absence); meaning UNKNOWN | ollama.com/pricing, library page |
| Our plan | Legacy Ollama Max with session and weekly limits. The weekly limit was hit on 18-10. New plans are monthly $ credits | FACT (plan 18-10) | usage-limits-research.md |
| Third-party prices | OpenRouter $0.25/$1.00, Together $0.40/$1.20 per M (search snippets). Reflection API is a "free to start" beta with no published rates | UNVERIFIED (secondary) | web search 21-10 |
| Data handling (Ollama Cloud) | "process your prompts and responses transiently … not stored beyond the time required … do not use your inputs or outputs to train". Whether Ollama serves Beam itself or forwards it to Reflection or a partner: **UNKNOWN** | VENDOR_CLAIM; host UNKNOWN | ollama.com/privacy (Mar 2026), docs.ollama.com/cloud |
| Local feasibility | NVFP4 is ~0.25–0.3 TB of weights. The workstation (R9700 32 GB + RTX 2060 8 GB, 125 GB RAM) cannot hold it, and the VPS must never call the workstation anyway | INFERENCE | HF sizes; reference_inference_inventory |

## 3. Probe calls (synthetic content only, from the prod container's existing config)

Path A = `https://ollama.com/v1/chat/completions` with the prod key, model `beam`. Path P = agenticservices proxy `OLLAMA_URL`, model `beam:cloud`, no key; this is the same host opencode uses. Every call returned `model: "beam"`.

| # | Test | Path | Result | prompt / completion tokens | latency |
|---|---|---|---|---|---|
| 1 | plain chat ("17 × 23, number only"), effort unset | A | `391`, finish `stop`, `reasoning` field 113 chars | 62 / 69 | 1.2 s |
| 2 | same, `reasoning_effort: "low"` | A | `391` | 60 / 55 | 0.7 s |
| 3 | JSON only (`response_format: json_object`) | A | valid JSON object, correct verdict (`reject` for add() returning a−b) | 89 / 144 | 1.0 s |
| 4 | tool call, OpenAI `tools` + `tool_choice: auto` | A | finish `tool_calls`, `get_temperature({"city":"Zorbania"})`, id `call_…` | 94 / 65 | 0.6 s |
| 5 | tool result round trip (`role: tool`, `tool_call_id`) | A | "The temperature in Zorbania is 21°C." Cached prompt tokens 64 reported | 144 / 33 | 0.5 s |
| 6 | native `/api/chat`, `stream: true`, `think: "low"` | P | 17 NDJSON chunks, `thinking` streamed separately (218 chars), answer `Red`, `prompt_eval_count` / `eval_count` present | 52 / 67 | 0.5 s |
| 7 | tool call, effort unset | P (`/v1`) | finish `tool_calls`, same correct call | 96 / 44 | 0.5 s |
| 8 | synthetic code review, JSON only, effort unset | A | `bug: true, line 2` (lexicographic sort + mutation), valid JSON | 143 / 267 | 1.2 s |
| 9 | same, `reasoning_effort: "low"` | A | same verdict, valid JSON | 141 / 343 | 1.4 s |
| — | `opencode run --model ollama/beam:cloud` (throwaway dir, temp XDG dirs) | opencode → P | `ProviderModelNotFoundError`, **no model call** | 0 | — |

**Total: 9 model calls, 1 968 tokens** (sum of reported prompt + completion). No repo, prod or private data was sent.

Findings:
- **FACT:** all four schema contracts we depend on work through Ollama's translation layer: OpenAI chat, `json_object`, OpenAI tool calls and tool results, and native streaming with a separate thinking channel. The Harmony/XML tool syntax never reached the client, because Ollama converts it to OpenAI `tool_calls`.
- **FACT:** token accounting is reported in OpenAI `usage`, including `prompt_tokens_details.cached_tokens`, and in native `prompt_eval_count`/`eval_count`. `completion_tokens` includes reasoning tokens. Reasoning text comes back in `message.reasoning` (OpenAI path) or `message.thinking` (native path).
- **INFERENCE (n = 1 pair each, weak):** `reasoning_effort: "low"` on the OpenAI path did not reduce completion tokens (55 vs 69, then 343 vs 267). Ollama may be ignoring the OpenAI-path field and serving the template default `max`. **UNKNOWN** until tested at n ≥ 20. The native `think: "low"` is accepted. Whether it changes token use is also UNKNOWN.
- **FACT:** latency was 0.5–1.4 s for short prompts. Throughput on maker-sized contexts (30–70 k uncached input per step) was not measured: UNKNOWN.
- **UNKNOWN:** rate limits and session/weekly-limit weight for Beam on our legacy plan. "Low Usage" is the only vendor signal.

## 4. Fit with how Djimitflo calls models today

| Consumer | How it calls | Beam fit | Tag |
|---|---|---|---|
| opencode maker / checker / security checker | `opencode run --model $DJIMITFLO_OPENCODE_MODEL` (runtime-command-service.ts:101-107) → `@ai-sdk/openai-compatible` → proxy `/v1` | API compatible (probes 4/5/7). Needs registration in `/app/opencode.json`. The executor never passes `--variant` (opencode-executor.ts:11 documents it, and runtime-command-service.ts does not set it), so Beam would run at its default `max` effort | FACT |
| Execution engine `reasoningEffort` | Validated (execution-engine.ts:648-670) but only used by the codex executor (codex-executor.ts:202-205) | Would need wiring to opencode `--variant` for an A2 arm, which means a code change | FACT |
| llm-fallback | native `/api/generate` with `think: false`, `format: json` (llm-fallback.ts:63-64) | `think: false` is not in Beam's `thinking.values` (no "off" level). Behaviour UNKNOWN | FACT / UNKNOWN |
| model-json parser | strips `<think>` blocks (model-json.ts:6-14) | Beam reasoning arrives in a separate field on both paths (probes 1–9), so the content is clean | FACT |
| Panel / council / residents | Ollama proxy or `SOCIAL_COMPAT_BASE_URL` | Compatible. No value case (see SUBSTITUTION_MATRIX) | FACT / INFERENCE |

## 5. Config that would be needed (not applied)

To let opencode address Beam, add `"beam:cloud": {"name": "Beam Cloud"}` under `provider.ollama.models` in `/srv/djimitflo/opencode.json` (host bind mount, backed up as `opencode.json.bak-<ts>`, same pattern as the gemma4 registration on 17-10). This is a prod config change, so it needs an operator decision. It should not be applied for an experiment: the experiment design (EXPERIMENT_PROPOSAL.md) mounts a separate opencode.json read-only into a throwaway container, so prod never sees Beam. Reasoning-effort control in opencode (`--variant`) for the openai-compatible provider is UNKNOWN and must be checked in the same throwaway container before any A2 arm.

## 6. Appendix: prod queries used (read-only)

All queries ran as `docker exec -e NODE_PATH=/app/node_modules djimitflo-live node -` against `/data/djimitflo.sqlite` opened `{readonly: true}`:
- `worker_leases` grouped by role, effective runtime/model and status, with `metadata.runtime_usage`, `timed_out`, `exit_status` and `verdict`, for 7 d and 30 d;
- `skill_outcomes` `loop-maker:%` per day;
- `self_improvements` by source and status;
- `loop_runs` `pr_url` / `pr_outcome` / `auto_merge`;
- `llm_model_calls` by model and purpose;
- the gym holdout tables.

Env: non-secret flag values only. Key and token variables were listed by name.
