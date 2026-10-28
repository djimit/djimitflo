# BEAM-001 capability inventory

Generated from `CAPABILITY_INVENTORY.json` (same data). Prod snapshot 2026-10-21 20:34Z, read-only. Levels: Impl / Conf / Active / Exercised / Indep. verified / Prod value; Y yes, P partial, N no, ? unknown. Evidence and confidence per level are in the JSON.

**Changed since the 20-10 ecosystem audit (capability-graph.json):** F2 v2 cross checker now gemma4 (was kimi-k3); SEC-F1 gives the security checker an independent planted-defect result (KEEP, AUC 0.975) -> security checker moves from "ACTIVE/L2" to independently verified; FLEET_EVENT_SIGNATURES=enforce (P0-3 closed); auto-merge act merged 25 PRs in 7 d; FINDING_FIX_LANE and R2 are shadow; dream evolution off; new node `model.beam` (MISSING, probe only). Seven of the audit files named in the directive do not exist in the scratchpad; they are listed in the JSON as `prior_audits_missing` and were not recreated.

| id | model / runtime | Impl | Conf | Active | Exer | Indep | Value | class | Beam decision | tag |
|---|---|---|---|---|---|---|---|---|---|---|
| maker.opencode | ollama/glm-5.2:cloud via agenticservices proxy 100.77.58.72 | Y | Y | Y | Y | Y | P | EXISTS | **INSUFFICIENT_EVIDENCE** | FACT (levels) / HYPOTHESIS (Beam effect) |
| maker.remote_workstation | workstation/atomic@llama-router | Y | Y | Y | Y | Y | P | EXISTS | **REJECT** | FACT |
| maker.claude_fallback | claude:default (Max 5x OAuth) | Y | P | P | Y | N | N | PARTIAL | **REJECT** | FACT |
| maker.codex | codex:default | Y | P | P | Y | N | N | PARTIAL | **REJECT** | FACT |
| maker.atomic_local | atomic | Y | P | N | Y | N | N | SUPERSEDED | **REJECT** | FACT |
| verify.deterministic_checks | none (no LLM) | Y | Y | Y | Y | Y | Y | EXISTS | **REJECT** | FACT |
| verify.llm_checker | glm-5.2 (same arm) / gemma4:31b (F2 v2 cross arm) | Y | Y | Y | Y | Y | P | EXISTS | **HOLD** | FACT (levels) / HYPOTHESIS (Beam) |
| verify.security_checker | glm-5.2 | Y | Y | Y | Y | Y | P | EXISTS | **HOLD** | FACT |
| verify.security_checker_manual | human | Y | P | Y | N | N | N | PARTIAL | **REJECT** | FACT |
| verify.r2_fail_before_pass_after | none (executed) | Y | Y | Y | P | N | N | PARTIAL | **REJECT** | FACT |
| decision.auto_merge | none | Y | Y | Y | Y | P | Y | EXISTS | **REJECT** | FACT |
| human.merge_review | operator | Y | Y | Y | Y | Y | Y | EXISTS | **REJECT** | FACT |
| settle.merge_survival | none | Y | Y | Y | Y | P | Y | EXISTS | **REJECT** | FACT |
| supply.test_gap_mutation | none | Y | Y | Y | Y | Y | Y | EXISTS | **REJECT** | FACT (counts) / INFERENCE (cap-bound) |
| supply.llm_originated | gemma4:31b (refinement), panel gemma4 + kimi-k3 | Y | P | P | Y | N | N | PARTIAL | **REJECT** | FACT (counts) / INFERENCE (cause) |
| panel.review | gemma4:31b:cloud (+ kimi-k3:cloud 42 calls / 7 d) | Y | Y | Y | Y | N | N | PARTIAL | **REJECT** | FACT |
| commons.residents | qwen2.5:3b (autopilot), residents off | Y | P | N | P | N | N | PARTIAL | **REJECT** | FACT |
| frontier.experts | gemma4:31b, glm-5.3-flash | Y | Y | P | P | N | N | PARTIAL | **REJECT** | FACT |
| judgment.jev | jev-1.13.0 / 1.14.0 challenger | Y | Y | Y | Y | N | N | PARTIAL | **REJECT** | FACT |
| guard.content_safety | nemotron-3.5-content-safety, nemotron-3-embed-1b | Y | Y | Y | Y | ? | ? | EXISTS | **REJECT** | FACT |
| inference.failover | claude subscription | Y | Y | Y | Y | N | P | EXISTS | **REJECT** | FACT |
| inference.ollama_cloud_account | all :cloud models | Y | Y | Y | Y | N | P | EXISTS | **INSUFFICIENT_EVIDENCE** | FACT / UNKNOWN (Beam rate) |
| gym.remote | atomic@llama-router | Y | Y | Y | Y | P | N | PARTIAL | **REJECT** | FACT |
| evo.dream_evolution | kimi-k3:cloud (1 call / 7 d) | Y | N | N | P | N | N | PARTIAL | **REJECT** | FACT |
| lane.finding_fix | opencode maker (would be) | Y | Y | Y | N | N | N | PARTIAL | **HOLD** | FACT |
| lane.extra_repos | opencode maker | Y | N | N | N | N | N | PARTIAL | **REJECT** | FACT |
| exp.tg001 | opencode | Y | Y | N | Y | Y | N | EXISTS | **HOLD** | FACT |
| exp.sec_f1_harness | glm-5.2 checker | Y | Y | N | Y | Y | P | EXISTS | **ADOPT_CONDITIONALLY** | FACT |
| model.beam | beam:cloud (Ollama Cloud), tag digest 84a1b11bb377 | N | N | N | P | N | N | MISSING | **INSUFFICIENT_EVIDENCE** | FACT |
| ledger.cost | - | Y | P | Y | P | N | N | PARTIAL | **INSUFFICIENT_EVIDENCE** | FACT |

## Beam intervention per capability

- **maker.opencode** (INSUFFICIENT_EVIDENCE): A: model swap glm-5.2 -> beam:cloud (needs opencode.json registration).
- **maker.remote_workstation** (REJECT): None: Beam (501B) cannot run on R9700 32 GB + RTX 2060; VPS must not call workstation. Note: Beam local is infeasible: BF16 weights 1.00 TB (HF usedStorage), NVFP4 ~0.25-0.3 TB.
- **maker.claude_fallback** (REJECT): Beam is on the same Ollama account -> no failover diversity.
- **maker.codex** (REJECT): none. Note: sandbox blocker (plan 18-10), not model.
- **maker.atomic_local** (REJECT): none.
- **verify.deterministic_checks** (REJECT): none; must never be replaced by a model.
- **verify.llm_checker** (HOLD): A: Beam as checker model (non-inferiority on frozen slice); never removes the checker. Note: F2 v2 is a running experiment; swapping the cross model invalidates it -> HOLD until F2 reads out.
- **verify.security_checker** (HOLD): A: Beam as challenger on SEC-F1 slice (cost, verdict-parse rate); headroom 1/20 only.
- **verify.security_checker_manual** (REJECT): none (orchestration defect, bottlenecks.md P1-5).
- **verify.r2_fail_before_pass_after** (REJECT): none.
- **decision.auto_merge** (REJECT): none.
- **human.merge_review** (REJECT): none (bottleneck is human time, not model).
- **settle.merge_survival** (REJECT): none.
- **supply.test_gap_mutation** (REJECT): none (cap-bound, one repo).
- **supply.llm_originated** (REJECT): A rejected: no verifier, model quality not the binding constraint.
- **panel.review** (REJECT): B (simplify) beats A (swap): panel shows no discrimination. Note: kimi-k3 still answers 42 panel calls / 7 d although the configured candidate is gemma4 only -> UNKNOWN source; check.
- **commons.residents** (REJECT): none.
- **frontier.experts** (REJECT): none.
- **judgment.jev** (REJECT): none (different model class; NE-001).
- **guard.content_safety** (REJECT): none (Beam is text-gen only, no embeddings, not a safety classifier).
- **inference.failover** (REJECT): Beam adds no diversity (same account, same weekly limit).
- **inference.ollama_cloud_account** (INSUFFICIENT_EVIDENCE): Beam listed as "Low Usage" on ollama.com (VENDOR_CLAIM, meaning UNKNOWN); not in the Ollama price table.
- **gym.remote** (REJECT): none.
- **evo.dream_evolution** (REJECT): none.
- **lane.finding_fix** (HOLD): future maker-model slot; same experiment as maker.opencode.
- **lane.extra_repos** (REJECT): none (operator token missing).
- **exp.tg001** (HOLD): OUT OF SCOPE (operator: do not touch TG-001).
- **exp.sec_f1_harness** (ADOPT_CONDITIONALLY): reuse read-only as paired slice for a Beam checker challenger. Note: adopt only as an evaluation harness, not Beam itself.
- **model.beam** (INSUFFICIENT_EVIDENCE): subject of this study.
- **ledger.cost** (INSUFFICIENT_EVIDENCE): blocks any EUR claim for Beam; only tokens can be compared.

## Evidence keys

- **P7 / P30**: prod snapshot 2026-10-21 (7 d / 30 d), queries in `BEAM_COMPATIBILITY.md` appendix; raw JSON kept in the session scratchpad, not committed.
- **ENV**: non-secret flag values read from the container (names + values of non-secret flags only).
- **SEC-F1**: #941. **F1**: re-run 14-10 (plan). **TG**: TG-001 r2 (17-10). **DI**: docs/research/di-001.
- **PROBE**: the 9 synthetic Beam calls in `BEAM_COMPATIBILITY.md`.
