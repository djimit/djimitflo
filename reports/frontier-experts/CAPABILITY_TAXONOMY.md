# Capability taxonomy (§7)

Source of truth: `CAPABILITY_TAXONOMY` in `packages/server/src/services/frontier-expert-registry-service.ts`, seeded (upsert) into `expert_capability_taxonomy` by `seedTaxonomy()`. Ids are stable; labels and aliases may evolve (§54). `resolveCapability(text)` accepts id, label or alias, case-insensitive. The resolver's `matchCapabilities` scores id, label and alias phrases against the question; the enrichment service uses the same phrases (word-boundary match) against paper titles and abstracts, plus these direct arXiv category mappings: cs.CR → ai_security, cs.CY → ai_governance, cs.MA → multi_agent_systems, cs.HC → human_ai_interaction.

| id | label | parent | aliases |
|---|---|---|---|
| `frontier_model_engineering` | Frontier model engineering | — | frontier models, large-scale training, pretraining |
| `scaling_laws` | Scaling laws | — | scaling, compute-optimal training, neural scaling |
| `reinforcement_learning` | Reinforcement learning | — | rl, policy optimization, policy optimisation, rlhf, reward hacking, sparse rewards |
| `agent_learning` | Agent learning | — | agentic learning, learning agents, long-horizon agents, agents that learn |
| `post_training` | Post-training | — | fine-tuning, instruction tuning, alignment training |
| `reasoning` | Reasoning | — | chain of thought, test-time compute |
| `automated_ai_research` | Automated AI research | — | ai for ai research, research automation, ai scientist, automated research, automated researchers, research agents, automating research, autonomous research, automated alignment research |
| `recursive_self_improvement` | Recursive self-improvement | `automated_ai_research` | rsi, self-improving ai, self-improving, self-improvement, self-improve, recursive improvement, intelligence explosion, self-modifying |
| `mechanistic_interpretability` | Mechanistic interpretability | — | interpretability, circuits, features |
| `alignment` | Alignment | — | ai alignment, value alignment |
| `scalable_oversight` | Scalable oversight | `alignment` | debate, weak-to-strong, oversight |
| `misalignment_detection` | Misalignment detection | `alignment` | deception detection, sleeper agents, deceptive alignment |
| `model_evaluations` | Model evaluations | — | evals, benchmarks, capability evaluations |
| `safety_evaluations` | Safety evaluations | `model_evaluations` | dangerous capability evals, safety evals |
| `model_control` | Model control | — | ai control, control protocols, control evaluations, trusted monitoring, untrusted monitoring, corrigibility, corrigible |
| `ai_security` | AI security | — | ml security, adversarial robustness, model security, prompt injection, jailbreak, weight exfiltration, adaptive attackers, insider threat |
| `cyber_capabilities` | Cyber capabilities | `ai_security` | offensive cyber, cyber evals, cybersecurity, cyber security, capture the flag, vulnerability discovery, exploit, penetration testing, cyber offense |
| `model_resilience` | Model resilience | `ai_security` | robustness, jailbreak resistance |
| `frontier_risk` | Frontier risk | — | catastrophic risk, frontier safety |
| `ai_governance` | AI governance | — | governance, responsible scaling |
| `ai_policy` | AI policy | `ai_governance` | public policy, regulation, legislation, policymakers |
| `coordination_mechanisms` | Coordination mechanisms | `ai_governance` | international coordination, compute governance, mechanism design, racing dynamics |
| `human_ai_interaction` | Human-AI interaction | — | hci, human-ai collaboration |
| `multi_agent_systems` | Multi-agent systems | — | multi-agent, agent societies, autonomous agents, collusion, negotiation between agents |

## Rules

- A capability is only ever attached to an identity with evidence references of kinds paper, institutional_page, technical_report, repository, presentation, profile or scholarly_metadata (I02); signature, secondary and other never qualify (I01).
- Alias choices are benchmark-driven: `ai_policy` lost the bare alias `policy` because it captured RL "policy optimisation" queries; `ai_security` gained prompt injection / jailbreak / weight exfiltration; `multi_agent_systems` gained autonomous agents / collusion (see EXPERT_RESOLUTION_EVALUATION.md).
- Live-data pass (2026-09-14): `automated_ai_research`, `recursive_self_improvement`, `cyber_capabilities` and `model_control` gained aliases because the enriched seed had matching papers that no phrase caught (three in-domain abstentions → none, LIVE_DATA_EVALUATION.md); generic single-word aliases only match paper titles.
- Extending: add an entry to `CAPABILITY_TAXONOMY`, run `seedTaxonomy()` (idempotent upsert) and re-run the benchmark; keep aliases specific enough not to collide across families.
