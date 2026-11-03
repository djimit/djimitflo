# Research: Self-Evolving Agentic Systems — Lessons for DjimFlo Level-8+

**Date**: 2026-07-01
**Sources**: 297+ GitHub repos (ruvnet ecosystem), Awesome Self-Evolving Agents survey (XMUDeepLIT), arXiv papers, OpenAI cookbook

---

## 1. Key Open Source Projects

### 1.1 ruvnet/ruflo (59k stars) — "Agent Meta-Harness"
**URL**: https://github.com/ruvnet/ruflo
**Architecture**: `User → CLI/MCP → Router → Swarm → Agents → Memory → LLM Providers`

**Relevant for DjimFlo**:
- **Self-learning loop**: `search → top-k → agent picks useful → recordFeedback() → bandit re-tunes ranking`
- **SONA neural patterns**: Self-optimizing neural architecture that learns from trajectories
- **ReasoningBank**: Compressed reasoning patterns retrieved for similar tasks
- **Plugin marketplace**: 35 plugins, hot-swappable without restart
- **Federation**: Cross-installation agent collaboration with zero-trust (mTLS + ed25519)
- **MetaHarness**: Self-audit system that grades readiness (1-100), scans configs for security

**Key difference from DjimFlo**: Ruflo is model-agnostic (Claude, GPT, Gemini, Ollama). DjimFlo is runtime-agnostic (codex, opencode, claude, pi, gemini). Ruflo uses hooks; DjimFlo uses loop contracts.

**What to adopt**:
- Plugin marketplace architecture (hot-swappable capabilities)
- MetaHarness self-audit (grade our own setup)
- Federation protocol for multi-instance collaboration

### 1.2 ruvnet/agentdb (66 stars) — "Vector Memory That Gets Smarter"
**URL**: https://github.com/ruvnet/agentdb
**Key feature**: Self-learning search with +36% quality from feedback alone

**Architecture**:
```
search → top-k → agent picks useful → recordFeedback()
                                            ↓
                              Thompson Sampling bandit
                                            ↓
                    re-weights ranking · re-picks RL algorithm · re-tunes compression
                                            ↓
                                   next search is sharper
```

**Relevant for DjimFlo**:
- **Thompson Sampling bandit** for ranking/reward — we use Qdrant but don't have feedback loop
- **Cognitive patterns**: episodic replay (Reflexion), skill library, causal reasoning, hierarchical context
- **9 RL algorithms**: Q-Learning, SARSA, DQN, PPO, Actor-Critic, etc. — bandit picks the right one
- **Single-file storage** (.rvf) — vectors + indexes + learning state + audit trail in one file

**What to adopt**:
- Feedback loop on search results (record which memories were actually used)
- Thompson Sampling for capability/runtime selection instead of raw success_rate
- Cognitive memory patterns (episodic, skill library, causal)

### 1.3 ruvnet/Synaptic-Mesh (72 stars) — "Self-Evolving P2P Neural Fabric"
**URL**: https://github.com/ruvnet/Synaptic-Mesh
**Key feature**: Every device is an intelligent node in a distributed brain

**Relevant for DjimFlo**:
- **DAG-based consensus**: QR-Avalanche for Byzantine fault tolerance
- **DAA (Distributed Autonomous Applications)**: Emergent swarm behavior
- **ruv-FANN**: Lightweight neural runtime in WASM
- **Micro-neural networks**: 1K-100K parameters, spawned per task

**What to adopt**:
- DAG-based evidence graph (we have swarm_evidence_edges but no consensus)
- Micro-specialists per finding type (we have specialized capabilities but not micro-models)

### 1.4 ruvnet/RuVector (4.2k stars) — "Self-Learning Vector + GNN Memory DB"
**URL**: https://github.com/ruvnet/RuVector
**Key feature**: GPU-accelerated search with Graph RAG, 103 tools

**What to adopt**:
- Graph RAG for evidence graph traversal
- GNN attention for memory retrieval (+12.4% recall)

---

## 2. Academic Papers — Key Insights

### 2.1 "Truly Self-Improving Agents Require Intrinsic Metacognitive Learning" (arXiv 2506.05109)
**Key insight**: Three metacognitive components needed:
1. **Metacognitive knowledge**: Self-assessment of capabilities, tasks, learning strategies
2. **Metacognitive planning**: Deciding what and how to learn
3. **Metacognitive evaluation**: Reflecting on learning outcomes

**DjimFlo mapping**:
- G35 Self-Model = metacognitive knowledge ✅
- G42 Goal Formation = metacognitive planning ✅
- AgentAssuranceService reflections = metacognitive evaluation ✅
- **Gap**: No explicit metacognitive planning loop that decides WHAT to learn next

### 2.2 "A Survey of Self-Evolving Agents" (arXiv 2507.21046)
**Taxonomy**:
1. **Model-Centric**: Inference-based (parallel sampling, self-correction, structured reasoning) + Training-based (synthesis-driven offline, exploration-driven online)
2. **Environment-Centric**: Static knowledge (RAG, deep research) + Dynamic experience (offline compilation, online adaptation, lifelong evolution, skill augmentation) + Modular architecture (interaction protocols, memory architecture, tool-augmented) + Agentic topology (offline architecture search, runtime dynamic adaptation)
3. **Model-Environment Co-Evolution**: Multi-agent policy co-evolution + Environment training

**DjimFlo coverage**:
- Model-Centric: Partial (G28 competence tracking, G35 calibration)
- Environment-Centric: Good (G36 experience retrieval, G40 skill distillation, G41 curiosity)
- Co-Evolution: Missing (no multi-agent RL, no environment training)

### 2.3 "Adaptive Orchestration: Scalable Self-Evolving Multi-Agent Systems" (arXiv 2601.09742)
**Key insight**: Orchestration layer must itself evolve — not just agent capabilities

**DjimFlo mapping**: Our MetaEvolutionService evaluates but doesn't modify the orchestration logic itself. Level-8 should add orchestration self-modification.

### 2.4 "AutoAgent: Evolving Cognition and Elastic Memory Orchestration" (arXiv 2603.09716)
**Key insight**: Cognition and memory must co-evolve — elastic memory that grows/shrinks based on cognitive load

### 2.5 "Competence-Aware AI Agents with Metacognition" (MUSE, arXiv 2411.13537)
**Key insight**: Agents must continually assess their own competence in unknown situations

**DjimFlo mapping**: G35 Self-Model does this but only for known capabilities. Missing: competence assessment for NOVEL situations.

### 2.6 "Self-Evolving Multi-Agent Collaboration Network" (ICLR 2025)
**Key insight**: Analyze each agent's influence on environmental feedback to update agent policies

**DjimFlo mapping**: Our ClaimLedger tracks claims but doesn't attribute influence per agent.

---

## 3. Key Techniques to Adopt for Level-8

### 3.1 Thompson Sampling Bandit for Runtime Selection
**Source**: AgentDB
**Current**: We use raw success_rate × recommendedConfidence
**Improvement**: Thompson Sampling explores/exploits optimally, handles uncertainty better

### 3.2 Cognitive Memory Patterns
**Source**: AgentDB (6 patterns)
**Current**: We have episodic/procedural/semantic/working stores
**Add**:
- **Skill Library**: Reusable procedures indexed by intent
- **Causal Reasoning**: Why did X cause Y?
- **Hierarchical Context**: Working/short/long-term tiers

### 3.3 Feedback Loop on Search
**Source**: AgentDB
**Current**: Qdrant search returns results but we don't track which were useful
**Add**: `recordFeedback(resultId, reward)` → re-weights future retrieval

### 3.4 GOAP A* Planning
**Source**: Ruflo (goal.ruv.io)
**Current**: Our planner matches findings to capabilities
**Improvement**: Full GOAP (Goal-Oriented Action Planning) with A* search through state space, preconditions/effects, adaptive replanning

### 3.5 DAG-Based Consensus
**Source**: Synaptic-Mesh (QuDAG)
**Current**: Our evidence graph has edges but no consensus mechanism
**Add**: QR-Avalanche consensus for Byzantine fault tolerance in multi-agent claims

### 3.6 Federation Protocol
**Source**: Ruflo
**Current**: Single-instance only
**Add**: Cross-instance collaboration with zero-trust (mTLS + ed25519), PII stripping, behavioral trust scoring

### 3.7 MetaHarness Self-Audit
**Source**: Ruflo
**Current**: MetaEvolutionService evaluates planner accuracy
**Add**: Full readiness grading (1-100), security scanning, regression detection, config validation

### 3.8 Plugin Marketplace
**Source**: Ruflo
**Current**: Capabilities are DB records
**Add**: Hot-swappable plugin architecture, versioned releases, signed witness chain

---

## 4. What DjimFlo Already Does Better

| Capability | DjimFlo | Ruflo | AgentDB |
|-----------|---------|-------|---------|
| Worktree isolation | ✅ Full git worktree | ❌ | ❌ |
| Maker/Checker separation | ✅ Independent roles | ❌ | ❌ |
| Dollar economy | ✅ Per-capability cost | ❌ | ❌ |
| Epistemic gates | ✅ 4 gate types | ❌ | ❌ |
| Nested spawning | ✅ Depth/budget/cycle guards | ❌ | ❌ |
| Claim ledger with contradicties | ✅ Full graph | ❌ | ❌ |
| OKF knowledge sync | ✅ Bidirectional | ❌ | ❌ |
| Runtime-agnostic | ✅ 6+ runtimes | Model-agnostic | N/A |
| Calibration | ✅ Platt scaling | ❌ | ❌ |

---

## 5. Recommended Next Steps for Level-8

### Priority 1 (Directly from research):
1. **Thompson Sampling bandit** — replace raw success_rate selection
2. **Feedback loop on search** — record which Qdrant results were actually used
3. **GOAP A* planner** — full goal-oriented action planning
4. **Metacognitive planning loop** — decide WHAT to learn next, not just HOW

### Priority 2 (Architecture evolution):
5. **DAG-based consensus** — Byzantine fault tolerance for claims
6. **Federation protocol** — multi-instance collaboration
7. **Plugin marketplace** — hot-swappable capabilities
8. **MetaHarness self-audit** — readiness grading + security scanning

### Priority 3 (Long-term AGI):
9. **Multi-agent RL** — co-evolving agent policies
10. **Environment training** — adaptive curriculum
11. **Micro-neural specialists** — per-finding-type micro-models
12. **WASM sandbox** — portable agent execution

---

## 6. Key URLs for Further Research

- Awesome Self-Evolving Agents: https://github.com/XMUDeepLIT/Awesome-Self-Evolving-Agents
- Ruflo: https://github.com/ruvnet/ruflo
- AgentDB: https://github.com/ruvnet/agentdb
- Synaptic-Mesh: https://github.com/ruvnet/Synaptic-Mesh
- RuVector: https://github.com/ruvnet/RuVector
- Self-Evolving Agents Survey: https://arxiv.org/abs/2507.21046
- Metacognitive Learning: https://arxiv.org/abs/2506.05109
- Adaptive Orchestration: https://arxiv.org/abs/2601.09742
- AutoAgent (Evolving Cognition): https://arxiv.org/abs/2603.09716
- MUSE (Competence-Aware): https://arxiv.org/abs/2411.13537
- OpenAI Self-Evolving Cookbook: https://developers.openai.com/cookbook/examples/partners/self_evolving_agents/autonomous_agent_retraining
