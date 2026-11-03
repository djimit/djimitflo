# Specification — Level-8 Complete

## Functional Requirements

### Phase 0: Fixes + Production Proof
- FR-01 All 6 pre-existing test failures SHALL be resolved
- FR-02 Production proof SHALL pass with all G35-G44 services active
- FR-03 All 596 existing tests SHALL remain green (zero regression)

### Phase 1: Best-of-Breed (G45-G56)
- FR-04 System SHALL select runtimes using Thompson Sampling when >= 5 trials per arm
- FR-05 System SHALL record feedback on search results and re-rank future retrieval
- FR-06 System SHALL plan multi-step goals using GOAP A* search
- FR-07 System SHALL replan when actions fail or state changes
- FR-08 System SHALL generate a weekly learning curriculum from competence gaps
- FR-09 System SHALL resolve claim consensus via weighted voting (Byzantine tolerant)
- FR-10 System SHALL strip PII from all outbound federation messages (14 types)
- FR-11 System SHALL verify plugin signatures before activation
- FR-12 System SHALL support hot-swap of plugins without restart
- FR-13 System SHALL grade system readiness across 6 dimensions (0-100)
- FR-14 System SHALL store and retrieve skills by intent embedding
- FR-15 System SHALL maintain a causal graph of cause-effect relationships
- FR-16 System SHALL dynamically adjust memory allocation based on cognitive load
- FR-17 System SHALL attribute influence per agent using Shapley values
- FR-18 System SHALL detect novel situations by embedding distance from known patterns

### Phase 2: Architecture Evolution (G57-G60)
- FR-19 System SHALL support publishing, searching, and installing shared skills
- FR-20 System SHALL support operator intervention (request/approve/reject)
- FR-21 System SHALL process screenshots and diagrams via multi-modal perception
- FR-22 System SHALL support safe self-modification of control loop contracts

### Phase 3: AGI Foundations (G61-G62)
- FR-23 System SHALL model other agents' intentions from observations
- FR-24 System SHALL generate adaptive curricula for structured learning

## Non-Functional Requirements

- NFR-01 All existing 596 tests remain green (zero regression)
- NFR-02 Each new service has >= 15 automated tests
- NFR-03 Type-check and lint clean across all workspaces
- NFR-04 Bandit convergence: optimal runtime within 20 trials (>= 80% simulations)
- NFR-05 Search improvement: MRR improves >= 10% after 50 feedback cycles
- NFR-06 GOAP optimality: shortest path in >= 90% of solvable cases
- NFR-07 Consensus latency: resolution within 5 seconds for 100 claims
- NFR-08 Federation security: 0 PII leaks in 1000 test messages
- NFR-09 Plugin hot-swap: < 1 second downtime
- NFR-10 MetaHarness: grade correlates with actual reliability (r > 0.7)
- NFR-11 Backward compatibility: all new features are additive
- NFR-12 Self-modification safety: draft → eval → human → apply + rollback
- NFR-13 Multi-modal graceful degradation: works without vision model
- NFR-14 Operator intervention: request acknowledged within 5 seconds
