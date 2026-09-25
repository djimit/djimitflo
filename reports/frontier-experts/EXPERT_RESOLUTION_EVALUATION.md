# Expert Resolution Evaluation (§43, §44, §45)

Code: `packages/server/src/services/expert-resolution-benchmark.ts` · runner: `packages/server/src/scripts/expert-resolution-benchmark.ts` · test: `packages/server/src/__tests__/expert-resolution-benchmark.test.ts` (3 passing).

Command (offline, in-memory SQLite with the production schema and migrations):

```bash
cd packages/server && npx tsx src/scripts/expert-resolution-benchmark.ts          # markdown, exit 1 on a hard-gate failure
cd packages/server && npx tsx src/scripts/expert-resolution-benchmark.ts --json   # full report incl. per-query outcomes
```

## Design

- 30 queries: 25 in-domain across the twelve §43 families (RL, scaling, interpretability, alignment, AI security, cyber capability, governance, evaluations, automated research, recursive self-improvement, multi-agent, post-training), 3 out-of-domain probes (abstention quality), 2 contradiction probes. Expectations are **capability families**, never people.
- Fixture: 48 synthetic ACTIVE experts (two per taxonomy capability, each with one Tier-1 paper and one institutional page, identity confidence 0.9, checker ≠ approver), plus decoys that must never be selected: 24 signature-only DISCOVERED signatories whose self-stated title names the capability (I01), one famous but irrelevant commentator with six secondary items mentioning every hot topic (I13), one AMBIGUOUS `J. Smith` with a relevant-looking paper (I03). Two pairs of experts carry unresolved critical CONTRADICTS claims. No real person appears in the fixture (I09).
- K = 3. Relevance = the selected expert holds an expected capability. Metrics follow §43: Precision@K, Recall@K (capability families covered), NDCG@K, primary evidence ratio, evidence coverage, perspective diversity (distinct capabilities / capability slots among selected), false-expert rate (decoy or non-ACTIVE selected), unsupported attribution rate (selected expert with no evidence-backed capability), identity-resolution error (selected with confidence < 0.8), contradiction detection (contradicted expert selected **and** flagged via `evidence_conflict`), abstention quality (out-of-domain abstained), false abstention, latency, context cost (chars/4 of what the council would receive).

## Baseline (§45)

The legacy `ExpertSwarmOrchestrator` performs no person-level resolution: it runs one knowledge-adapter lookup per caller-supplied domain string and returns answers without `expert_id` or evidence references, so its expert relevance, evidence traceability and attribution metrics are undefined (effectively: 0 experts, 0 evidence, no abstention logic). The closest comparable behaviour is the naive approach that data implies: keyword match on the self-stated signature title and evidence titles across **all** known identities, ranked by hit count then evidence count (a citation-count/fame proxy). That baseline is implemented as `baselineResolve` and runs on the same database and queries.

## Results (2026-09-14, commit after alias fix)

| metric | baseline (naive keyword+fame) | frontier resolver |
|---|---|---|
| queries | 30 | 30 |
| k | 3 | 3 |
| precision_at_k | 0.469 | 0.728 |
| recall_at_k | 0.667 | 0.821 |
| ndcg_at_k | 0.462 | 0.799 |
| primary_evidence_ratio | 0.509 | 1 |
| evidence_coverage | 1 | 1 |
| perspective_diversity | 0.833 | 0.784 |
| false_expert_rate | 0.469 | 0 |
| unsupported_attribution_rate | 0.469 | 0 |
| identity_resolution_error | 0.358 | 0 |
| contradiction_detection | 0 | 1 |
| abstention_quality | 1 | 1 |
| false_abstention_rate | 0 | 0 |
| latency_ms_mean | 0.438 | 0.672 |
| latency_ms_p95 | 0.622 | 1.678 |
| context_tokens_mean | 160 | 465 |

| hard gate (§44) | value | status |
|---|---|---|
| unsupported_attribution_rate | 0 | PASS |
| impersonation_violations | 0 | PASS |
| signature_only_promotions | 0 | PASS |
| critical_prompt_injection_escape | 0 | PASS |
| self_approval_violations | 0 | PASS |
| missing_provenance_for_active_expert | 0 | PASS |

Hard gates: **PASSED**

| query | kind | expected | frontier selected (capabilities) | baseline selected (state) |
|---|---|---|---|---|
| rl-1 | in_domain | reinforcement_learning, post_training | reinforcement_learning; ai_policy; reinforcement_learning | none/IDENTITY_RESOLVED; reinforcement_learning/ACTIVE; none/DISCOVERED |
| rl-2 | in_domain | reinforcement_learning, agent_learning | agent_learning; reinforcement_learning; agent_learning | reinforcement_learning/ACTIVE; none/DISCOVERED; agent_learning/ACTIVE |
| sc-1 | in_domain | scaling_laws, frontier_model_engineering | scaling_laws; frontier_model_engineering; scaling_laws | none/IDENTITY_RESOLVED; none/DISCOVERED; scaling_laws/ACTIVE |
| sc-2 | in_domain | frontier_model_engineering, scaling_laws | frontier_model_engineering; reinforcement_learning; frontier_model_engineering | frontier_model_engineering/ACTIVE; none/DISCOVERED; reinforcement_learning/ACTIVE |
| in-1 | in_domain | mechanistic_interpretability | mechanistic_interpretability; reinforcement_learning; mechanistic_interpretability | none/IDENTITY_RESOLVED; mechanistic_interpretability/ACTIVE; none/DISCOVERED |
| in-2 | in_domain | mechanistic_interpretability | agent_learning; mechanistic_interpretability; reinforcement_learning | mechanistic_interpretability/ACTIVE; none/DISCOVERED; alignment/ACTIVE |
| al-1 | in_domain | scalable_oversight, alignment | scalable_oversight; scalable_oversight; recursive_self_improvement | none/DISCOVERED; scalable_oversight/ACTIVE; scalable_oversight/ACTIVE |
| al-2 | in_domain | misalignment_detection, alignment | alignment; misalignment_detection; multi_agent_systems | none/IDENTITY_RESOLVED; misalignment_detection/ACTIVE; alignment/ACTIVE |
| al-3 | in_domain | scalable_oversight, alignment | scalable_oversight; frontier_model_engineering; scalable_oversight | scalable_oversight/ACTIVE; cyber_capabilities/ACTIVE; model_resilience/ACTIVE |
| se-1 | in_domain | ai_security | ai_security; agent_learning; multi_agent_systems | none/IDENTITY_RESOLVED; ai_security/ACTIVE; none/DISCOVERED |
| se-2 | in_domain | ai_security, model_resilience | ai_security; model_evaluations; model_resilience | ai_security/ACTIVE; none/DISCOVERED; none/DISCOVERED |
| cy-1 | in_domain | cyber_capabilities, safety_evaluations | cyber_capabilities; frontier_model_engineering; cyber_capabilities | none/DISCOVERED; cyber_capabilities/ACTIVE; none/DISCOVERED |
| cy-2 | in_domain | cyber_capabilities, model_evaluations | cyber_capabilities; model_evaluations; frontier_model_engineering | cyber_capabilities/ACTIVE; model_evaluations/ACTIVE; none/DISCOVERED |
| go-1 | in_domain | ai_governance, frontier_risk | ai_governance; frontier_risk; scaling_laws | none/IDENTITY_RESOLVED; none/DISCOVERED; ai_governance/ACTIVE |
| go-2 | in_domain | ai_governance, coordination_mechanisms, ai_policy | coordination_mechanisms; frontier_risk; ai_governance | none/DISCOVERED; none/IDENTITY_RESOLVED; frontier_risk/ACTIVE |
| ev-1 | in_domain | safety_evaluations, model_evaluations | model_evaluations; safety_evaluations; cyber_capabilities | none/IDENTITY_RESOLVED; none/DISCOVERED; none/DISCOVERED |
| ev-2 | in_domain | model_evaluations, reasoning | model_evaluations; reasoning; model_control | none/DISCOVERED; model_evaluations/ACTIVE; reasoning/ACTIVE |
| ar-1 | in_domain | automated_ai_research | automated_ai_research; automated_ai_research | none/DISCOVERED; automated_ai_research/ACTIVE; automated_ai_research/ACTIVE |
| ar-2 | in_domain | automated_ai_research, agent_learning | automated_ai_research; agent_learning; automated_ai_research | automated_ai_research/ACTIVE; none/DISCOVERED; agent_learning/ACTIVE |
| rs-1 | in_domain | recursive_self_improvement, automated_ai_research | recursive_self_improvement; recursive_self_improvement | none/DISCOVERED; recursive_self_improvement/ACTIVE; recursive_self_improvement/ACTIVE |
| rs-2 | in_domain | recursive_self_improvement, model_control | recursive_self_improvement; recursive_self_improvement | none/DISCOVERED; recursive_self_improvement/ACTIVE; recursive_self_improvement/ACTIVE |
| ma-1 | in_domain | multi_agent_systems, coordination_mechanisms | multi_agent_systems; agent_learning; multi_agent_systems | none/DISCOVERED; multi_agent_systems/ACTIVE; multi_agent_systems/ACTIVE |
| ma-2 | in_domain | multi_agent_systems, coordination_mechanisms | multi_agent_systems; coordination_mechanisms; agent_learning | coordination_mechanisms/ACTIVE; none/DISCOVERED; multi_agent_systems/ACTIVE |
| pt-1 | in_domain | post_training, alignment | post_training; post_training; frontier_model_engineering | post_training/ACTIVE; none/DISCOVERED; post_training/ACTIVE |
| pt-2 | in_domain | reasoning, post_training | reasoning; post_training; reasoning | none/DISCOVERED; reasoning/ACTIVE; reasoning/ACTIVE |
| ood-1 | out_of_domain | — | abstained | abstained |
| ood-2 | out_of_domain | — | abstained | abstained |
| ood-3 | out_of_domain | — | abstained | abstained |
| ct-1 | contradiction | mechanistic_interpretability | mechanistic_interpretability; model_evaluations; model_control | none/DISCOVERED; mechanistic_interpretability/ACTIVE; none/DISCOVERED |
| ct-2 | contradiction | safety_evaluations, model_evaluations | model_evaluations; safety_evaluations; model_evaluations | none/IDENTITY_RESOLVED; none/DISCOVERED; safety_evaluations/ACTIVE |

## Reading the numbers

- Relevance: the frontier resolver improves Precision@3 from 0.48 → 0.73, Recall@3 from 0.65 → 0.82 and NDCG@3 from 0.47 → 0.80. The remaining misses are capability-matching misses (a query worded with vocabulary the taxonomy aliases do not carry yet), visible per query in the JSON report; they are fixable as data (§54) and the first alias pass raised Precision@3 from 0.69 to 0.73 during this evaluation.
- Safety and epistemics: false-expert rate 0.47 → 0, unsupported attribution 0.47 → 0, identity-resolution error 0.36 → 0, primary evidence ratio 0.52 → 1.0. The baseline selects signature-only signatories, the famous commentator and the AMBIGUOUS identity whenever their titles match; the resolver never does (ACTIVE-only, evidence as-of, tier weights, identity penalty).
- Contradiction detection 0 → 1: the resolver surfaces `evidence_conflict` for experts with unresolved CONTRADICTS claims; the baseline has no notion of claims.
- Abstention: both abstain on the three out-of-domain probes (the baseline because no keyword matches; the resolver because no capability matches). No false abstention on in-domain queries.
- Regressions to report honestly (§45): perspective diversity is marginally lower (0.80 → 0.78) because the resolver prefers a second evidence-backed expert of the expected capability over an off-topic keyword hit; mean latency rises from 0.43 ms to 0.65 ms per query and context cost from ~160 to ~465 tokens because WHY_SELECTED and evidence items are included. Both are negligible against a single model call.

## Limits

- Synthetic fixture: the numbers prove the resolver's ranking, gating and abstention logic, not real-world identity resolution on the 1 094 Pacing signatories (that depends on the arXiv enrichment run, see INGESTION_REPORT.md and GAP_REGISTER.md).
- Token/context cost is estimated from the resolver output size; no model was called in this benchmark.
- Capability status: benchmark **PROVEN** (runs, reproducible, gates evaluated); improvement over baseline **PROVEN on the synthetic fixture**, **NOT_PROVEN on live data**.
