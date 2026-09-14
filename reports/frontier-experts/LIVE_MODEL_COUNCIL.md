# Live-model council run (G-02)

Run 2026-09-14 ~11:40 CEST from the MacBook against the enriched seed database (LIVE_DATA_EVALUATION.md), runtime `ollama:qwen3.5:cloud` on the agenticservices Ollama host, `states: ['CAPABILITY_INFERRED']` because no human has approved an expert yet. Question: the §59 reference question. Wall time 30.4 s for 4 perspectives (2 parallel) plus the adversary.

## What happened

- Resolver selected 4 tentative experts: Klaudia Krawiecka [CAPABILITY_INFERRED] agent_learning+ai_governance+ai_security+cyber_capabilities+frontier_model_engineering+frontier_risk+multi_agent_systems; Fares Obeid [CAPABILITY_INFERRED] frontier_model_engineering+reasoning+recursive_self_improvement+reinforcement_learning+scaling_laws; Aradhana Sinha [CAPABILITY_INFERRED] ai_governance+alignment+automated_ai_research+model_resilience+post_training; Zora Che [CAPABILITY_INFERRED] ai_governance+ai_policy+ai_security+cyber_capabilities+frontier_model_engineering+human_ai_interaction+model_resilience+multi_agent_systems+safety_evaluations+scalable_oversight+scaling_laws.
- Perspectives returned: 4, rejected by the validator: 0, unsupported attribution: 0.
- Claims persisted: 4 (every one cites evidence ids the expert actually holds); relations: none; agreements 0, disagreements 0; adversarial attacks: 4.
- Three of four perspectives produced **no claims** and said why: the evidence does not describe the named system, so the model refused to attribute anything about it to the person (`analysis` quotes below). That is the required behaviour (I09, I15, §53), not a failure.

## Perspective excerpts (model output, evidence-bound)

- **Klaudia Krawiecka** — claims 0, dropped 0: "The question asks whether autonomous recursive AI research changes the security, governance, and technical requirements for a specific entity named 'DjimitFlo'. The provided evidence contains no mention of 'DjimitFlo', i…" Falsification: "If 'DjimitFlo' operates as a single, non-recursive, non-agentic model without external tool access, machine identities, or inter-agent communication channels, t…"
- **Fares Obeid** — claims 4, dropped 0: "The question asks for an assessment of how autonomous recursive AI research impacts the security, governance, and technical requirements of a specific entity named 'DjimitFlo'. The provided evidence contains technical re…" Falsification: "A technical report or system card explicitly detailing 'DjimitFlo's' architecture and stating that its self-improvement loops operate independently of external …"
- **Aradhana Sinha** — claims 0, dropped 0: "The question asks for an assessment of how autonomous recursive AI research impacts the security, governance, and technical requirements of a specific entity named 'DjimitFlo' and its 'self-improvement architecture.' The…" Falsification: "A compliance signal showing failure would be a verified audit report or policy document explicitly linking DjimitFlo's architecture to a security breach caused …"
- **Zora Che** — claims 0, dropped 0: "The question asks for an assessment of how 'autonomous recursive AI research' impacts the security, governance, and technical requirements of a specific system named 'DjimitFlo'. The provided evidence contains research o…" Falsification: "A compliance report, audit, or technical documentation explicitly linking 'DjimitFlo' to autonomous recursive processes and detailing its security or governance…"

## Claims

- Prime Agent harness | enables | long-horizon agency and recursive subagent coordination via external computation and persistent REPL (asserts, 1 refs)
- INTELLECT-2 training run | demonstrates feasibility of | globally distributed asynchronous reinforcement learning on untrusted heterogeneous compute (asserts, 1 refs)
- Prefix Sliding method | allows for | efficient test-time scaling of reasoning traces beyond 100k tokens by discarding intermediate tokens (asserts, 1 refs)
- Recursive self-improving systems (e.g., Prime Agent, INTELLECT-3) | necessitate | infrastructure for execution recovery, verification, and resource accounting to prevent harness failures from becoming model failures (asserts, 2 refs)

## Adversarial attacks

- claim claim:71498492-6…: The proposition commits a causal leap by equating the mechanical capability of 'external computation and persistent repl' with the emergent property of 'long horizon agency.' It assumes that state per (gap: No empirical data is cited demonstrating that the 'prime agent harness' maintains goal stability over extended recursive)
- claim claim:af2535a5-4…: This claim relies on an unsupported assumption that 'feasibility' in a specific training run ('intellect 2') generalizes to security-critical operations on 'untrusted heterogeneous compute.' It fails  (gap: The referenced evidence likely demonstrates convergence or loss reduction but lacks stress-testing results against Byzan)
- claim claim:bf589636-d…: The proposition makes a dangerous technical oversimplification by asserting that 'discarding intermediate tokens' preserves reasoning integrity. This ignores the non-Markovian nature of complex logica (gap: There is no cited benchmark showing that the 'prefix sliding method' maintains logical consistency or factual accuracy o)
- claim claim:b58620c3-6…: This claim exhibits a governance blind spot by assuming that 'execution recovery verification' is sufficient to prevent 'harness failures from becoming model failures.' It fails to account for the spe (gap: The evidence references do not provide latency bounds for the verification loop relative to the self-modification cycle )

## Fixes this run surfaced

- Thinking models (qwen3.5) spent the whole 700-token budget on hidden reasoning and returned empty content → every perspective was `PERSPECTIVE_OUTPUT_INVALID`. The Ollama provider now sends `think: false` and the council passes a 4 096-token output budget (`ChatOptions.maxTokens`, also mapped to Anthropic/OpenAI/Gemini).
- Production enrichment failed with `EXPERT_CAPABILITY_UNKNOWN` because the taxonomy was never seeded outside tests; the service and routes now seed it idempotently (PR 243).

## Status

Council with a real model: **PROVEN locally** (real evidence, real model, governance untouched: nothing promoted, all experts still tentative). On production the same runtime is configured (`FRONTIER_EXPERTS_RUNTIME=ollama:qwen3.5:cloud`); the council route only runs over ACTIVE experts, so it needs the first human approvals — or an explicit tentative mode — before it produces perspectives there.
