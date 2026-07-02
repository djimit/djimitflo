# Ruflo Compatibility

**Last Updated**: 2026-07-01
**DjimFlo Version**: 0.6.0 (Level-18)

## Classification: DjimFlo Surpasses Ruflo

Ruflo is an open-source agent orchestration framework by [ruvnet](https://github.com/ruvnet). DjimFlo draws conceptual inspiration from Ruflo's approach to agent orchestration but has **no runtime dependency** on Ruflo and zero Ruflo code in the codebase.

As of Level-18, DjimFlo has surpassed Ruflo in most capability domains.

## Capability Mapping

| Ruflo Concept | Djimflo Equivalent | Status | Notes |
|---|---|---|---|
| Task orchestration | LoopService + WorkerPool + LoopDaemon | ✅ Surpasses | Autonomous goal queue, priority scheduling, parallel workers |
| Agent management | AgentRegistry + MonitoringAgent + EmergentSpecialization | ✅ Surpasses | Dynamic specialization, performance tracking, auto-pruning |
| Approval/prompts | ApprovalService + PolicyDecisionService + OperatorIntervention | ✅ Surpasses | Risk classification, dual-approve, human-in-the-loop |
| Memory/context | MemoryStore + MemoryCurator + AutobiographicalMemory + CognitiveMemory | ✅ Surpasses | Graph projection, episodic memory, skill library, causal edges |
| Hooks (pre/post) | DiffCaptureService + EpistemicGateService | ✅ Surpasses | Pre/post snapshots + 4 epistemische gates |
| Repository scanning | RepositoryScanner + SelfCodeAnalysis | ✅ Surpasses | Health scoring, dead code detection, complexity analysis |
| AGENTS.md governance | AgentsMdValidator | ✅ Equivalent | AGENTS.md validation |
| MCP tools | IntegrationInbox + FederationService | ✅ Surpasses | Cross-instance federation + A2A protocol |
| Swarm coordination | ExpertSwarmOrchestrator + MARL + SwarmIntelligence | ✅ Surpasses | Parallel expert agents, multi-agent RL, consensus |
| AgentDB/SONA memory | MemoryStore + CognitiveMemory + ElasticMemory | ✅ Surpasses | Graph projection, vector search, skill library |
| Federation | FederationService + A2AAgentRegistry | ✅ Implemented | Capability tokens, trust scoring, rate limiting |
| Session continuity | AutobiographicalMemory + MemoryStore | ✅ Implemented | Persistent episodes, graph relations |
| Worktree management | LoopService (full lifecycle) | ✅ Implemented | Create, isolate, patch, prune |
| Plugin system | PluginRegistry (hot-swap) | ⚠️ Partial | Hot-swap signed plugins, no marketplace yet |
| Claude Code dependency | N/A | ✅ Not applicable | DjimFlo uses OpenCode + 6 other runtimes |

## What DjimFlo Has That Ruflo Doesn't

| DjimFlo Capability | Service |
|---|---|
| Recursive Self-Improvement Engine | `rsi-safety-guard.ts`, `service-refactoring-analyzer.ts` |
| Contrastive Learning (Level-18) | `contrastive-skill-miner.ts` |
| Meta-Learning (Level-18) | `meta-learning-prompt-optimizer.ts` |
| RLHF Memory Ranking (Level-18) | `rlhf-memory-ranker.ts` |
| GNN Causal Model (Level-18) | `gnn-causal-model.ts` |
| Metacognitive Observer | `metacognitive-observer.ts` |
| Intrinsic Motivation | `intrinsic-motivation-service.ts` |
| Causal World Model | `causal-world-model-service.ts` |
| GOAP A* Planner | `goap-planner-service.ts` |
| Thompson Sampling Bandit | `thompson-bandit-service.ts` |
| Epistemic Gates (4 types) | `epistemic-gate-service.ts` |
| Adversarial Input Validation | `adversarial-input-validator.ts` |
| Autobiographical Memory | `autobiographical-memory-service.ts` |
| Curriculum Learning | `curriculum-learning-service.ts` |
| Continual Learning | `continual-learning-service.ts` |
| Elastic Memory (auto-scaling tiers) | `elastic-memory-service.ts` |
| Multi-Agent Reinforcement Learning | `marl-service.ts` |
| Theory of Mind | `theory-of-mind-service.ts` |
| Influence Attribution | `influence-attribution-service.ts` |
| Compliance Checking (EU AI Act, NORA, GDPR) | `compliance-checking-agent.ts` |
| Security Scanning | `security-scanning-agent.ts` |
| Monitoring & Alerting | `monitoring-agent.ts` |
| Operator Intervention Protocol | `operator-intervention.ts` |
| Self-Code Analysis | `self-code-analysis-service.ts` |
| Self-Build Pipeline | `self-build-service.ts` |
| Self-Deployment | `self-deploy-service.ts` |
| GitHub Bridge (issues + PRs) | `self-analysis-github-bridge.ts` |
| Skill Evolution Gym | `skill-evolution-gym.ts` |
| Prompt Pattern Registry | `prompt-pattern-registry.ts` |
| A2A Agent Registry | `a2a-agent-registry.ts` |
| Unified World Model | `unified-world-model-service.ts` |
| Domain-Adaptive Curriculum | `domain-adaptive-curriculum-service.ts` |

## Key Differences

1. **Runtime dependency**: Ruflo depends on Claude Code. DjimFlo supports 7 runtimes (OpenCode, Codex, Pi, Claude, Gemini, Editor, Mock).
2. **Orchestration model**: Ruflo uses swarm-based multi-agent coordination. DjimFlo uses policy-gated execution with maker/checker separation, expert swarms, and MARL.
3. **Memory**: Ruflo has HNSW vector memory. DjimFlo has graph-projection memory with episodic, semantic, procedural, and causal stores.
4. **Deployment**: Ruflo is CLI-first. DjimFlo is dashboard/control-plane first with WebSocket real-time updates.
5. **Governance**: DjimFlo has RSI Safety Guard (mutation budget, immutable audit, kill switch). Ruflo relies on Claude Code's built-in permissions.
6. **Self-improvement**: DjimFlo has recursive self-improvement (service refactoring, skill evolution, prompt optimization, contrastive learning, meta-learning, RLHF, GNN). Ruflo has skill distillation.
7. **AI/ML**: DjimFlo integrates contrastive learning, meta-learning (MAML), RLHF (PPO-style), and GNNs. Ruflo has no AI/ML techniques.

## Known Upstream Instability

- Ruflo README commands may not match actual CLI behavior
- Ruflo's positioning has shifted ("codex orchestration CLI" → "multi-agent AI orchestration for Claude Code")
- Plugin ecosystem is in flux

## Recommended Approach

DjimFlo should continue to draw **conceptual inspiration** from Ruflo's orchestration patterns, but should not introduce a runtime dependency. DjimFlo has surpassed Ruflo in most domains. If Ruflo matures and stabilizes, specific patterns (hooks, plugin marketplace) can be evaluated for adoption without coupling to Ruflo's implementation.
