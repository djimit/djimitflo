# Design

1. Judge fails closed when every answer lacks evidence.
2. ExpertSwarm retries only failed domains, once, with unused configured sources.
3. ExpertSwarm reuses `AgentAssuranceService` for parent/child execution spans.
4. SelfHealing distinguishes `recommended` from successful mutations and stores each action once.
5. Meta tuning is counted as applied only through the runtime-consumer method used by loop assignment.
6. `AgentRetirementService` remains the single agent retirement implementation; the unreachable duplicate lifecycle service is removed.
7. The self-benchmark executes and verifies real service behavior against an isolated database.
