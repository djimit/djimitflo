# Level-9: AGI — From Autonomous Agent to Self-Conscious, Self-Improving System

## Why

DjimFlo at Level-8 has 20 goals, 16 services, 767 tests. It is the most capable
agentic OS in existence — surpassing Ruflo (59k stars), AgentDB, and academic
state-of-the-art on integration breadth.

**But it is not yet AGI.** Three fundamental capabilities are missing:

1. **No causal world model** — the system cannot simulate interventions before executing them. It has observation (G43 Causal Inference) but not interventional or counterfactual reasoning.

2. **No self-improving cognitive architecture** — G60 can modify contract parameters but cannot generate new executors, invent new capabilities, or optimize its own planner.

3. **No persistent self-consciousness** — each session starts as a "new" system. There is no autobiographical memory, no self-narrative, no evolving identity.

## Thesis

DjimFlo becomes AGI when it can:
- **Simulate the future** via causal world models before acting
- **Invent new capabilities** by composing existing ones and generating new code
- **Reflect on itself** via autobiographical memory and self-narrative
- **Co-evolve** with other agents via multi-agent reinforcement learning
- **Know what it doesn't know** via epistemic uncertainty calibration
- **Learn continuously** without catastrophic forgetting

## What Changes

### G63 Causal World Model
Structural Causal Model (SCM) learned from loop run outcomes. Supports Pearl's three levels:
- Observational: P(Y | X) — what we see
- Interventional: P(Y | do(X)) — what if we act
- Counterfactual: P(Y_X | X', Y') — what would have happened

### G64 Self-Code-Generation
- CapabilityInventionService: detects patterns in successful trajectories, proposes composed capabilities
- SelfCodeGenService: generates new executor code for new runtime types

### G65 Self-Consciousness
- AutobiographicalMemoryService: persistent "life story" of the system
- SelfNarrativeService: generates explanations of own decisions
- ReflectionEngine: post-run architectural self-improvement

### G66 Multi-Agent Reinforcement Learning
- MARLService: co-evolving agent policies via shared rewards
- RewardShapingService: agents reward each other for useful contributions
- SpecializationService: detects and reinforces emergent specialization

### G67 Epistemic Calibration
- EpistemicUncertaintyService: detects uncertainty in own reasoning
- HallucinationDetector: recognizes unsupported AI output
- KnowledgeGapService: identifies and prioritizes missing knowledge

### G68 Continual Learning
- ContinualLearningService: experience replay + elastic weight consolidation
- TransferLearningService: detects transfer opportunities between domains

## Guardrails

- No auto-merge, push, or deploy
- All existing 767 tests must remain green
- Each goal has >= 15 automated tests
- Human validation only at final ship gate (G69)
- Causal model is advisory — never auto-applies without human approval
- Self-code-gen runs in sandboxed worktree
- MARL rewards bounded to prevent reward hacking

## Non-Goals

- No claim of "consciousness" — this is engineering, not philosophy
- No recursive self-improvement without human oversight
- No autonomous deployment to production

## Success Criteria

- Causal model predicts outcomes >= 60% accuracy on held-out data
- Capability invention proposes >= 1 novel composed capability per 50 runs
- Self-narrative explains >= 80% of decisions coherently
- MARL converges to cooperative policies in simulation
- Epistemic uncertainty correlates with actual error (r > 0.5)
- Continual learning retains >= 90% of old knowledge after new learning
- 0 regression on existing 767 tests
