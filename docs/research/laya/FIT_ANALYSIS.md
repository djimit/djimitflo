# Laya — fit analysis for DjimitFlo and the Djimit ecosystem

Analysed 2026-10-26. Read-only: nothing installed, no weights downloaded, no Laya code run, no prod query.
**The decision stands: Laya = DEFER. jev stays the only System One backend for DjimitFlo decisions (operator, 2026-10-26).**
This document maps where Laya *could* add value and what evidence would be needed. It does not reopen that decision.

## 0. Pinned sources

| Source | Pin | Licence | How it was read |
| --- | --- | --- | --- |
| github.com/NandhaKishorM/laya | `a478221bcad24d1a9c47b361c79328ebd2b100c6` (2026-10-25, "release: 0.4.16"; repo created 2026-09-18) | Apache-2.0 (`LICENSE`, `pyproject.toml`) | shallow clone in scratch, read, deleted |
| PyPI `laya` | latest 0.4.15 (2026-10-24); 0.4.16 is not on PyPI yet | Apache-2.0 | JSON API metadata only |
| HF `convaiinnovations/laya` (bundle) | HEAD `7b928d828b7b0e022f929d9bd2e44165aa270148` (2026-10-03); the loader's opt-in reviewed pin is `55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851` | apache-2.0, not gated | HF API file list + small config/model-card files; **no weights** |
| HF `laya-multilingual` / `laya-typed-decisions` | `1720e3e3…` / `e929ae5c…` | apache-2.0 | HF API metadata |
| github.com/wdobry/laya-playground | `5a825ba0472a460830bc937907d43262a87410f8` (2026-09-20) | MIT | GitHub API + `README.md` + `static/data/versus.json` |
| brainfunctioncollapse.com/laya skill doc | `SKILL.md` v1.1, 12.9 KB (scratch copy, sha16 `19b070fa`) | — | read; **not installed** (operator decision 26-10) |

Weight artefacts (HF API, LFS sha256; identical at the reviewed pin and at HEAD):

| File | Bytes | sha256 |
| --- | --- | --- |
| `model.safetensors` (English) | 842 609 210 | `891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c` |
| `multilingual/model.safetensors` | 643 835 514 | `9d628fd971b700382ac6f65920a86f149777b2e748e0c955fb3b19695aa8f204` |
| `typed-decisions/model.safetensors` | 842 609 220 | `4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e` |
| `multilingual/tokenizer/tokenizer.json` | 34 363 188 | `609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f` |

No `.bin`, `.pt`, `.pkl` or `.ckpt` file exists in the HF repo. It does hold three loose Python files (`rl_agent_api.py`, `rl_common.py`, `email_utils.py`). The package loader never fetches them, because `allow_patterns` limits a download to config, safetensors, tokenizer and encoder files.

Legend: **SV** = SOURCE_VERIFIED (read in code, config or the HF API at the pin) · **VC** = VENDOR_CLAIM (README, docs, model card, or a result file we did not reproduce, third-party runs included) · **UK** = UNKNOWN.

## 1. What Laya is, verified from source

| Topic | Finding | Mark |
| --- | --- | --- |
| Model | `DecisionModel` (`laya/common.py:575`): a bidirectional encoder, then `type_emb` (3 types), a 2-layer `nn.TransformerEncoder` head, and one `scorer` MLP that turns the hidden state at each option marker into a logit. There is also an `act_head` (act or escalate). Non-generative: one forward pass, softmax over options. | SV |
| Checkpoints | English: `answerdotai/ModernBERT-large`, `max_len` 512, `head_max_len` 192. Multilingual: `jhu-clsp/mmBERT-base`, 1024 / 256. Typed-decisions: ModernBERT-large, 1024 / 256 (`rl_agent_config.json` at the pin). Parameter counts of 421M / 322M are from the README. | SV / VC |
| Heads | `choice` (options are criteria keys), `score` (ordered levels; `score` = expected level), `noul` (P(true)). Same three types as jev. | SV |
| Token limits | Each option description is capped at 48 tokens (`common.py:243-250`). All options share `head_max_len` (192 or 256 tokens). The state gets `max_len − head_len − 1` tokens and is cut from the end. The multilingual encoder can run to 8 192 tokens with `max_len=8192`. Above about `head_max_len/4` options the head outgrows its cap, and Banking77 at 77 labels drops to 0.425. | SV (limits) / VC (accuracy) |
| Calibration | Temperatures per type and per (type, option-count) bucket, clamped to [0.5, 5.0] at load. `calibrate.py` fits them with LBFGS NLL, with a bucket floor of `MIN_BUCKET_N = 2000` and a type floor of `MIN_TYPE_N = 10`. **The multilingual checkpoint ships no temperatures** (`[1,1,1]`, `{}`). The English bucket `choice:11+ = 0.10` would sharpen, so the load clamp lifts it to 0.5. The typed-decisions `temperature_by_options` and `training` block are byte-identical to the English ones, so we cannot tell whether they were refitted for that checkpoint (UK). | SV |
| `confidence` | For choice and score: 1 − normalised entropy. jev uses `(n·p_max − 1)/(n − 1)`, so **thresholds do not transfer** (stated in the README and in `serve.py`). `answer_confidence` is the probability of the reported answer. | SV |
| Language routing | The `Router` detects script first, then a word-list language guess for Latin script (`lang.py`; `nl` is in the table at line 242). Non-English text goes to multilingual, and `lang=` / `lang_guess=` override the guess. The skill doc reports that Polish, Czech, Turkish and Swedish silently route to English (as of 0.3.4). | SV / VC |
| Training / fine-tune | `laya/train.py` + `laya-train` CLI: `loss="rlcd"` (GRPO-style reward from a proper scoring rule, plus soft CE) or `"soft-ce"`, with an optional `freeze_encoder` and option-order shuffling. **Its own docstring says #741 measured no gain from the RLCD term**, so "RL-trained calibration" is the marketing claim, not a measured mechanism. Notebooks: Kaggle 2×T4, MPS. | SV |
| Serialization | Weights load only through `safetensors.torch.load_file` with `strict=True` (`agent.py:577-689`). No `torch.load`, no pickle, no `trust_remote_code`. CI has a "Weights must load through safetensors, never pickle" job. `revisions.py` adds an opt-in revision pin (`LAYA_REVISION=reviewed`) and sha256 checks (`LAYA_SHA256_DIGESTS`) before any file is parsed. | SV |
| Dependencies | `torch>=2.0.0`, `transformers>=4.48.0`, `safetensors>=0.4.0`, `huggingface_hub>=0.20.0`, `numpy>=1.20.0`: **floors only, no lockfile, no hashes** (only `flake.lock`, for Nix). The Docker base `python:3.11-slim-trixie` is a tag, not a digest. CI runs pip-audit, gitleaks and CodeQL. No telemetry; the only runtime network call is the HF Hub download (plus `urllib` in the MCP remote mode and the agno/tools integrations). | SV |
| HTTP | `laya-serve` (FastAPI): `POST /v1/systemone` and `/v1/systemone/batch` (≤ 64 states). The README calls it "schema-identical" to jev, and `LAYA_JEV_STRICT` strips the extra fields. **The default bind is `0.0.0.0` with no auth unless `LAYA_API_KEY` is set** (`serve.py:23, 1666`). A guard caps choice questions at 100 options. | SV |
| MCP | `laya-mcp-server` (stdio, `mcp>=2.2.0`) with tools `laya_status/route/predict/predict_batch/route_batch/shortlist/tournament/preset/decide/predict_long`. With `LAYA_BASE_URL` set it is a thin client of `laya-serve`. | SV |
| TypeScript | `laya-client` (`sdk/typescript`) is a zero-dependency HTTP client (Node ≥ 22). `laya-ts` is in-process ONNX (`encoder.onnx` + `head.onnx`, optional `onnxruntime-node/web`) and needs a Python export step first. Neither is needed: our `typesafe-client.ts` already speaks the wire protocol. | SV |
| Ports | Go, Rust, Java and .NET ONNX runtimes checked against Python goldens. Irrelevant to us. | SV |

### Benchmark claims

| Claim | Repo backing | Mark |
| --- | --- | --- |
| 32.8 ms per question (multilingual, T4), 6–7× faster than jev | notebook + `results/t4_colab_benchmark.json`; the jev latency side is third-party | VC (reproducible in principle) |
| typed-decisions 0.766 vs jev 0.727 | **"no committed result file behind it yet"** (README); the jev figure is published by others, "never measured here" | VC |
| Base checkpoints on typed-decisions: 0.362 / 0.352, *below* the 0.461 majority baseline | committed (`t4_colab_benchmark.json`) | VC (the vendor's own negative) |
| ECE 0.081 vs jev 0.246 | only after temperature fitting on held-out data; raw ECE is 0.466 (English) / 0.314 (multilingual) | VC |
| 51-language MASSIVE (20 options): multilingual macro 0.401; **`nl` 0.470 (ECE 0.397)**, English checkpoint on `nl` 0.390 | committed sweep JSONs, ~100 rows per language | VC |
| **Paired, same prompts, non-English (Feishu zh, 64 synthetic cases): Laya multilingual 20/64 choice and 18/64 noul, vs jev-1.13.0 64/64 and 63/64** | archived raw responses + offline audit (`research/benchmarks/feishu_zh`) | VC (third-party, recorded) |
| **Paired, English, 500 labelled examples (playground `versus.json`): Laya 0.668 / ECE 0.241 vs jev 0.764 / ECE 0.147**; at parity only on AG News and SMS spam; prompt injection 0.65 vs 0.71; 5-level stars 0.35 vs 0.70 | recorded JSON; the source texts are not redistributed | VC (third-party, recorded) |
| Guard preset: recall 0.72 / FPR 0.21 (53 cases); misses instructions embedded in ordinary documents (0.000–0.301), blocks a benign quote of an attack (0.619) | `docs/guardrail-limitations.md`, reporter's numbers | VC |
| Wording sensitivity: 3 wordings of one router question score 0.700 / 0.656 / 0.611 (n = 180); option-order flip rate 28 % / 10.6 %; negated cancellations misread (#377) | `BENCHMARKS.md`, README "Honest limits" | VC |

The playground's public site **replays recorded runs** and has no live model behind it. A local clone runs live against the real model (playground README, SV).

### API compatibility with jev / `typesafe-client.ts`

| Aspect | DjimitFlo today (`origin/main`) | Laya | Compatible? |
| --- | --- | --- | --- |
| Endpoint | `POST ${TYPESAFE_BASE_URL}/v1/systemone`, Bearer key | same path, `LAYA_API_KEY` Bearer | yes (SV) |
| `model` field | `jev-1.13.0` (pinned) | unknown Jev ids fall back to auto-routing (`serve.py:398-438`) | yes, but see the provenance row |
| Provenance | `judgments.model` = `response.model`, which would be correct (a Laya id); `llm_model_calls` records the *requested* model and provider `typesafe` | — | **mislabels the cost and call ledger** |
| State size | `MAX_STATE_CHARS = 60 000`; `kb_passage_relevance` sends 3 000 + N × 1 500 chars | 512 / 1 024 tokens, silently cut from the end | **no**: late pages and fields go unread while their questions are still answered |
| `confidence` | 6 judgments threshold on `choice.confidence` (commons_idea, commons_contribution, checker_second_opinion, discovery_relevance, reflection_triage, failure_cause) | different formula | **no**: every threshold would need refitting |
| noul bands | `band(p, lo, hi)` on raw `noul` | raw P(true) with temperature | shape yes; calibration is per checkpoint |
| Extra fields | `TsAnswer` ignores unknown keys | `routing`, `action`, `answer_confidence` | yes |
| Challenger path (JEV-114) | `JEV_CHALLENGER_MODEL` reuses the **same base URL** | separate host | no without code |
| Local shadow seam | T1 pull queue still in code (`local_shadow_jobs`, `/api/host-agent/shadow/claim\|result`, `TYPESAFE_LOCAL_SHADOW_ENABLED=false` since 30-09) | a host worker could answer via `laya-serve` | yes at the wire level; re-enabling it is an operator decision (T1 is retired) |

**Verdict:** Laya could sit behind the contract only by repointing `TYPESAFE_BASE_URL` (forbidden: jev is the only backend) or through the retired T1 pull seam. In both cases the 512/1 024-token cap and the `confidence` semantics break today's thresholds, so it is not drop-in.

## 2. DjimitFlo decision-point map

Mode and label facts come from the operator plan; the code is read at `origin/main` `38be63d5`. NE-001 scope: jev is never used for approval, promotion, code, risk or fitness. Any second backend inherits that scope and the jev-only rule.

| Decision point | Backend · mode (plan) | Consumer | Labels (source, n) | NE-001 domain? | Laya fit |
| --- | --- | --- | --- | --- | --- |
| `proposal_prescreen` | jev · shadow (since 11-10; enforce before) | auto-review scheduler parks on a confident "no" (enforce only) | D5 operator labels + outcomes: JC-001 197 proposals / 152 clusters (holdout 48, used up); Clef replay 99 with outcome (17 verified); `names_file` has a deterministic oracle (`namedPathsExist`) | gate-adjacent (cascade REJECTED, NE-001) | **only-as-challenger**: offline replay on names_file + D5, which is the revisit path the operator named |
| `kb_passage_relevance` | jev · **enforce** | drops KB pages before the kimi-k3 panel | **none** (88 / 452 dropped unlabelled; E-KB proposes ~188 blind labels) | no | none: the multi-page state exceeds 1 024 tokens and would be truncated |
| `discovery_relevance` | jev · **paused** (#825, `DISCOVERY_RELEVANCE_PAUSED=true` since 14-10) | expert-unit creation (a "promotion" side door), committee, dream | #835 blind labels: 7 independent (#829 INSUFFICIENT); #827 72 pos / 0 neg; 558-label plan not run | promotion side door | none while paused; only-as-challenger after labels |
| `checker_second_opinion` | jev · shadow | honest-numbers kappa | oracle outcomes | **code** (forbidden) | none |
| `risk_atomic` | jev · shadow, no consumer | — | keyword baseline agrees 213 / 216 | **risk** (forbidden) | none: keywords already do it |
| `failure_cause` | jev · shadow (15-10) | dream-state → memory-rule candidates | none (72 "uncertain" re-rolls, 3 flips) | fitness-adjacent (memory) | none |
| `reflection_triage` | jev · mode UK | needs-grounding triage (`NEEDS_GROUNDING_TRIAGE_ENABLED`, parked) | none | no | none: no consumer, no labels |
| `commons_contribution` / `commons_idea` | jev · off (10-07) | threadGated (off) / none | T1 agreement only (68 % / 78 %), no labels | no | none |
| `decision_context` | jev · mode UK | memory injection into review (enforce) | none (NE-002 INCONCLUSIVE) | promotion-adjacent | none |
| JEV-114 challenger | jev-1.14.0 · shadow | none by design | 16 pairs / 2 with ground truth by 18-10; stop_by 2027-01-14 | — | none (it is a jev-vs-jev study) |
| IMG-001 (images) | jev-1.14 · offline | — | 34 / 34 offline | — | none: Laya has no image input |
| `content_safety` | NVIDIA nemotron (free tier) · enforce at KB ingest, shadow elsewhere | KB deletes on "unsafe"; prompt gate | none; 760 / 1 246 calls errored (429) in 7 d to 08-10 | security control | **only-as-challenger**; third-party evidence says it misses document-embedded injections |
| `telegram_access` | deterministic identity gate | access | — | auth | none |
| Maker / species routing | gym bandit on objective fitness | allocator | settled outcomes | fitness (forbidden) | none: objective fitness beats a classifier (plan T7) |
| PR / security checker | LLM reviewers + deterministic packs | auto-merge, SEC-F1 | F1 seeded defects | code (forbidden) | none |

**Summary:** inside DjimitFlo, no decision point has both a free domain and labels. The two "only-as-challenger" rows (prescreen replay, content_safety) are the ones the jev-only rule allows as offline studies.

## 3. Ecosystem decision points outside DjimitFlo

Here the jev-only rule does not bind, or private data rules out any cloud model.

| Decision point | Current mechanism | Baseline measurable? | Labels | Hardware fit | Privacy benefit |
| --- | --- | --- | --- | --- | --- |
| ChatGPT-export ledger O2 (design history) | done 28-09 with local gpt-oss-120b on the workstation (980 / 981 conversations, generative extraction) | yes, the ledger is silver | silver only (LLM output) | R9700 contention was real (794 / 981 first-pass HTTP 500 from llama-router) | none extra: it is already local. Laya cannot do the extraction (it is not generative) |
| O4 knowledge selection (redacted summaries) | **not run** (operator 30-09) | yes, once ~150 conversations are labelled | none yet | MacBook M4 24 GB (MPS; the export never leaves it) | high: no cloud allowed. **Not unique to Laya**: Clef Flash (local, already pulled, jev-equivalent on our states, NE-005) covers it |
| O5 operator memory (recurring asks, preferences) | **not run** | weak: preference rules have no ground truth | essentially none | MacBook | high, but the task is synthesis rather than classification |
| NAS knowledge intake | UK (NAS was inaccessible in L3 forensics) | UK | none | UK | high if the intake has to judge private documents |
| Edge hosts (Eve-V, Mac mini, workstation) | Hermes / agents use LLMs; workstation: llama-router (R9700 86–95 % busy with gym), Ollama on the RTX 2060 | — | — | RTX 2060 8 GB: fits one checkpoint (≤ 0.85 GB on disk; ~1.7 GB fp32), and bf16 autocast needs CC ≥ 8 so it runs fp32/fp16; MacBook: fits all three (~4.6 GB fp32). Eve-V and Mac mini hardware UK. ROCm (R9700) untested upstream (UK) | per host |
| EVE-V content triage | `eve-action-processor` → `work.action.required` / `content.revenue.candidate` (mechanism inside Eve-V UK; DjimitFlo only records the events, #488) | only if its outputs are logged | none | Eve-V UK | medium (operator content) |
| Hermes / OpenClaw / NanoClaw routing | their own LLM or tool routing (UK per agent); fleet outcomes are not yet value-linked (G5.1) | no: 0 of 13 fleet systems have verified outcomes (L3) | none | workstation / Mac mini / Eve-V | low: the requests are not private-only |
| Local guardrails for agent input | `content_safety` via NVIDIA cloud (429-prone); `gateUntrustedForPrompt` | yes, from existing `content_safety` rows (silver) + lure probes (known positives) | silver + lure probes | RTX 2060 or MacBook | medium: today untrusted text goes to a third-party free tier |

## 4. Risks

| Risk | Evidence | Severity for us |
| --- | --- | --- |
| Prompt and wording sensitivity | 0.700 → 0.611 across 3 wordings; option-order flips 10–28 %; negation failures (#377); "ask what the text says, not what to do" (skill doc) | high: our judgment questions are reference-free prose, the same weak spot as NE-001 |
| Uncalibrated multilingual checkpoint | temperatures `[1,1,1]` at the pin; raw ECE 0.314 | high for any threshold: we would have to fit our own, and `MIN_BUCKET_N = 2000` is far above our label counts |
| Dutch unknown | `nl` 0.470 on 20-way MASSIVE (n ≈ 100) is the only number; no paired NL vs jev; zh paired shows a 20/64 vs 64/64 collapse | high: O4 / O5 and operator content are partly Dutch |
| Zero-shot quality | the vendor's own base checkpoints score below majority-class on typed-decisions; English paired 0.668 vs 0.764 | high: "a fast base to specialise, not a zero-shot engine" (README) |
| Context cap | 512 / 1 024 tokens, cut from the end without a "missing" signal | high for kb passages, diffs, long proposals |
| Supply chain | floor-only pins, no hash lock, torch + transformers (+ fastapi/uvicorn for serve), Docker tag not digest; a fast-moving repo (0.1 → 0.4.16 in 5 weeks, 34 k stars); PyPI lags the repo | medium: same class as NE-006 / NE-012; acceptable only in a throwaway, `--network none` sandbox with hash-pinned wheels |
| Pickle | **not present**: safetensors-only loader, CI guard, digest checks | low (residual: loose `.py` files in the HF repo, never loaded by the package) |
| Exposed server | `laya-serve` defaults to `0.0.0.0` with no key | medium: must bind 127.0.0.1 and set `LAYA_API_KEY` (the T1 lesson, 29-09) |
| A second System One backend | split provenance, two calibrations, two threshold sets; the ledger mislabels provider and model; contradicts the 30-09 / 26-10 operator decisions | high (governance) |
| Skill doc | triggers on "Jev" / "System 1" / "typed decisions" and would hijack jev work; recommends unpinned `pip install` | resolved: not installed |

## 5. Ranked candidate use cases

Score = expected value × evidence confidence ÷ cost, each on a 1–3 scale. These are rough judgements, not measurements.

| # | Candidate | EV | Conf | Cost | Score | Smallest experiment | Labels needed | Falsifier | Rec. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **Local private-data triage for O4 selection** (which export conversations are in scope for governance/security/research summaries; NL + EN) | 2 | 1 | 1 | 2.0 | MacBook offline: hash-pinned wheels at the pinned sha in a throwaway venv, weights by digest, `HF_HUB_OFFLINE=1`; multilingual vs **Clef Flash** (already pulled) vs a keyword baseline on the same states; fit temperatures on a 50 % split, evaluate once | ~150 operator-labelled conversations (stratified NL / EN), ~2 h | Laya < Clef Flash − 5 pt, or NL slice ≤ keyword baseline, or post-fit ECE > 0.15 → REJECT | **DEFER** (O4 is not running; Clef Flash already covers the privacy need) |
| 2 | Offline jev challenger on `proposal_prescreen` (`names_file` + D5) | 1 | 2 | 1 | 2.0 | the operator's revisit path: replay labelled states through Laya in a throwaway container; AUC / Brier vs jev; states truncated to 512 tokens are flagged | names_file oracle (automatic) + D5 labels; prereg, new holdout (JC holdout never reused) | AUC ≤ jev, or Brier ≥ base rate (no skill, as for jev and Clef in NE-005) → REJECT | **DEFER** until a jev price or availability trigger |
| 3 | Local guard challenger for untrusted text (`content_safety` shadow) | 2 | 1 | 2 | 1.0 | replay existing `content_safety` rows + lure probes + 20 document-embedded injections offline | lure probes (known positives) + ~100 operator labels | recall on embedded injections < 0.8, or FPR > NVIDIA's → REJECT | **DEFER** (lean REJECT for enforce) |
| 4 | EVE-V content triage | 2 | 1 | 2 | 1.0 | log `eve-action-processor` decisions for 2 weeks, then label 100 | 100 operator labels | no logged baseline → cannot start | DEFER |
| 5 | Fine-tuned Laya head on DjimitFlo labels | 2 | 1 | 3 | 0.7 | — | ≥ 1 000s per judgment (calibration floor 2 000 per bucket) | label volume does not exist | **REJECT** (now) |
| 6 | Hermes / OpenClaw / NanoClaw model-tier routing | 1 | 1 | 2 | 0.5 | — | routing outcomes do not exist (0 / 13 verified) | — | **REJECT** (now) |

**Is "local decisions on private data" the strongest candidate? Partly confirmed, and it does not justify GO.** It ranks first because it is the only area where neither the jev-only rule nor NE-001 applies and a cloud model is forbidden. But the privacy benefit comes from *local inference*, not from Laya. Clef Flash already runs locally on the MacBook with the same `/v1/systemone` API and measured jev-equivalence on our own states (NE-005). Laya's only advantage over it is latency and footprint (ms vs ~1.9 s per call). On a one-off corpus of ~5 500 conversations that saves about 3 hours of batch time. Against that sit Laya's open weaknesses: zero-shot quality, an uncalibrated multilingual checkpoint, Dutch unknown, and the 1 024-token cap on long conversations. And O4 / O5 are not running at all.

## 6. What would change DEFER (explicit triggers)

Any one of these makes candidate #1 or #2 worth a pre-registered offline study. None of them is a GO by itself.

1. **jev price or availability:** a TypeSafe price change that moves cost out of the ≈ $0.25 / week band; jev-1.13 sunset without an acceptable successor; or sustained breaker-open / queue-full rates that lose judgments. This is the operator's stated revisit condition (26-10).
2. **Private-data judgments are switched on** (operator runs O4 / O5 / NAS intake) **and** Clef Flash is unavailable, too slow for the volume (≥ ~50 k items per run), or does not fit the host.
3. **Labels exist:** ≥ 100 ground-truth pairs per judgment (the JEV-114 target), or the ~150-conversation O4 label set, so a replay can decide something.
4. **Upstream evidence:** a committed, reproducible result file for typed-decisions; fitted temperatures shipped for the multilingual checkpoint; a Dutch paired benchmark against jev; or an independent paired non-English eval that closes the 20 / 64 vs 64 / 64 gap.
5. **An edge need with no LLM:** a host (Eve-V, Mac mini) has to triage offline and cannot run a 9B local model.
6. **Supply chain is hardened:** a hash-locked release (`pip --require-hashes` feasible) and a digest-pinned image, so the sandbox install is reproducible.

When a trigger fires, the procedure is: pre-register (metric, threshold rule, holdout and sha256 frozen before opening) → offline only, in a throwaway container with `--network none` after a pinned fetch → Laya enters as an AR2 challenger next to jev, never as a replacement → adopt only on a CI that excludes zero on our own labelled data (the NE-005 reopen standard).

## Evidence trail

- Laya: `README.md`, `BENCHMARKS.md`, `docs/guardrail-limitations.md`, `laya/{common,agent,calibrate,train,revisions,serve,router,lang}.py`, `laya/mcp/*`, `sdk/typescript/package.json`, `laya-ts/package.json`, `.github/workflows/security.yml`, `research/benchmarks/feishu_zh/README.md`, `research/results/confidence_definitions.json` (all at `a478221b`).
- HF: API file lists + `rl_agent_config.json` × 3 + model card at `7b928d82`; reviewed pin `55cf4c4e` has identical weight hashes.
- DjimitFlo (`origin/main` `38be63d5`): `services/typesafe-client.ts`, `judgment-service.ts`, `judgments/*.ts`, `local-shadow-queue.ts`, `kb-corpus.ts` (`gatePassages`), `content-safety.ts`, `effort-controller.ts` (`JUDGMENT_CONSUMERS`), `docs/research/negative-evidence/NEGATIVE_EVIDENCE.yaml` (NE-001, NE-005, NE-006), `docs/research/eco/JEV-114_PROTOCOL.md`.
- Operator plan: Phase X (Clef Flash replay 03-10), Phase T (T1 retired 30-09), JC-001 / NE-001, D5-NO, DI-001, Phase O (private-data guard), and the Laya decision of 26-10. Private sources are referred to by category only.
